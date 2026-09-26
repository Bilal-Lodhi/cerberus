/**
 * Verify that every relative markdown link and in-repo heading anchor resolves.
 *
 * Kept as a real script rather than an inline one-liner because an inline version was
 * mangled by shell escaping twice and produced four *false* broken-anchor reports. A
 * checker that lies is worse than no checker.
 *
 * Runs in CI: `node scripts/check-docs.mjs`.
 */

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const root = process.cwd();

/**
 * Every tracked markdown file.
 *
 * `git ls-files` is called with no pathspec and the filter happens here, because a quoted
 * pathspec does not survive every shell: `git ls-files '*.md'` on Windows receives the
 * quotes literally and matches nothing, which would make this checker silently pass over an
 * empty set — the exact failure mode it exists to prevent. The count is printed for the
 * same reason.
 */
const files = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.endsWith(".md"));

if (files.length === 0) {
  console.error("check-docs: no tracked markdown files found — refusing to pass vacuously");
  process.exit(1);
}

/**
 * GitHub's heading slug: lowercase, drop punctuation except hyphens and underscores, and
 * turn each whitespace character into a hyphen — *not* collapsing runs, because
 * `## Security & privacy` becomes `security--privacy`.
 *
 * Lines are split on `/\r?\n/` rather than `"\n"` on purpose. A line ending in a bare `\r`
 * makes `/^(#{1,6})\s+(.*)$/` fail to match, because `.` does not match a line terminator —
 * so the scan silently finds **no headings** and every anchor looks broken. That is not
 * hypothetical: editing a file with a tool that writes CRLF produced exactly this, and four
 * anchors were reported broken that were fine.
 */
function slugs(text) {
  const found = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!match) continue;
    found.add(
      match[2]
        .toLowerCase()
        .replace(/[`*[\]()]/g, "")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s/g, "-"),
    );
  }
  return found;
}

const cache = new Map();
function read(path) {
  if (!cache.has(path)) {
    cache.set(path, existsSync(path) ? readFileSync(path, "utf8") : null);
  }
  return cache.get(path);
}

let links = 0;
let anchors = 0;
let broken = 0;

for (const file of files) {
  const text = read(resolve(root, file));
  if (text === null) continue;
  const directory = dirname(resolve(root, file));

  for (const match of text.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const target = match[2];
    if (/^(https?:|mailto:)/.test(target)) continue;
    links++;

    const [pathPart, anchor] = target.split("#");
    const resolved = pathPart ? resolve(directory, pathPart) : resolve(root, file);

    if (pathPart && !existsSync(resolved)) {
      console.log(`BROKEN FILE   ${file} -> ${target}`);
      broken++;
      continue;
    }

    if (anchor) {
      anchors++;
      const targetText = read(resolved);
      if (targetText !== null && !slugs(targetText).has(anchor)) {
        console.log(`BROKEN ANCHOR ${file} -> ${target}`);
        broken++;
      }
    }
  }
}

console.log(
  `${files.length} markdown files, ${links} file links, ${anchors} anchors, ` +
    `${broken} broken`,
);

process.exit(broken > 0 ? 1 : 0);

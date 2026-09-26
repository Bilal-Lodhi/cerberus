/**
 * Turn a documentation file into a GitHub Release body.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 *
 * A release body is rendered on the repository's **Releases** page, where a relative link
 * resolves against the release page rather than against the file it was written in. The
 * `v0.4.0` release notes live at `docs/release/`, and its links are written relative to
 * that directory — `../compatibility.md`, `v0.4.0-checklist.md` — so published verbatim
 * they would resolve to nothing.
 *
 * This rewrites every relative link to an absolute `blob` URL on the repository, keeping
 * any `#anchor`, and leaves absolute URLs, `mailto:` links and code spans alone.
 *
 * The documentation file keeps its relative links: they are correct *there*, and
 * `npm run check:docs` verifies them in that context. Only the body is transformed, which
 * is why this is a step rather than a second copy of the notes.
 *
 * Usage:
 *   node scripts/release/release-body.mjs docs/release/v0.4.0-release-notes.md
 *   node scripts/release/release-body.mjs <file> --out <path>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

/** The repository the links point at. Kept here rather than read from `git remote` so the
 *  output is deterministic, and asserted against the remote by the caller. */
const REPOSITORY = "https://github.com/Bilal-Lodhi/cerberus";
const BRANCH = "main";

const [source, ...rest] = process.argv.slice(2);
if (!source) {
  console.error("usage: node scripts/release/release-body.mjs <file> [--out <path>]");
  process.exit(2);
}

const outIndex = rest.indexOf("--out");
const outPath = outIndex === -1 ? null : rest[outIndex + 1];

const absoluteSource = resolve(root, source);
const sourceDirectory = dirname(absoluteSource);
const text = readFileSync(absoluteSource, "utf8");

let rewritten = 0;
const targets = new Set();

const body = text.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (match, label, target) => {
  // Absolute URLs, anchors and mailto are already release-context-safe.
  if (/^(https?:|mailto:|#)/.test(target)) return match;

  const [pathPart, anchor] = target.split("#");
  if (!pathPart) return match;

  // Resolve against the file's own directory, then express it from the repository root —
  // which is what a `blob` URL needs.
  const resolved = relative(root, resolve(sourceDirectory, pathPart)).replace(/\\/g, "/");
  const url = `${REPOSITORY}/blob/${BRANCH}/${resolved}${anchor ? `#${anchor}` : ""}`;

  rewritten += 1;
  targets.add(url);
  return `[${label}](${url})`;
});

if (outPath) {
  writeFileSync(resolve(root, outPath), body);
  console.log(`release body: ${rewritten} relative link(s) rewritten`);
  for (const url of targets) console.log(`  ${url}`);
  console.log(`  written to ${outPath}`);
} else {
  process.stdout.write(body);
}

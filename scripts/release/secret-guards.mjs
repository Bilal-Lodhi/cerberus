/**
 * Secret and hygiene guards.
 *
 * The same deterministic checks CI runs, in one place a release harness can call, plus the
 * one guard that only makes sense here: **the release harness must never publish**.
 *
 * ── Why the publish guard exists ──────────────────────────────────────
 *
 * `docs/release/*` and this directory are the only things an operator runs at release
 * time, and a verification script that can publish is a verification script that will
 * eventually publish by accident. `npm publish`, `git push`, `docker push` and
 * `gh release create` are therefore rejected in this directory by pattern, so the harness
 * cannot grow a publishing step without the guard failing first.
 *
 * ── What this does not do ─────────────────────────────────────────────
 *
 * It does not scan history for high-entropy secrets: TruffleHog does that in CI, with
 * `--only-verified`, and a second weaker scanner here would only add noise. This is the
 * cheap, deterministic half.
 *
 * Usage:
 *   node scripts/release/secret-guards.mjs
 *   node scripts/release/secret-guards.mjs --json
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

/** Every tracked path. */
function trackedFiles() {
  return git(["ls-files"])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const problems = [];
const notes = [];

// ── 1. No tracked credential-shaped file ─────────────────────────────

const CREDENTIAL_SHAPED = [".env", "application_default_credentials.json", "*.pem", "*.key"];

for (const pattern of CREDENTIAL_SHAPED) {
  const matched = git(["ls-files", "--", pattern])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.endsWith(".env.example"));

  for (const file of matched) {
    problems.push({
      guard: "credential-shaped file is tracked",
      detail: file,
      fix: "remove it from the index and rotate whatever it held",
    });
  }
}

// ── 2. `.env` is ignored ─────────────────────────────────────────────

const gitignore = readFileSync(resolve(root, ".gitignore"), "utf8");
if (!/^\.env$/m.test(gitignore) && !/^\.env\b/m.test(gitignore)) {
  problems.push({
    guard: ".env is not ignored",
    detail: ".gitignore",
    fix: "a local `.env` holds real credentials; it must be ignored",
  });
}

// ── 3. No retired deployment identity in shippable source ────────────

/**
 * Retired deployment and product identifiers.
 *
 * They are legitimate in the migration documentation, in the negative tests that assert
 * they are gone, and in the CI workflow that necessarily contains the pattern. Those
 * locations are excluded rather than deleted: the migration history is documentation, not
 * leakage.
 */
const RETIRED_IDENTITY = "webscraping-464710|gorilla_agents|gorilla-mcp-mongodb";

let grepOutput = "";
try {
  grepOutput = git([
    "grep",
    "-n",
    "-I",
    "-E",
    RETIRED_IDENTITY,
    "--",
    ".",
    ":(exclude).github/**",
    ":(exclude)docs/**",
    ":(exclude)**/test/**",
    ":(exclude)**/tests/**",
    ":(exclude)scripts/release/**",
  ]);
} catch (error) {
  // `git grep` exits 1 when nothing matches, which is the success case here.
  const status = error && typeof error === "object" ? error.status : undefined;
  if (status !== 1) throw error;
}

if (grepOutput.trim().length > 0) {
  problems.push({
    guard: "a retired deployment identifier is present in source or configuration",
    detail: grepOutput.trim().split("\n").slice(0, 10).join("\n         "),
    fix: "remove it, or add the legitimate location to the exclusions with a reason",
  });
}

// ── 4. The release harness cannot publish ────────────────────────────

const PUBLISH_COMMANDS = [
  { pattern: /\bnpm\s+publish\b/, what: "npm publish" },
  { pattern: /\bgit\s+push\b/, what: "git push" },
  { pattern: /\bdocker\s+push\b/, what: "docker push" },
  { pattern: /\bgh\s+release\s+create\b/, what: "gh release create" },
];

for (const file of trackedFiles().filter((path) => path.startsWith("scripts/release/"))) {
  const text = readFileSync(resolve(root, file), "utf8");
  for (const { pattern, what } of PUBLISH_COMMANDS) {
    if (pattern.test(text)) {
      problems.push({
        guard: "the release harness contains a publishing command",
        detail: `${file} matches ${what}`,
        fix: "the harness verifies and never publishes; move the command out of this directory",
      });
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────

const asJson = process.argv.includes("--json");

if (asJson) {
  console.log(JSON.stringify({ problems, notes, trackedFiles: trackedFiles().length }, null, 2));
  process.exit(problems.length === 0 ? 0 : 1);
}

console.log(`secret guards — ${trackedFiles().length} tracked file(s)\n`);

if (problems.length === 0) {
  console.log("  ok   no tracked credential-shaped file");
  console.log("  ok   .env is ignored");
  console.log("  ok   no retired deployment identifier in source or configuration");
  console.log("  ok   the release harness contains no publishing command");
  console.log("\nOK: 4 guards passed.");
  process.exit(0);
}

for (const problem of problems) {
  console.log(`  FAIL ${problem.guard}`);
  console.log(`       ${problem.detail}`);
  console.log(`       fix: ${problem.fix}`);
}
console.log(`\nFAILED: ${problems.length} guard(s).`);
process.exit(1);

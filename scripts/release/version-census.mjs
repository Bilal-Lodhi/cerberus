/**
 * Version census.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 *
 * The product version is written in six places, and nothing asserted that they agreed. The
 * `v0.3.0` verification found the consequence of that the hard way: it ran against a stale
 * container image, because the image carried a version nobody had compared against the
 * source it was supposed to be built from. A release whose parts disagree about which
 * release they are is not verifiable.
 *
 * So every declaration is read and compared against `package.json`, which is the
 * authority. A mismatch is a failure with both values and both file paths printed.
 *
 * ── What it does not do ───────────────────────────────────────────────
 *
 * It does not read a running process. Comparing the source's version against a deployed
 * runtime's version is the stale-image defence, and it needs a running container —
 * `scripts/release/verify-image.mjs`. This is the static half: the sources agree.
 *
 * Usage:
 *   node scripts/release/version-census.mjs
 *   node scripts/release/version-census.mjs --json
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

/**
 * The version `package.json` declares. The authority: every other declaration is compared
 * against it rather than the other way round.
 */
const authority = readJson("package.json").version;

/** Every place a version is declared, and how to read it out. */
const declarations = [
  {
    what: "root package.json",
    path: "package.json",
    read: () => readJson("package.json").version,
  },
  {
    what: "API package",
    path: "apps/api/package.json",
    read: () => readJson("apps/api/package.json").version,
  },
  {
    what: "MCP package",
    path: "packages/mcp-mongodb/package.json",
    read: () => readJson("packages/mcp-mongodb/package.json").version,
  },
  {
    what: "API service version, reported by GET /health",
    path: "apps/api/src/routes/health.ts",
    read: () => {
      const match = /SERVICE_VERSION\s*=\s*"([^"]+)"/.exec(read("apps/api/src/routes/health.ts"));
      return match ? match[1] : "<not found>";
    },
  },
  {
    what: "MCP server identity, reported to MCP clients",
    path: "packages/mcp-mongodb/src/tool-names.ts",
    read: () => {
      const match = /MCP_SERVER_VERSION\s*=\s*"([^"]+)"/.exec(
        read("packages/mcp-mongodb/src/tool-names.ts"),
      );
      return match ? match[1] : "<not found>";
    },
  },
  {
    what: "Flutter console (base version; the `+N` build number is not the product version)",
    path: "apps/console/pubspec.yaml",
    read: () => {
      const match = /^version:\s*([0-9]+\.[0-9]+\.[0-9]+)(?:\+\d+)?\s*$/m.exec(
        read("apps/console/pubspec.yaml"),
      );
      return match ? match[1] : "<not found>";
    },
  },
];

/** Additional invariants that are not a version comparison. */
function checkInvariants() {
  const problems = [];

  // The CHANGELOG must have somewhere for unreleased work to land. A version bump that
  // forgets it means the next reader cannot tell what changed.
  const changelog = read("CHANGELOG.md");
  if (!/^## \[Unreleased\]/m.test(changelog)) {
    problems.push({
      what: "CHANGELOG.md has no `## [Unreleased]` section",
      path: "CHANGELOG.md",
      detail: "every change must have somewhere to be recorded before a release",
    });
  }

  // A published version must have a changelog section, so the two cannot drift apart.
  if (!new RegExp(`^## \\[${authority.replace(/\./g, "\\.")}\\]`, "m").test(changelog)) {
    problems.push({
      what: `CHANGELOG.md has no section for the declared version ${authority}`,
      path: "CHANGELOG.md",
      detail:
        "a version with no recorded changes is a version nobody can review; add the " +
        "section when the release is prepared, not when it is published",
    });
  }

  return problems;
}

const asJson = process.argv.includes("--json");

const results = declarations.map((declaration) => {
  let value;
  try {
    value = declaration.read();
  } catch (error) {
    value = `<unreadable: ${error instanceof Error ? error.message : String(error)}>`;
  }
  return {
    what: declaration.what,
    path: declaration.path,
    value,
    matches: value === authority,
  };
});

const mismatches = results.filter((result) => !result.matches);
const invariantProblems = checkInvariants();

if (asJson) {
  console.log(
    JSON.stringify({ authority, results, mismatches, invariantProblems }, null, 2),
  );
  process.exit(mismatches.length === 0 && invariantProblems.length === 0 ? 0 : 1);
}

console.log(`version census — authority is package.json: ${authority}\n`);
for (const result of results) {
  const mark = result.matches ? "ok  " : "FAIL";
  console.log(`  ${mark} ${result.value.padEnd(12)} ${result.what}`);
  console.log(`       ${result.path}`);
}

if (mismatches.length > 0) {
  console.log(`\n${mismatches.length} declaration(s) disagree with package.json:`);
  for (const mismatch of mismatches) {
    console.log(`  ${mismatch.path}: ${mismatch.value} (expected ${authority})`);
  }
}

if (invariantProblems.length > 0) {
  console.log(`\n${invariantProblems.length} changelog invariant(s) failed:`);
  for (const problem of invariantProblems) {
    console.log(`  ${problem.path}: ${problem.what}`);
    console.log(`       ${problem.detail}`);
  }
}

const failed = mismatches.length + invariantProblems.length;
console.log(
  failed === 0
    ? `\nOK: ${results.length} version declarations agree, and the changelog has both sections.`
    : `\nFAILED: ${failed} problem(s).`,
);

process.exit(failed === 0 ? 0 : 1);

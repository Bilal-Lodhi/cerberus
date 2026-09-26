/**
 * Configuration census.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 *
 * An environment variable that the code reads but the documentation does not describe is
 * a knob nobody can find. One that the documentation describes but the code no longer
 * reads is worse: an operator sets it, restarts, and nothing changes — and there is no
 * error, because a variable nothing reads cannot be wrong.
 *
 * Both directions were real. This repository has previously shipped a documented variable
 * that had been renamed, and read a variable whose name appeared in no table.
 *
 * ── How it reads the two sides ────────────────────────────────────────
 *
 *   READ        every `readEnv("X")`, `readInt("X", …)`, `readBoolStrict("X", …)`,
 *               `readEnum("X", …)`, `readPositiveInt`, `readRatio`, `readFloat` call and
 *               every `process.env["X"]` / `process.env.X` in the scanned trees.
 *   DOCUMENTED  every backticked, upper-case identifier in `docs/configuration.md` and in
 *               `.env.example`.
 *
 * Undocumented is a **failure**: a knob must be described where the others are.
 * Documented-but-unread is also a failure, unless the name is in
 * {@link READ_ELSEWHERE} — a list that has to be justified in this file rather than
 * silently ignored.
 *
 * Usage:
 *   node scripts/release/config-census.mjs
 *   node scripts/release/config-census.mjs --json
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

/**
 * Directories whose TypeScript/JavaScript is scanned for environment reads.
 *
 * `scripts/release` is excluded on purpose: the harness reads no product configuration,
 * and this file *contains* the patterns it looks for as text, so scanning itself would
 * report its own documentation as a variable.
 */
const SCANNED_DIRECTORIES = ["apps/api/src", "packages/mcp-mongodb/src", "scripts"];
const SKIPPED_DIRECTORIES = ["node_modules", "dist", "build", "release"];

/**
 * Variables that are legitimately read outside the scanned trees.
 *
 * Each entry is a claim, and the claim is what keeps this list from becoming a place to
 * hide drift. A name here is *not* read by the API, the MCP adapter or the scripts, and
 * that is deliberate.
 */
const READ_ELSEWHERE = new Map([
  [
    "API_BASE_URL",
    "read by the Flutter console at build time (--dart-define), which is Dart and not scanned",
  ],
  [
    "FIREBASE_API_KEY",
    "read by the Flutter console at build time; listed in configuration.md §8 as not owned by Cerberus",
  ],
  [
    "FIREBASE_APP_ID",
    "read by the Flutter console at build time",
  ],
  [
    "FIREBASE_MESSAGING_SENDER_ID",
    "read by the Flutter console at build time",
  ],
  [
    "FIREBASE_PROJECT_ID",
    "read by the Flutter console at build time",
  ],
  [
    "CERBERUS_TEST_MONGODB_URI",
    "read by the test suite, not by the product; documented as a test-only variable",
  ],
]);

/** Every file under `directory` whose name ends in one of `extensions`. */
function walk(directory, extensions) {
  const absolute = join(root, directory);
  const found = [];

  let entries;
  try {
    entries = readdirSync(absolute);
  } catch {
    return found;
  }

  for (const entry of entries) {
    const path = join(absolute, entry);
    if (statSync(path).isDirectory()) {
      if (SKIPPED_DIRECTORIES.includes(entry)) continue;
      found.push(...walk(relative(root, path).replace(/\\/g, "/"), extensions));
      continue;
    }
    if (extensions.some((extension) => entry.endsWith(extension))) {
      found.push(relative(root, path).replace(/\\/g, "/"));
    }
  }

  return found;
}

/**
 * The names an environment read can use.
 *
 * The helper names matter: `readEnv`, `readInt`, `readBool`, `readBoolStrict`,
 * `readPositiveInt`, `readFloat`, `readRatio` and `readEnum` all take the variable name as
 * their first argument. Listing them here rather than matching any call with a string
 * literal keeps a `logger.info("SOMETHING")` from being read as a configuration knob.
 */
const READ_HELPERS = [
  "readEnv",
  "readInt",
  "readBool",
  "readBoolStrict",
  "readPositiveInt",
  "readFloat",
  "readRatio",
  "readEnum",
];

/** Every environment variable name the scanned code reads, with where it was seen. */
function readVariables() {
  const seen = new Map();

  const helperPattern = new RegExp(`\\b(${READ_HELPERS.join("|")})\\(\\s*"([A-Z][A-Z0-9_]*)"`, "g");
  const bracketPattern = /process\.env\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/g;
  const dotPattern = /process\.env\.([A-Z][A-Z0-9_]*)\b/g;

  for (const file of SCANNED_DIRECTORIES.flatMap((directory) =>
    walk(directory, [".ts", ".js", ".mjs"]),
  )) {
    const text = readFileSync(join(root, file), "utf8");
    for (const pattern of [helperPattern, bracketPattern, dotPattern]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        // The helper pattern has the name in group 2; the others in group 1.
        const name = match[2] ?? match[1];
        if (!seen.has(name)) seen.set(name, new Set());
        seen.get(name).add(file);
      }
    }
  }

  return seen;
}

/**
 * Every variable the two documents describe.
 *
 * The extraction is deliberately narrow. An earlier version took any backticked
 * upper-case token, which read HTTP methods and error codes out of the prose —
 * `GET`, `POST`, `PAYLOAD_TOO_LARGE` — as configuration knobs. A census that cries wolf is
 * a census that gets ignored, so it reads only:
 *
 *   - the first cell of a table row in `docs/configuration.md`, which is where the
 *     variable tables put the name;
 *   - an assignment in `.env.example`, commented out or not.
 */
function documentedVariables() {
  const seen = new Map();

  const configurationTableRow = /^\|\s*`([A-Z][A-Z0-9_]{2,})`\s*\|/gm;
  const dotenvAssignment = /^#?\s*([A-Z][A-Z0-9_]{2,})=/gm;

  const sources = [
    { file: "docs/configuration.md", patterns: [configurationTableRow] },
    { file: ".env.example", patterns: [dotenvAssignment] },
  ];

  for (const { file, patterns } of sources) {
    const text = readFileSync(join(root, file), "utf8");
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const name = match[1];
        if (!seen.has(name)) seen.set(name, new Set());
        seen.get(name).add(file);
      }
    }
  }

  return seen;
}

const read = readVariables();
const documented = documentedVariables();

/** Read but never described. A knob nobody can find. */
const undocumented = [...read.keys()].filter((name) => !documented.has(name)).sort();

/** Described but never read, and not justified as read elsewhere. */
const unread = [...documented.keys()]
  .filter((name) => !read.has(name) && !READ_ELSEWHERE.has(name))
  .sort();

/** Names in the allow-list that are now read by the scanned code, so the entry is stale. */
const staleAllowList = [...READ_ELSEWHERE.keys()].filter((name) => read.has(name)).sort();

const asJson = process.argv.includes("--json");

if (asJson) {
  console.log(
    JSON.stringify(
      {
        read: [...read.keys()].sort(),
        documented: [...documented.keys()].sort(),
        undocumented,
        unread,
        staleAllowList,
      },
      null,
      2,
    ),
  );
  process.exit(undocumented.length === 0 && unread.length === 0 && staleAllowList.length === 0 ? 0 : 1);
}

console.log(
  `config census — ${read.size} variable(s) read, ${documented.size} described\n`,
);

if (undocumented.length > 0) {
  console.log(`${undocumented.length} variable(s) read by the code but described nowhere:`);
  for (const name of undocumented) {
    console.log(`  ${name}`);
    for (const file of read.get(name)) console.log(`       read in ${file}`);
  }
  console.log(
    "\n  Add each to docs/configuration.md and .env.example. A knob an operator cannot\n" +
      "  find is a knob that will be set wrongly.\n",
  );
}

if (unread.length > 0) {
  console.log(`${unread.length} variable(s) described but read by nothing scanned:`);
  for (const name of unread) {
    console.log(`  ${name}`);
    for (const file of documented.get(name)) console.log(`       described in ${file}`);
  }
  console.log(
    "\n  Either the code stopped reading it — in which case remove the documentation, and\n" +
      "  an operator setting it would see nothing happen — or it is read outside the\n" +
      "  scanned trees, in which case add it to READ_ELSEWHERE in this script with the\n" +
      "  reason.\n",
  );
}

if (staleAllowList.length > 0) {
  console.log(`${staleAllowList.length} allow-list entry(ies) are no longer needed:`);
  for (const name of staleAllowList) {
    console.log(`  ${name} — now read by the scanned code, so the exemption is stale`);
  }
  console.log("");
}

const failed = undocumented.length + unread.length + staleAllowList.length;
console.log(
  failed === 0
    ? `OK: every read variable is described, and every described variable is read.`
    : `FAILED: ${failed} problem(s).`,
);

process.exit(failed === 0 ? 0 : 1);

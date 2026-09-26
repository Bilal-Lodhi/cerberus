/**
 * The release verification harness.
 *
 * ── What this is ──────────────────────────────────────────────────────
 *
 * One non-publishing entry point that runs every release-critical check, in order, and
 * reports each one's outcome. `v0.3.0`'s verification was a session: a sequence of
 * commands run by hand, with the results written into a checklist. Two of the gates were
 * re-run rather than repeated, and one of them — the container build — was verified
 * against a **stale image**, because nothing compared the image's version against the
 * source it was supposed to come from.
 *
 * A gate that lives in a session is not a gate. This is the same set of checks, in one
 * command, so it can be run again by anyone, and so a failure is a failure of the harness
 * rather than of someone's memory.
 *
 * ── It never publishes ────────────────────────────────────────────────
 *
 * No step in this directory may contain `npm publish`, `git push`, `docker push` or
 * `gh release create`; `scripts/release/secret-guards.mjs` fails if one appears. Release
 * publication is a separate, human decision — see `docs/release/release-checklist.md`.
 *
 * ── Composition ───────────────────────────────────────────────────────
 *
 * Every step is an npm script, so each one can be run on its own:
 *
 *   npm run verify:release              everything
 *   npm run verify:release -- --list    the plan, without running it
 *   npm run verify:release -- --only docs --only version-census
 *   npm run verify:version              one check, directly
 *
 * ── Honest skips ──────────────────────────────────────────────────────
 *
 * A step whose precondition is absent is **skipped with the reason printed**, and the
 * summary counts it as skipped rather than passed. A harness that reported a skip as a
 * pass would be green for the wrong reason, which is the failure mode this repository's
 * own documentation warns about.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

/**
 * The plan.
 *
 * `gate` returns a reason to skip, or `null` to run. `why` is what the operator reads
 * before the step runs, so the summary is understandable without the script.
 */
const STEPS = [
  {
    name: "build",
    script: "build",
    why: "the TypeScript compiles, and the entrypoints the Dockerfile expects exist",
  },
  {
    name: "typecheck",
    script: "typecheck",
    why: "the product sources typecheck",
  },
  {
    name: "typecheck-tests",
    script: "typecheck:tests",
    why: "the test tree typechecks, which nothing else covers",
  },
  {
    name: "test",
    script: "test",
    why: "the unit suites pass without a database; the real-Mongo halves skip here",
  },
  {
    name: "test-integration",
    script: "test",
    why: "the same suites with every real-MongoDB half actually run",
    env: { CERBERUS_TEST_MONGODB_URI: process.env["CERBERUS_TEST_MONGODB_URI"] ?? "" },
    gate: () =>
      (process.env["CERBERUS_TEST_MONGODB_URI"] ?? "").trim().length > 0
        ? null
        : "CERBERUS_TEST_MONGODB_URI is not set, so the real-database halves would skip",
  },
  {
    name: "migrations-previous-release",
    script: "test:migrations",
    why:
      "a published release's database is upgraded by this build — dry run, migrate, " +
      "validate, re-run — against a real MongoDB",
    env: { CERBERUS_TEST_MONGODB_URI: process.env["CERBERUS_TEST_MONGODB_URI"] ?? "" },
    gate: () =>
      (process.env["CERBERUS_TEST_MONGODB_URI"] ?? "").trim().length > 0
        ? null
        : "CERBERUS_TEST_MONGODB_URI is not set, so the upgrade gate cannot run",
  },
  {
    name: "docs",
    script: "check:docs",
    why: "every relative link and heading anchor resolves",
  },
  {
    name: "version-census",
    script: "verify:version",
    why: "every version declaration agrees with package.json",
  },
  {
    name: "config-census",
    script: "verify:config",
    why: "every environment variable read is documented, and every one documented is read",
  },
  {
    name: "secret-guards",
    script: "verify:secrets",
    why: "no tracked credential file, no retired identity, and no publishing command here",
  },
  {
    name: "console-format",
    script: "console:format",
    why: "the Flutter sources are formatted, which `flutter analyze` does not check",
  },
  {
    name: "console-analyze",
    script: "console:analyze",
    why: "the Flutter console analyses clean",
  },
  {
    name: "console-test",
    script: "console:test",
    why: "the Flutter widget and release-claim tests pass",
  },
];

const argv = process.argv.slice(2);
const listOnly = argv.includes("--list");

const only = [];
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--only") {
    const value = argv[index + 1];
    if (!value) {
      console.error("--only needs a step name. Use --list to see them.");
      process.exit(2);
    }
    only.push(value);
    index += 1;
  }
}

if (only.length > 0) {
  const known = new Set(STEPS.map((step) => step.name));
  const unknown = only.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    console.error(`Unknown step(s): ${unknown.join(", ")}. Use --list to see them.`);
    process.exit(2);
  }
}

const plan = only.length > 0 ? STEPS.filter((step) => only.includes(step.name)) : STEPS;

if (listOnly) {
  console.log("release verification plan\n");
  for (const step of plan) {
    console.log(`  ${step.name.padEnd(18)} ${step.why}`);
  }
  console.log(
    "\nNothing is published by any of these. Publication is a separate human decision.",
  );
  process.exit(0);
}

/** Runs one npm script with output streamed, so a failure is visible where it happens. */
function runScript(script, env) {
  const result = spawnSync("npm", ["run", script], {
    cwd: root,
    stdio: "inherit",
    // `shell` so the same invocation works on Windows, where npm is `npm.cmd`. Every
    // script name here is a plain npm script, so there is nothing to quote.
    shell: true,
    env: { ...process.env, ...env },
  });
  return result.status === 0;
}

const startedAt = Date.now();
const outcomes = [];

console.log("CERBERUS RELEASE VERIFICATION");
console.log("  never publishes: no step here can push, publish or create a release\n");

for (const step of plan) {
  const skipReason = step.gate ? step.gate() : null;

  if (skipReason) {
    console.log(`── ${step.name}: SKIPPED — ${skipReason}\n`);
    outcomes.push({ name: step.name, outcome: "skipped", detail: skipReason });
    continue;
  }

  console.log(`── ${step.name}: ${step.why}`);
  const stepStartedAt = Date.now();
  const passed = runScript(step.script, step.env ?? {});
  const elapsedSeconds = ((Date.now() - stepStartedAt) / 1000).toFixed(1);

  console.log(
    `── ${step.name}: ${passed ? "PASS" : "FAIL"} (${elapsedSeconds}s)\n`,
  );
  outcomes.push({
    name: step.name,
    outcome: passed ? "passed" : "failed",
    detail: `${elapsedSeconds}s`,
  });
}

const passed = outcomes.filter((outcome) => outcome.outcome === "passed").length;
const failed = outcomes.filter((outcome) => outcome.outcome === "failed").length;
const skipped = outcomes.filter((outcome) => outcome.outcome === "skipped").length;
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

console.log("SUMMARY");
for (const outcome of outcomes) {
  const label =
    outcome.outcome === "passed" ? "PASS   " : outcome.outcome === "failed" ? "FAIL   " : "SKIPPED";
  console.log(`  ${label} ${outcome.name.padEnd(18)} ${outcome.detail}`);
}
console.log(
  `\n  ${passed} passed, ${failed} failed, ${skipped} skipped — ${elapsed}s`,
);

if (skipped > 0) {
  console.log(
    "\n  A skip is not a pass. The reason is printed above; make the precondition true\n" +
      "  and run the step again before treating the gate as verified.",
  );
}

console.log(
  failed === 0
    ? "\nRELEASE VERIFICATION PASSED (nothing was published)"
    : `\nRELEASE VERIFICATION FAILED: ${failed} step(s)`,
);

process.exit(failed === 0 ? 0 : 1);

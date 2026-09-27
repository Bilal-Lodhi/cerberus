/**
 * The attribution guard's range resolution.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 *
 * The guard's default range was the literal `origin/main..HEAD`. That is true in a
 * developer's clone and true in `ci.yml`, which passes an explicit `--range` derived from
 * the event — so nothing caught that it is **false** in the release-verification workflow,
 * whose `actions/checkout@v4` fetches one ref and no remote-tracking branches.
 *
 * The result was a manual release drill that failed for a reason unrelated to attribution:
 * `git log origin/main..HEAD` exited 128 and the guard died with an unhandled
 * `execFileSync` stack trace. Two things were wrong and both are asserted here — the range
 * must be *discovered*, and an unreadable range must fail with a **diagnosis** rather than a
 * crash.
 *
 * The guard is a script rather than a module, so these drive it as a process. That is also
 * the only way to assert the exit code, which is the part a gate depends on.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const GUARD = join(root, "scripts", "release", "attribution-guard.mjs");

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs the guard and reports its exit code and streams rather than throwing. */
function run(args: string[]): Run {
  try {
    const stdout = execFileSync("node", [GUARD, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: typeof failure.status === "number" ? failure.status : 1,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? ""),
    };
  }
}

/** A stack trace is what a crash looks like; a diagnosis is what a guard looks like. */
function looksLikeACrash(text: string): boolean {
  return /node:internal|at Object\.|at Module\.|at async |ERR_CHILD_PROCESS/.test(text);
}

describe("the attribution guard's range resolution", () => {
  test("the default range resolves in this checkout and examines commits", () => {
    // The guard's own success path. If the base cannot be resolved it now exits 1 with a
    // diagnosis, so a green result here is the assertion that resolution worked.
    const result = run([]);

    assert.equal(
      result.status,
      0,
      `the guard failed with no arguments:\n${result.stdout}\n${result.stderr}`,
    );
    assert.match(
      result.stdout,
      /attribution guard — \d+ commit\(s\) in /,
      "the guard did not report a commit count, so the range resolved to nothing",
    );
    assert.ok(
      !looksLikeACrash(result.stdout + result.stderr),
      "the guard crashed instead of reporting",
    );
  });

  test("an unreadable range fails with a diagnosis, not a stack trace", () => {
    const result = run(["--range", "no-such-ref-anywhere..HEAD"]);

    assert.equal(result.status, 1, "an unreadable range must fail the gate");
    assert.match(
      result.stderr,
      /could not read the commit range/,
      "the guard did not name the problem it hit",
    );
    assert.ok(
      !looksLikeACrash(result.stdout + result.stderr),
      "the guard reported an unreadable range as an unhandled exception, which is what " +
        "made the release drill's failure unreadable",
    );
  });

  test("--all is a diagnostic and says so", () => {
    // Its exit code depends on whether the historical trailers are present, which is a fact
    // about history rather than about this code. What is asserted is that it runs, reports
    // the whole history, and does not crash.
    const result = run(["--all"]);

    assert.match(result.stdout, /the whole history/);
    assert.ok(!looksLikeACrash(result.stdout + result.stderr));
  });

  test("the default is discovered, not hard-coded", () => {
    // A structural check, in the spirit of `bench-config.test.ts`: the regression this file
    // exists for is a literal ref returning to the source. Asserting the candidate list is
    // present is cheap and it is what would have failed before the fix.
    const source = readFileSync(GUARD, "utf8");

    assert.ok(
      source.includes("resolveDefaultBase"),
      "the guard no longer resolves its base, so it is back to assuming a ref exists",
    );
    assert.ok(
      /"origin\/main",\s*"main",\s*"refs\/remotes\/origin\/HEAD"/.test(source),
      "the candidate list is gone, so a checkout without `origin/main` cannot be guarded",
    );
    assert.ok(
      !/range = "origin\/main\.\.HEAD"/.test(source),
      "the default range is hard-coded again — which is what made the release drill red " +
        "for a reason unrelated to attribution",
    );
  });
});

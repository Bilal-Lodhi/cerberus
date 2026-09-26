/**
 * The benchmark's configuration literal, checked against the application's.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 *
 * `scripts/bench/run-bench.mjs` builds its own `AppConfig` literal rather than calling
 * `loadConfig()`, because a benchmark must not depend on an operator's environment. That is
 * the right call, and it has a failure mode that was live for four releases:
 *
 *   `createApp` reads `config.log.level` unconditionally. The operability cycle added
 *   structured logging to `AppConfig` and the bench's literal was not updated, so
 *   `npm run bench` — the command `docs/development/performance-baseline.md` documents as the
 *   reproducible way to produce the baseline — threw `Cannot read properties of undefined`
 *   before a single case ran. It had been broken from `v0.4.0` onward and nothing noticed,
 *   because no test ran it and no gate named it.
 *
 * A benchmark that does not run is worse than no benchmark: the document goes on describing a
 * baseline that nobody can reproduce, and the numbers in it can no longer be compared with
 * anything. So the literal is now asserted against the shape the application actually needs,
 * by comparing its top-level keys with `makeConfig()`'s.
 *
 * This is a structural check, not a behavioural one — the bench still calls `createApp` and
 * would fail loudly if the shape were wrong in a way this cannot see. Its job is to catch the
 * drift that actually happened: a field added to `AppConfig` and forgotten here.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeConfig } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const BENCH = join(here, "..", "..", "..", "scripts", "bench", "run-bench.mjs");

/** The top-level keys of the object literal `benchConfig()` returns. */
function benchConfigKeys(): string[] {
  const source = readFileSync(BENCH, "utf8");

  const start = source.indexOf("function benchConfig()");
  assert.ok(start >= 0, "benchConfig() was renamed or removed, so this check is blind");

  const returnStart = source.indexOf("return {", start);
  assert.ok(returnStart >= 0, "benchConfig() no longer returns an object literal");

  // Walk the literal to its matching close brace, so a nested object's keys are not mistaken
  // for top-level ones.
  let depth = 0;
  let end = -1;
  for (let index = returnStart + "return ".length; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  assert.ok(end > returnStart, "the benchConfig() literal is unbalanced");

  const literal = source.slice(returnStart, end + 1);

  // A top-level key is indented four spaces inside the literal. The walk below tracks nesting
  // so a nested object's keys are not mistaken for top-level ones, and it starts at **-1** so
  // that the literal's own opening brace brings it to 0 rather than 1.
  //
  // String literals are removed **before** comments are, and the order matters: the config
  // contains `"http://127.0.0.1:1"`, and stripping comments first would cut the line at the
  // `//` inside that URL — taking the closing brace with it and leaving the depth walk
  // unbalanced for every key after it. That is not hypothetical; it is what the first version
  // of this function did, and it reported six keys as missing that were present.
  const keys = new Set<string>();
  let nestedDepth = -1;
  for (const rawLine of literal.split(/\r?\n/)) {
    const line = rawLine
      .replace(/"[^"]*"/g, '""')
      .replace(/'[^']*'/g, "''")
      .replace(/\/\/.*$/, "");

    if (nestedDepth === 0) {
      const match = /^\s{4}([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
      if (match) keys.add(match[1]);
    }

    for (const character of line) {
      if (character === "{" || character === "[") nestedDepth += 1;
      else if (character === "}" || character === "]") nestedDepth -= 1;
    }
  }

  return [...keys].sort();
}

describe("the benchmark's configuration literal", () => {
  test("declares every top-level key the application's config has", () => {
    const expected = Object.keys(makeConfig()).sort();
    const actual = benchConfigKeys();

    const missing = expected.filter((key) => !actual.includes(key));
    assert.deepEqual(
      missing,
      [],
      `scripts/bench/run-bench.mjs is missing ${missing.join(", ")} from its config literal. ` +
        "createApp reads these unconditionally, so the benchmark would throw before its " +
        "first case ran — which is exactly what happened for four releases after " +
        "`log` was added to AppConfig.",
    );
  });

  test("declares nothing the application's config does not have", () => {
    // The other direction: a key the app does not read is a field an author believed was
    // being exercised. `makeConfig` is the canonical shape, so this compares against it.
    const expected = Object.keys(makeConfig()).sort();
    const actual = benchConfigKeys();

    const extra = actual.filter((key) => !expected.includes(key));
    assert.deepEqual(
      extra,
      [],
      `scripts/bench/run-bench.mjs declares ${extra.join(", ")}, which AppConfig does not ` +
        "have — either a typo, or a field that was removed from the application and left here",
    );
  });

  test("the extracted key set is not empty, so the check cannot pass vacuously", () => {
    // A parser that silently found nothing would make both assertions above pass while
    // checking nothing at all.
    const actual = benchConfigKeys();
    assert.ok(
      actual.length >= 8,
      `only ${actual.length} key(s) were extracted from the bench config literal, so the ` +
        "extraction is broken rather than the literal being correct",
    );
  });
});

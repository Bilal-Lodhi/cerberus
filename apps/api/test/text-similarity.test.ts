/**
 * Deterministic local text similarity.
 *
 * These are pure functions with no network and no model, so the threshold
 * boundary is asserted exactly. `DATA_LEAKAGE_SIMILARITY_THRESHOLD` gates
 * something only if this comparison is the one producing the numbers.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SNIPPET_CHARS,
  MIN_COMPARABLE_TOKENS,
  SHINGLE_SIZE,
  findSimilarityMatches,
  jaccard,
  normalizeText,
  shingles,
  textSimilarity,
  tokenize,
  type ReferenceDocument,
} from "../src/services/text-similarity.js";

/** A 40-token reference, long enough to clear the comparable-token floor. */
const REFERENCE_TOKENS = Array.from({ length: 40 }, (_, i) => `token${i}`);
const REFERENCE_TEXT = REFERENCE_TOKENS.join(" ");

const reference: ReferenceDocument = {
  referenceId: "ref-1",
  label: "internal-ledger-snippet",
  content: REFERENCE_TEXT,
};

describe("tokenize and normalizeText", () => {
  test("lower-cases and strips punctuation", () => {
    assert.deepEqual(tokenize("Hello, World! (again)"), ["hello", "world", "again"]);
  });

  test("collapses whitespace and newlines", () => {
    assert.deepEqual(tokenize("a\n\n  b\t c"), ["a", "b", "c"]);
  });

  test("keeps non-Latin letters rather than erasing them", () => {
    assert.deepEqual(tokenize("Привет мир"), ["привет", "мир"]);
    assert.deepEqual(tokenize("日本語 テスト"), ["日本語", "テスト"]);
  });

  test("keeps digits and drops symbols", () => {
    assert.deepEqual(tokenize("amount: $1,234.56"), ["amount", "1", "234", "56"]);
  });

  test("normalizeText round-trips through tokenize", () => {
    assert.equal(normalizeText("  A,  b!  "), "a b");
  });

  test("empty input produces no tokens", () => {
    assert.deepEqual(tokenize(""), []);
    assert.deepEqual(tokenize("   ...   "), []);
    assert.equal(normalizeText(""), "");
  });
});

describe("shingles", () => {
  test("produces overlapping windows", () => {
    const result = shingles(["a", "b", "c", "d"], 3);
    assert.deepEqual([...result].sort(), ["a b c", "b c d"]);
  });

  test("returns nothing when the input is shorter than the window", () => {
    assert.equal(shingles(["a", "b"], 3).size, 0);
    assert.equal(shingles([], 3).size, 0);
  });

  test("a repeated window collapses into one entry", () => {
    assert.equal(shingles(["a", "a", "a", "a"], 3).size, 1);
  });

  test("the default window is the documented size", () => {
    assert.equal(SHINGLE_SIZE, 3);
    assert.deepEqual([...shingles(["a", "b", "c"])], ["a b c"]);
  });
});

describe("jaccard", () => {
  test("identical sets score 1", () => {
    assert.equal(jaccard(new Set(["a", "b"]), new Set(["a", "b"])), 1);
  });

  test("disjoint sets score 0", () => {
    assert.equal(jaccard(new Set(["a"]), new Set(["b"])), 0);
  });

  test("partial overlap is intersection over union", () => {
    // |∩| = 1, |∪| = 3
    assert.equal(jaccard(new Set(["a", "b"]), new Set(["b", "c"])), 1 / 3);
  });

  test("an empty side scores 0 rather than dividing by zero", () => {
    assert.equal(jaccard(new Set(), new Set(["a"])), 0);
    assert.equal(jaccard(new Set(), new Set()), 0);
  });
});

describe("textSimilarity", () => {
  test("identical text scores 1", () => {
    assert.equal(textSimilarity(REFERENCE_TEXT, REFERENCE_TEXT), 1);
  });

  test("unrelated text of the same length scores 0", () => {
    const other = Array.from({ length: 40 }, (_, i) => `other${i}`).join(" ");
    assert.equal(textSimilarity(REFERENCE_TEXT, other), 0);
  });

  test("case, punctuation and whitespace do not change the score", () => {
    const messy = REFERENCE_TEXT.toUpperCase().replace(/ /g, ",  ");
    assert.equal(textSimilarity(REFERENCE_TEXT, messy), 1);
  });

  test("a one-word change scores high but not 1", () => {
    const edited = [...REFERENCE_TOKENS];
    edited[20] = "replaced";
    const score = textSimilarity(REFERENCE_TEXT, edited.join(" "));

    assert.ok(score > 0.8 && score < 1, `expected a high-but-imperfect score, got ${score}`);
  });

  test("a short overlap scores low", () => {
    // Twelve tokens: above the comparable floor, but only a fraction of the
    // reference, so the shared shingles are a small part of the union.
    const short = REFERENCE_TOKENS.slice(0, 12).join(" ");
    assert.ok(tokenize(short).length >= MIN_COMPARABLE_TOKENS);
    const score = textSimilarity(REFERENCE_TEXT, short);

    assert.ok(score > 0 && score < 0.3, `expected a low score, got ${score}`);
  });

  test("refuses to compare text below the token floor", () => {
    // Three identical tokens would otherwise score a perfect 1.0, which would
    // report two unrelated short strings as a match.
    const short = "alpha beta gamma";
    assert.ok(tokenize(short).length < MIN_COMPARABLE_TOKENS);
    assert.equal(textSimilarity(short, short), 0);
    assert.equal(textSimilarity(REFERENCE_TEXT, short), 0);
    assert.equal(textSimilarity(short, REFERENCE_TEXT), 0);
  });

  test("is symmetric", () => {
    const edited = [...REFERENCE_TOKENS];
    edited[5] = "different";
    assert.equal(
      textSimilarity(REFERENCE_TEXT, edited.join(" ")),
      textSimilarity(edited.join(" "), REFERENCE_TEXT),
    );
  });

  test("empty input scores 0", () => {
    assert.equal(textSimilarity("", REFERENCE_TEXT), 0);
    assert.equal(textSimilarity(REFERENCE_TEXT, ""), 0);
  });
});

describe("findSimilarityMatches", () => {
  /** A near-copy: one word in forty changed. */
  const nearCopy = (() => {
    const edited = [...REFERENCE_TOKENS];
    edited[20] = "replaced";
    return edited.join(" ");
  })();

  test("an empty corpus produces nothing", () => {
    const result = findSimilarityMatches([nearCopy], [], 0.5);
    assert.deepEqual(result.matches, []);
    assert.equal(result.overallSimilarity, 0);
  });

  test("an empty paste list produces nothing", () => {
    const result = findSimilarityMatches([], [reference], 0.5);
    assert.deepEqual(result.matches, []);
    assert.equal(result.overallSimilarity, 0);
  });

  test("a non-positive threshold disables matching rather than matching everything", () => {
    for (const threshold of [0, -1, Number.NaN]) {
      const result = findSimilarityMatches([nearCopy], [reference], threshold);
      assert.deepEqual(result.matches, [], `threshold=${threshold}`);
    }
  });

  test("matches at the threshold exactly, and not one step above", () => {
    const score = textSimilarity(nearCopy, reference.content);

    const atThreshold = findSimilarityMatches([nearCopy], [reference], score);
    assert.equal(atThreshold.matches.length, 1, "a score equal to the threshold must match");
    assert.equal(atThreshold.matches[0].similarityScore, score);

    const justAbove = findSimilarityMatches([nearCopy], [reference], score + 1e-6);
    assert.equal(justAbove.matches.length, 0, "a score below the threshold must not match");
    // The score is still reported, so an operator can see how close it came.
    assert.equal(justAbove.overallSimilarity, score);
  });

  test("reports the strongest match first", () => {
    const weaker = REFERENCE_TOKENS.slice(0, 20).join(" ");
    const weakerReference: ReferenceDocument = {
      referenceId: "ref-2",
      label: "weaker",
      content: weaker,
    };

    const result = findSimilarityMatches([nearCopy], [weakerReference, reference], 0.1);

    assert.equal(result.matches.length, 2);
    assert.ok(
      result.matches[0].similarityScore >= result.matches[1].similarityScore,
      "matches were not sorted by score descending",
    );
    assert.equal(result.matches[0].referenceId, "ref-1");
  });

  test("carries the reference identity into the match", () => {
    const result = findSimilarityMatches([nearCopy], [reference], 0.5);

    assert.equal(result.matches[0].referenceId, "ref-1");
    assert.equal(result.matches[0].sourceLabel, "internal-ledger-snippet");
    assert.equal(result.matches[0].sourceSnippet, reference.content);
    assert.equal(result.matches[0].employeeSnippet, nearCopy);
  });

  test("bounds both snippets of a match", () => {
    // Many distinct tokens rather than one long run: a single repeated token is
    // below the comparable floor and would not be compared at all.
    const huge = Array.from({ length: 3_000 }, (_, i) => `word${i}`).join(" ");
    assert.ok(huge.length > MAX_SNIPPET_CHARS * 2, "fixture is not long enough");
    const hugeReference: ReferenceDocument = {
      referenceId: "ref-big",
      label: "big",
      content: huge,
    };

    const result = findSimilarityMatches([huge], [hugeReference], 0.5);

    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].sourceSnippet.length, MAX_SNIPPET_CHARS);
    assert.equal(result.matches[0].employeeSnippet.length, MAX_SNIPPET_CHARS);
  });

  test("skips a paste too short to compare", () => {
    const result = findSimilarityMatches(["alpha beta gamma"], [reference], 0.1);
    assert.deepEqual(result.matches, []);
    assert.equal(result.overallSimilarity, 0);
  });

  test("compares every paste against every reference", () => {
    const other: ReferenceDocument = {
      referenceId: "ref-3",
      label: "unrelated",
      content: Array.from({ length: 40 }, (_, i) => `unrelated${i}`).join(" "),
    };

    const result = findSimilarityMatches([nearCopy], [other, reference], 0.5);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].referenceId, "ref-1");
  });
});

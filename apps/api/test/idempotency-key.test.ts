/**
 * The `Idempotency-Key` contract.
 *
 * ── Why the rejections are tested as hard as the acceptances ──────────
 *
 * The key is a caller-controlled string on a path that spends money, and it is stored,
 * hashed, logged (as a digest) and used to select a record. Every one of those is a place a
 * malformed value can do something the caller did not intend. So each rejection asserts two
 * things: that the value is refused, and that **no key material survives** the refusal —
 * because a rejected key that is still hashed and stored would be a rejected key that
 * consumed an operation.
 *
 * The acceptances assert the property the whole mechanism rests on: two spellings of the
 * same key produce the same digest, and the digest is not the key.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  IDEMPOTENCY_KEY_HEADER,
  MAX_IDEMPOTENCY_KEY_CHARS,
  hashIdempotencyKey,
  keyIdFromHash,
  readIdempotencyKey,
} from "../src/services/idempotency-key.js";

describe("the header name", () => {
  test("is the documented spelling", () => {
    assert.equal(IDEMPOTENCY_KEY_HEADER, "Idempotency-Key");
  });
});

describe("readIdempotencyKey — absent", () => {
  test("an absent header is absent, not rejected", () => {
    // The header is optional. Absent must stay a distinct outcome from rejected, because
    // the route answers them completely differently: one is today's behaviour, the other is
    // a 400.
    assert.deepEqual(readIdempotencyKey(undefined), { status: "absent" });
  });
});

describe("readIdempotencyKey — accepted", () => {
  test("a UUID is accepted and hashed", () => {
    const key = "6f1c2f7e-9b3a-4d1e-8f2b-0c7a5d4e3b21";
    const outcome = readIdempotencyKey(key);

    assert.equal(outcome.status, "accepted");
    if (outcome.status !== "accepted") return;

    assert.equal(outcome.key, key);
    assert.equal(outcome.keyHash, hashIdempotencyKey(key));
    assert.equal(outcome.keyHash.length, 64, "sha256 hex is 64 characters");
    assert.match(outcome.keyHash, /^[0-9a-f]{64}$/);
  });

  test("the digest is not the key, and the key is not recoverable from it", () => {
    const key = "retry-1";
    const outcome = readIdempotencyKey(key);
    assert.equal(outcome.status, "accepted");
    if (outcome.status !== "accepted") return;

    assert.notEqual(outcome.keyHash, key);
    assert.ok(
      !outcome.keyHash.includes(key),
      "the digest contains the raw key, so storing it would store the key",
    );
  });

  test("the same key always produces the same digest", () => {
    // This is what makes a retry recognisable. A digest that varied would make every retry
    // a new operation.
    const first = readIdempotencyKey("stable-key");
    const second = readIdempotencyKey("stable-key");

    assert.equal(first.status, "accepted");
    assert.equal(second.status, "accepted");
    if (first.status !== "accepted" || second.status !== "accepted") return;

    assert.equal(first.keyHash, second.keyHash);
  });

  test("different keys produce different digests", () => {
    const a = readIdempotencyKey("key-a");
    const b = readIdempotencyKey("key-b");
    if (a.status !== "accepted" || b.status !== "accepted") return assert.fail("not accepted");
    assert.notEqual(a.keyHash, b.keyHash);
  });

  test("the whole printable ASCII range with no space is accepted", () => {
    // The boundary is asserted as a range rather than as a sample, because the range is the
    // contract.
    const lowest = "!";
    const highest = "~";
    const everyCharacter = Array.from({ length: 0x7e - 0x21 + 1 }, (_v, index) =>
      String.fromCharCode(0x21 + index),
    ).join("");

    for (const key of [lowest, highest, everyCharacter, "a", "a.b:c/d=e_f~g-h+i"]) {
      const outcome = readIdempotencyKey(key);
      assert.equal(
        outcome.status,
        "accepted",
        `'${key.slice(0, 20)}' should be an accepted key`,
      );
    }
  });

  test("a key of exactly the maximum length is accepted", () => {
    const outcome = readIdempotencyKey("k".repeat(MAX_IDEMPOTENCY_KEY_CHARS));
    assert.equal(outcome.status, "accepted");
  });

  test("the keyId is the first eight characters of the digest", () => {
    const outcome = readIdempotencyKey("log-safe-key");
    if (outcome.status !== "accepted") return assert.fail("not accepted");

    assert.equal(outcome.keyId, outcome.keyHash.slice(0, 8));
    assert.equal(outcome.keyId.length, 8);
    assert.equal(keyIdFromHash(outcome.keyHash), outcome.keyId);
  });

  test("the keyId is short enough to be safe in a log line and long enough to join two", () => {
    // The point of the truncated digest is that it distinguishes operations without
    // recording the key. Eight hex characters is 32 bits: two log lines for one operation
    // match, and no key material is present.
    const outcome = readIdempotencyKey("some-operation-key");
    if (outcome.status !== "accepted") return assert.fail("not accepted");
    assert.match(outcome.keyId, /^[0-9a-f]{8}$/);
  });
});

describe("readIdempotencyKey — rejected", () => {
  test("an empty header is rejected, not treated as absent", () => {
    // A caller that sent the header believed the request was protected. Falling back to
    // non-idempotent behaviour would answer that belief with a request that is not.
    const outcome = readIdempotencyKey("");
    assert.equal(outcome.status, "rejected");
    if (outcome.status !== "rejected") return;
    assert.match(outcome.reason, /empty/);
  });

  test("a key one character over the limit is rejected", () => {
    const outcome = readIdempotencyKey("k".repeat(MAX_IDEMPOTENCY_KEY_CHARS + 1));
    assert.equal(outcome.status, "rejected");
    if (outcome.status !== "rejected") return;
    assert.match(outcome.reason, new RegExp(String(MAX_IDEMPOTENCY_KEY_CHARS)));
  });

  test("a space is rejected, so whitespace cannot be ambiguous", () => {
    // Every HTTP stack folds or trims header whitespace differently, so `"a b"` and
    // `"a  b"` would be the same key through one intermediary and different through
    // another. Excluding space removes the question rather than answering it.
    assert.equal(readIdempotencyKey("a b").status, "rejected");
    assert.equal(readIdempotencyKey(" leading").status, "rejected");
    assert.equal(readIdempotencyKey("trailing ").status, "rejected");
    assert.equal(readIdempotencyKey("tab\there").status, "rejected");
  });

  test("every control character is rejected", () => {
    // A control character reaches a log line, a database field and possibly a terminal.
    for (const control of ["\n", "\r", "\t", "\u0000", "\u001b", "\u007f"]) {
      const outcome = readIdempotencyKey(`key${control}value`);
      assert.equal(
        outcome.status,
        "rejected",
        `a key containing ${JSON.stringify(control)} was accepted`,
      );
    }
  });

  test("non-ASCII characters are rejected", () => {
    for (const key of ["clé", "ключ", "鍵", "café-1", "\u00e9"]) {
      assert.equal(
        readIdempotencyKey(key).status,
        "rejected",
        `'${key}' should be rejected: two byte sequences that render alike must not be two keys`,
      );
    }
  });

  test("a rejected key yields no digest at all", () => {
    // The property that matters: a rejection must not leave key material behind, or a
    // rejected key would still have consumed an operation.
    for (const bad of ["", "a b", "x".repeat(MAX_IDEMPOTENCY_KEY_CHARS + 1), "clé", "a\nb"]) {
      const outcome = readIdempotencyKey(bad);
      assert.equal(outcome.status, "rejected");
      assert.ok(
        !("keyHash" in outcome) && !("key" in outcome) && !("keyId" in outcome),
        "a rejected key carried key material",
      );
    }
  });

  test("the rejection message never echoes the key", () => {
    // The message is returned to the caller and may be logged. Echoing a value that failed
    // validation is how an injection gets into a log line, and a key that looks like a
    // credential is the worst value to quote back.
    const secret = "sk-live-should-never-be-echoed";
    const bad = `${secret} with a space`;

    for (const candidate of [bad, `${secret}${"x".repeat(MAX_IDEMPOTENCY_KEY_CHARS)}`]) {
      const outcome = readIdempotencyKey(candidate);
      assert.equal(outcome.status, "rejected");
      if (outcome.status !== "rejected") continue;

      assert.ok(!outcome.reason.includes(secret), "the rejection message echoed the key");
      assert.ok(
        !outcome.reason.includes(candidate),
        "the rejection message quoted the whole bad value",
      );
    }
  });
});

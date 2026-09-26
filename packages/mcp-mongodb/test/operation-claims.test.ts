/**
 * The paid-operation claim's index specification.
 *
 * ── Why this is worth its own suite ───────────────────────────────────
 *
 * The claim's mutual exclusion is a **unique index**, not a lock. That makes the index
 * specification part of the correctness argument rather than a tuning knob: an index on
 * the wrong key pair would let two API processes both execute one idempotency key, and an
 * index without `unique` would let a retry spend a second time. Neither failure is visible
 * in a response, and neither is caught by any behavioural test that only ever uses one
 * process.
 *
 * So the specification is asserted here as an exact value, and the real-MongoDB suites
 * (`critical-indexes.test.ts`, `migration-from-previous-release.test.ts`) assert that both
 * callers actually apply it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  OPERATION_CLAIM_FORBIDDEN_FIELDS,
  OPERATION_CLAIM_INDEXES,
  OPERATION_CLAIM_STATUSES,
  PAID_ROUTE_FAMILIES,
  ensureOperationClaimIndexes,
} from "../src/operation-claims.js";

describe("the claim vocabulary", () => {
  test("a claim belongs to exactly one of the two paid routes", () => {
    assert.deepEqual([...PAID_ROUTE_FAMILIES], ["scenarios", "auditor"]);
  });

  test("the families are the route names the API mounts", () => {
    // The family is what separates one key namespace from another. If it drifted from the
    // route it names, a key reused across routes would be answered with the other route's
    // record — or refused as a conflict for a request the caller never made here.
    assert.ok(PAID_ROUTE_FAMILIES.includes("scenarios"));
    assert.ok(PAID_ROUTE_FAMILIES.includes("auditor"));
    assert.equal(PAID_ROUTE_FAMILIES.length, 2);
  });

  test("there are three states, and no fourth", () => {
    // A claim is being worked on, done, or failed. Whether a failure may be retried is a
    // flag on the record rather than a fourth state, because a state is a thing every
    // reader has to hold in their head and a flag is not.
    assert.deepEqual([...OPERATION_CLAIM_STATUSES], ["pending", "completed", "failed"]);
  });
});

describe("the claim indexes", () => {
  test("the unique index is the mutual exclusion, on the route family and the key hash", () => {
    const unique = OPERATION_CLAIM_INDEXES.filter((entry) => entry.options.unique === true);
    assert.equal(unique.length, 1, "the claim must have exactly one unique index");

    assert.deepEqual(unique[0].key, { routeFamily: 1, keyHash: 1 });
    assert.equal(unique[0].options.unique, true);
  });

  test("the fingerprint is deliberately NOT part of the unique identity", () => {
    // Including it would mean the same key with a different body created a *second* record
    // instead of being detected as a conflict — turning the conflict case into a silent
    // second execution, which is the exact failure the key exists to prevent. The
    // fingerprint is compared against the record, never used to select one.
    const unique = OPERATION_CLAIM_INDEXES.find((entry) => entry.options.unique === true);
    assert.ok(unique);
    assert.ok(!("fingerprint" in unique.key));
    assert.ok(!("fingerprintVersion" in unique.key));
  });

  test("the TTL index bounds the collection, with the deadline in the data", () => {
    const ttl = OPERATION_CLAIM_INDEXES.filter(
      (entry) => entry.options.expireAfterSeconds !== undefined,
    );
    assert.equal(ttl.length, 1, "the claim must have exactly one retention index");

    assert.deepEqual(ttl[0].key, { expiresAt: 1 });
    // `0` means "delete when the value of the field is in the past", so the retention
    // window is written into each record rather than into the index. That is what makes
    // the specification a constant that can never need to change, and therefore something
    // two callers cannot disagree about.
    assert.equal(ttl[0].options.expireAfterSeconds, 0);
  });

  test("every index states why it is load-bearing", () => {
    for (const entry of OPERATION_CLAIM_INDEXES) {
      assert.ok(
        typeof entry.why === "string" && entry.why.trim().length > 40,
        `${Object.keys(entry.key).join("+")} has no stated reason, so a reader cannot tell ` +
          "whether it is still load-bearing",
      );
    }
  });

  test("the pair of indexes is exactly two, so a restore check can be exhaustive", () => {
    assert.equal(OPERATION_CLAIM_INDEXES.length, 2);
  });
});

describe("ensureOperationClaimIndexes", () => {
  test("creates every index in the list, with its exact options", async () => {
    const created: Array<{ key: Record<string, unknown>; options: Record<string, unknown> }> = [];

    // A minimal collection stand-in: the only method the helper uses is `createIndex`, and
    // recording the arguments is what makes this assert the specification rather than a
    // call count.
    const collection = {
      async createIndex(key: Record<string, unknown>, options: Record<string, unknown> = {}) {
        created.push({ key, options });
        return Object.keys(key).join("_") + "_1";
      },
    };

    await ensureOperationClaimIndexes(collection as never);

    assert.deepEqual(
      created,
      OPERATION_CLAIM_INDEXES.map((entry) => ({ key: entry.key, options: entry.options })),
      "the helper did not apply the shared specification, so the migration and the store " +
        "can now create different indexes",
    );
  });

  test("is safe to apply twice, which is what lets both callers use it", async () => {
    let calls = 0;
    const collection = {
      async createIndex() {
        calls += 1;
        return "index_1";
      },
    };

    await ensureOperationClaimIndexes(collection as never);
    await ensureOperationClaimIndexes(collection as never);

    // `createIndex` is idempotent for an identical specification on the server; what
    // matters here is that the helper itself imposes no guard that would make the second
    // caller skip, because the caller that skips is the one that leaves the database
    // without the index.
    assert.equal(calls, OPERATION_CLAIM_INDEXES.length * 2);
  });
});

describe("what a claim record must never contain", () => {
  test("the forbidden-field list covers the raw key, the credentials and the payloads", () => {
    // Asserted as a list rather than left as a comment, because it is checked against real
    // stored BSON by the API-side suite: a guarantee stated only in prose is one that
    // drifts.
    for (const field of ["idempotencyKey", "apiKey", "token", "authorization", "prompt", "question"]) {
      assert.ok(
        (OPERATION_CLAIM_FORBIDDEN_FIELDS as readonly string[]).includes(field),
        `'${field}' is not in the forbidden-field list`,
      );
    }
  });
});

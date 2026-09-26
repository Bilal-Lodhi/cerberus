/**
 * The critical-index list, checked against the store it describes.
 *
 * `scripts/release/critical-indexes.json` names the uniqueness and retention guarantees a
 * restore must preserve. `scripts/restore-cerberus.ps1` verifies them after every restore,
 * and the backup/restore drill creates exactly them so the verification has something to
 * find.
 *
 * A list like that drifts in two directions, and both are silent:
 *
 *   1. **It names an index the product does not create.** The restore check then fails on
 *      a perfectly good restore, and an operator learns to ignore it.
 *   2. **The product creates a unique index the list omits.** The check passes, and the
 *      new guarantee is never verified after a restore — which is the failure the list
 *      exists to prevent.
 *
 * So this asserts both directions against a **real** MongoDB, because the thing being
 * compared is what `ensureIndexes()` actually does rather than what it appears to do.
 *
 * ── The two kinds of index fail differently ───────────────────────────
 *
 * A **unique** index that a restore loses accepts documents the product forbids: two rows
 * sharing a `riskAssessmentId`, or two paid-operation claims sharing an idempotency key —
 * and the second of those means a retry spends a second time with nothing reporting it.
 * A **TTL** index that a restore loses changes no answer at all; it lets a collection grow
 * without limit. That is why the second kind is easy to overlook, and why it is checked
 * with the same both-directions rigour rather than trusted.
 *
 * Runs when `CERBERUS_TEST_MONGODB_URI` is set, and is skipped with a stated reason when
 * it is not.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MongoClient } from "mongodb";

import { MongoStore } from "../../../../packages/mcp-mongodb/src/mongo-client.js";
import { COLLECTION_NAMES } from "../../../../packages/mcp-mongodb/src/tool-names.js";

const here = dirname(fileURLToPath(import.meta.url));
const listPath = resolve(here, "..", "..", "..", "..", "scripts", "release", "critical-indexes.json");

const REAL_MONGODB_URI = process.env["CERBERUS_TEST_MONGODB_URI"]?.trim() ?? "";

interface CriticalIndex {
  collection: string;
  key: Record<string, number>;
  why?: string;
}

interface CriticalTtlIndex extends CriticalIndex {
  expireAfterSeconds: number;
}

const list = JSON.parse(readFileSync(listPath, "utf8")) as {
  indexes: CriticalIndex[];
  ttlIndexes?: CriticalTtlIndex[];
};

const ttlIndexes = list.ttlIndexes ?? [];

/** The driver's own rendering of a key pattern, matching the restore script's. */
function keyPattern(key: Record<string, unknown>): string {
  return Object.keys(key).join("+");
}

/** Identity of a unique index: collection and key pattern. */
function uniqueId(collection: string, key: Record<string, unknown>): string {
  return `${collection}:${keyPattern(key)}`;
}

/**
 * Identity of a TTL index: collection, key pattern **and** the expiry.
 *
 * The expiry is part of the identity on purpose. A TTL index with the same key but a
 * different `expireAfterSeconds` is a different guarantee, and comparing only the key
 * would report a wrong retention window as correct.
 */
function ttlId(collection: string, key: Record<string, unknown>, seconds: unknown): string {
  return `${collection}:${keyPattern(key)}:${String(seconds)}`;
}

if (REAL_MONGODB_URI) {
  describe("the critical-index list against the real store", () => {
    test("every entry is an index the product actually creates, and the list is complete", async () => {
      const databaseName = `cerberus_indexes_${randomUUID().replace(/-/g, "")}`;
      const store = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });

      // `connect()` runs the migrations and then creates the indexes, which is the
      // documented path a deployment takes.
      await store.connect();

      const client = new MongoClient(REAL_MONGODB_URI);
      await client.connect();
      const db = client.db(databaseName);

      try {
        // ── What the store actually created ──
        const actualUnique = new Set<string>();
        const actualTtl = new Set<string>();

        for (const collection of Object.values(COLLECTION_NAMES)) {
          const indexes = await db.collection(collection).indexes();
          for (const index of indexes) {
            const key = index.key as Record<string, unknown>;

            if (index.unique === true) {
              actualUnique.add(uniqueId(collection, key));
            }

            // A TTL index is one the server will sweep. `expireAfterSeconds` is present
            // on the index specification exactly when it is one — MongoDB does not add a
            // default, so its presence is the signal rather than a truthy check on a
            // value that could legitimately be 0.
            if (typeof index.expireAfterSeconds === "number") {
              actualTtl.add(ttlId(collection, key, index.expireAfterSeconds));
            }
          }
        }

        // ── Unique indexes: both directions ──
        const declaredUnique = new Set(
          list.indexes.map((entry) => uniqueId(entry.collection, entry.key)),
        );

        assert.deepEqual(
          [...declaredUnique].filter((entry) => !actualUnique.has(entry)),
          [],
          "the critical-index list names unique indexes the product does not create, so a " +
            "good restore would be reported as broken",
        );
        assert.deepEqual(
          [...actualUnique].filter((entry) => !declaredUnique.has(entry)),
          [],
          "the product creates unique indexes the critical-index list omits, so those " +
            "guarantees are never verified after a restore — add them to " +
            "scripts/release/critical-indexes.json",
        );

        // ── TTL indexes: both directions ──
        const declaredTtl = new Set(
          ttlIndexes.map((entry) =>
            ttlId(entry.collection, entry.key, entry.expireAfterSeconds),
          ),
        );

        assert.deepEqual(
          [...declaredTtl].filter((entry) => !actualTtl.has(entry)),
          [],
          "the critical-index list names TTL indexes the product does not create, so a " +
            "good restore would be reported as broken",
        );
        assert.deepEqual(
          [...actualTtl].filter((entry) => !declaredTtl.has(entry)),
          [],
          "the product creates TTL indexes the critical-index list omits, so a restore " +
            "that lost the retention bound would not be reported — add them to " +
            "scripts/release/critical-indexes.json",
        );

        assert.ok(actualUnique.size > 0, "the store created no unique index at all, so this proves nothing");
        assert.ok(
          actualTtl.size > 0,
          "the store created no TTL index at all, so the retention half of this test proves nothing",
        );

        // ── The claim indexes specifically ──
        //
        // Named individually because this is the guarantee the whole mechanism rests on:
        // if the unique claim index were absent, two processes racing one key would both
        // spend, and nothing in the request path would report it.
        assert.ok(
          actualUnique.has(uniqueId(COLLECTION_NAMES.operationClaims, { routeFamily: 1, keyHash: 1 })),
          "operation_claims has no unique (routeFamily, keyHash) index, so the paid-operation " +
            "claim is not exclusive and a retry can spend a second time",
        );
        assert.ok(
          actualTtl.has(ttlId(COLLECTION_NAMES.operationClaims, { expiresAt: 1 }, 0)),
          "operation_claims has no expiresAt TTL index, so the collection is unbounded",
        );
      } finally {
        await db.dropDatabase().catch(() => {});
        await client.close();
        await store.disconnect().catch(() => {});
      }
    });

    test("every entry states why the guarantee matters", () => {
      for (const entry of [...list.indexes, ...ttlIndexes]) {
        assert.ok(
          typeof entry.why === "string" && entry.why.trim().length > 0,
          `${entry.collection}:${keyPattern(entry.key)} has no stated reason, so a reader ` +
            "cannot tell whether it is still critical",
        );
      }
    });
  });
} else {
  test(
    "the critical-index list against the real store",
    { skip: "CERBERUS_TEST_MONGODB_URI is not set, so there is no store to compare against" },
    () => {},
  );
}

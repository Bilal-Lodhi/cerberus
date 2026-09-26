/**
 * The critical-index list, checked against the store it describes.
 *
 * `scripts/release/critical-indexes.json` names the uniqueness guarantees a restore must
 * preserve. `scripts/restore-cerberus.ps1` verifies them after every restore, and the
 * backup/restore drill creates exactly them so the verification has something to find.
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

const list = JSON.parse(readFileSync(listPath, "utf8")) as { indexes: CriticalIndex[] };

/** The driver's own rendering of a key pattern, matching the restore script's. */
function keyPattern(key: Record<string, unknown>): string {
  return Object.keys(key).join("+");
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
        const actual = new Set<string>();
        for (const collection of Object.values(COLLECTION_NAMES)) {
          const indexes = await db.collection(collection).indexes();
          for (const index of indexes) {
            if (index.unique === true) {
              actual.add(`${collection}:${keyPattern(index.key as Record<string, unknown>)}`);
            }
          }
        }

        const declared = new Set(
          list.indexes.map((entry) => `${entry.collection}:${keyPattern(entry.key)}`),
        );

        // ── Direction 1: the list names only real indexes ──
        const phantom = [...declared].filter((entry) => !actual.has(entry));
        assert.deepEqual(
          phantom,
          [],
          "the critical-index list names indexes the product does not create, so a good " +
            "restore would be reported as broken",
        );

        // ── Direction 2: the list is complete ──
        const unlisted = [...actual].filter((entry) => !declared.has(entry));
        assert.deepEqual(
          unlisted,
          [],
          "the product creates unique indexes the critical-index list omits, so those " +
            "guarantees are never verified after a restore — add them to " +
            "scripts/release/critical-indexes.json",
        );

        assert.ok(actual.size > 0, "the store created no unique index at all, so this proves nothing");
      } finally {
        await db.dropDatabase().catch(() => {});
        await client.close();
        await store.disconnect().catch(() => {});
      }
    });

    test("every entry states why the guarantee matters", () => {
      for (const entry of list.indexes) {
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

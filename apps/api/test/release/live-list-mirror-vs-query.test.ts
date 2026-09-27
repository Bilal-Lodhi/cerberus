/**
 * The mirror against the server: does `selectBounded` describe what MongoDB actually does?
 *
 * ── Why this file exists ──────────────────────────────────────────────
 *
 * The property test in `live-list-equivalence-generated.test.ts` runs the whole equivalence over
 * sixty generated fixtures, and it cannot put each one into a database without becoming a
 * database test. So the selection step there is a JavaScript mirror of the query, and a mirror is
 * exactly the kind of artefact that agrees with the code it was written beside while disagreeing
 * with the server.
 *
 * This file removes that risk by asking the server. For each fixture it writes the migrated
 * documents, runs the **real** filter — `buildLiveListFilter`, through the driver — and asserts the
 * documents that come back are the documents the mirror selected.
 *
 * Three properties of MongoDB's comparison semantics are what the mirror claims, and each is a
 * place a plausible-looking predicate would go wrong:
 *
 *   - `{ status: { $ne: "terminated" } }` matches a document whose `status` is absent, `null`, or a
 *     value the vocabulary never held — not just the two live statuses.
 *   - `{ updatedAt: { $gt: cutoff } }` compares within the **BSON type bracket**, so a document
 *     whose `updatedAt` is a string, a number, a boolean, an array, an object or absent is *not*
 *     matched by it. That is the reason `liveListUpdatedAt` exists.
 *   - `{ sessionId: { $in: [...] } }` matches by equality, and a document with no `sessionId`
 *     matches nothing.
 *
 * ── Gating ────────────────────────────────────────────────────────────
 *
 * Runs when `CERBERUS_TEST_MONGODB_URI` is set, and is **skipped with a stated reason** when it is
 * not. The CI integration job provides a `mongo:7` and asserts that nothing was skipped.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { MongoClient, type Db } from "mongodb";

import { MongoStore } from "../../../../packages/mcp-mongodb/src/mongo-client.js";
import { buildLiveListFilter } from "../../../../packages/mcp-mongodb/src/live-list-query.js";
import { COLLECTION_NAMES } from "../../../../packages/mcp-mongodb/src/tool-names.js";
import {
  generateFixtures,
  selectBounded,
  type GeneratedFixture,
} from "../support/bounded-select.js";

const REAL_MONGODB_URI = process.env["CERBERUS_TEST_MONGODB_URI"]?.trim() ?? "";

/**
 * How many fixtures are checked against the server.
 *
 * A subset, because each one needs its own contents in the collection — the filter's range
 * branches are not scoped to a fixture, so two fixtures' documents cannot be judged in one query.
 * The first fixtures are the ones the generator makes systematic (every status and every
 * `updatedAt` type), plus the ones that disable expiry, so the subset carries the coverage that
 * matters rather than an arbitrary prefix.
 */
const FIXTURES_TO_VERIFY = 14;

const FIXTURES = generateFixtures({ count: 60 }).slice(0, FIXTURES_TO_VERIFY);

/** The cutoff the route would compute for this fixture. */
function cutoffOf(fixture: GeneratedFixture): Date | null {
  if (!Number.isFinite(fixture.ttlSeconds) || fixture.ttlSeconds <= 0) return null;
  return new Date(fixture.nowMs - fixture.ttlSeconds * 1000);
}

if (REAL_MONGODB_URI) {
  describe("the bounded-selection mirror against a real server", () => {
    test("the mirror selects exactly the documents the query returns, for every fixture", async () => {
      const databaseName = `cerberus_mirror_${randomUUID().replace(/-/g, "")}`;
      const client = new MongoClient(REAL_MONGODB_URI);
      await client.connect();
      const db: Db = client.db(databaseName);

      const store = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });
      // Migrations are not what is being tested here, and the documents already carry the normal
      // form; the indexes are created so the query is planned the way a deployment plans it.
      await store.connect({ migrate: false });
      await store.ensureIndexes();

      const collection = db.collection(COLLECTION_NAMES.sessions);

      try {
        let comparedDocuments = 0;
        let comparedFixtures = 0;

        for (const fixture of FIXTURES) {
          await collection.deleteMany({});
          if (fixture.migratedDocuments.length > 0) {
            await collection.insertMany(fixture.migratedDocuments as never[], { ordered: false });
          }

          const localIds = fixture.localRows.map((row) => row.sessionId);
          const liveAfter = cutoffOf(fixture);

          const filter = buildLiveListFilter({ liveAfter, sessionIds: localIds });
          const returned = await collection
            .find(filter ?? {})
            .project({ sessionId: 1, _id: 0 })
            .toArray();

          const expected = selectBounded(fixture.migratedDocuments, {
            liveAfter,
            sessionIds: localIds,
          });

          const returnedIds = returned
            .map((document) => String(document["sessionId"] ?? ""))
            .sort();
          const expectedIds = expected
            .map((document) => String(document["sessionId"] ?? ""))
            .sort();

          assert.deepEqual(
            returnedIds,
            expectedIds,
            `${fixture.name}: the mirror and the server disagree about which documents the ` +
              "bounded query returns",
          );

          comparedDocuments += fixture.migratedDocuments.length;
          comparedFixtures += 1;
        }

        assert.equal(comparedFixtures, FIXTURES.length);
        assert.ok(
          comparedDocuments >= 50,
          `only ${comparedDocuments} documents were compared, which is too few for the agreement ` +
            "to mean anything",
        );
      } finally {
        await store.disconnect().catch(() => {});
        await db.dropDatabase().catch(() => {});
        await client.close();
      }
    });

    test("the mirror is not vacuous: the query returns some documents and refuses others", async () => {
      // A mirror that selected nothing, and a query that returned nothing, would agree perfectly.
      // This asserts that the fixtures exercised above contain both outcomes.
      let selected = 0;
      let refused = 0;

      for (const fixture of FIXTURES) {
        const chosen = selectBounded(fixture.migratedDocuments, {
          liveAfter: cutoffOf(fixture),
          sessionIds: fixture.localRows.map((row) => row.sessionId),
        });
        selected += chosen.length;
        refused += fixture.migratedDocuments.length - chosen.length;
      }

      assert.ok(selected > 0, "no fixture selected a document, so the comparison proves nothing");
      assert.ok(refused > 0, "no fixture refused a document, so the comparison proves nothing");
    });
  });
} else {
  test(
    "the bounded-selection mirror against a real server",
    { skip: "CERBERUS_TEST_MONGODB_URI is not set, so there is no server to compare against" },
    () => {},
  );
}

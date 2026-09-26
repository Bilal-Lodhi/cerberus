/**
 * The upgrade gate: a published release's database, migrated by this build.
 *
 * ── What this covers that nothing else does ───────────────────────────
 *
 * `migrations.test.ts` drives the migration *functions* against a fake collection and
 * `store-contract.test.ts` verifies the store's methods. Neither walks the thing an
 * operator actually does: take a database as a **published release** left it, run the
 * documented upgrade, and check the result.
 *
 * That gap is where a release breaks. The unique index on `(sessionId, eventId)` cannot be
 * built while duplicates exist — which is why migrations run before indexes, a deliberate
 * ordering that only a real database can prove. A field rename has to keep the larger of
 * two values, which only a mixed document can show. And a re-run has to be a no-op, which
 * only the ledger can establish.
 *
 * ── The fixture is described once ─────────────────────────────────────
 *
 * The historical shape lives in `apps/api/test/support/release-fixture.ts`, derived from
 * the published release notes rather than from the code — which is the point, because the
 * code has moved on. A hand-built one-off test drifts from the state it claims to
 * represent and keeps passing.
 *
 * ── Gating ────────────────────────────────────────────────────────────
 *
 * Runs when `CERBERUS_TEST_MONGODB_URI` is set, and is **skipped with a stated reason**
 * when it is not. CI provides a `mongo:7` service, and the integration job asserts that
 * nothing was skipped. Each test gets its own disposable database, dropped afterwards.
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { MongoClient, type Db } from "mongodb";

import { MongoStore } from "../../../../packages/mcp-mongodb/src/mongo-client.js";
import { MIGRATIONS } from "../../../../packages/mcp-mongodb/src/migrations.js";
import { COLLECTION_NAMES } from "../../../../packages/mcp-mongodb/src/tool-names.js";
import {
  PUBLISHED_RELEASES,
  RELEASE_SHAPES,
  seedPublishedRelease,
  type PublishedRelease,
} from "../support/release-fixture.js";

const REAL_MONGODB_URI = process.env["CERBERUS_TEST_MONGODB_URI"]?.trim() ?? "";

/** The migration ids this build knows, so a fixture claim can be checked against them. */
const KNOWN_MIGRATION_IDS = MIGRATIONS.map((migration) => migration.id);

/**
 * A disposable database, seeded with one release's shape, and a store over it.
 *
 * The store connects with `migrate: false` — the same way the migration CLI does — so the
 * plan an operator inspects is still there to inspect.
 */
async function withRelease(
  release: PublishedRelease,
  run: (context: {
    db: Db;
    store: MongoStore;
    databaseName: string;
    fixture: Awaited<ReturnType<typeof seedPublishedRelease>>;
  }) => Promise<void>,
): Promise<void> {
  const databaseName = `cerberus_release_${randomUUID().replace(/-/g, "")}`;
  const client = new MongoClient(REAL_MONGODB_URI);
  await client.connect();
  const db = client.db(databaseName);

  const store = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });
  await store.connect({ migrate: false });

  try {
    const fixture = await seedPublishedRelease(db, release);
    await run({ db, store, databaseName, fixture });
  } finally {
    await store.disconnect().catch(() => {});
    await db.dropDatabase().catch(() => {});
    await client.close();
  }
}

/** Documents in `collection` matching `filter`. */
async function count(db: Db, collection: string, filter: Record<string, unknown> = {}): Promise<number> {
  return db.collection(collection).countDocuments(filter as never);
}

if (REAL_MONGODB_URI) {
  describe("upgrading a published release's database", () => {
    // The fixture claims to be these migrations' starting point, so the ids it names have
    // to be the ids this build actually has. A renamed migration would make the fixture
    // describe a state that cannot exist — which is exactly the drift a hand-built
    // migration test is prone to.
    for (const release of PUBLISHED_RELEASES) {
      for (const migrationId of RELEASE_SHAPES[release].appliedMigrations) {
        assert.ok(
          KNOWN_MIGRATION_IDS.includes(migrationId),
          `the ${release} fixture names '${migrationId}', which this build does not have`,
        );
      }
    }

    // ── v0.2.0: the upgrade that does real work ─────────────────────

    test("v0.2.0 — the dry run reports the pending migrations and changes nothing", async () => {
      await withRelease("v0.2.0", async ({ db, store, fixture }) => {
        const assessmentsBefore = await count(db, COLLECTION_NAMES.riskAssessments);

        const plan = await store.runMigrations({ dryRun: true });

        const pending = plan.plan.filter((entry) => entry.state === "pending").map((entry) => entry.id);
        assert.deepEqual(
          pending,
          ["0002-dedupe-risk-assessment-identity", "0003-rename-fullscreen-exit-to-focus-loss"],
          "the dry run did not report the migrations this release left pending",
        );
        assert.deepEqual(plan.applied, [], "a dry run applied something");
        assert.equal(plan.dryRun, true);

        assert.equal(
          await count(db, COLLECTION_NAMES.riskAssessments),
          assessmentsBefore,
          "a dry run changed the database",
        );
        assert.equal(
          (await db.collection(COLLECTION_NAMES.sessions).findOne({ sessionId: fixture.sessionId }))?.[
            "fullscreenExitCount"
          ],
          4,
          "a dry run renamed a field",
        );
      });
    });

    test("v0.2.0 — migrating removes the duplicate identity and renames the counter", async () => {
      await withRelease("v0.2.0", async ({ db, store, fixture }) => {
        assert.equal(
          await count(db, COLLECTION_NAMES.riskAssessments, {
            riskAssessmentId: fixture.assessmentId,
          }),
          2,
          "the fixture did not seed the duplicate identity the migration exists to remove",
        );

        const result = await store.runMigrations();

        assert.deepEqual(
          result.applied,
          ["0002-dedupe-risk-assessment-identity", "0003-rename-fullscreen-exit-to-focus-loss"],
        );

        // ── The duplicate is gone ──
        assert.equal(
          await count(db, COLLECTION_NAMES.riskAssessments, {
            riskAssessmentId: fixture.assessmentId,
          }),
          1,
          "the duplicate assessment identity survived the migration",
        );

        // ── The field is renamed, and the larger of the two values kept ──
        const session = await db
          .collection(COLLECTION_NAMES.sessions)
          .findOne({ sessionId: fixture.sessionId });
        assert.ok(session);
        assert.equal(
          session["focusLossCount"],
          4,
          "the rename lost the larger of the two values the fixture held",
        );
        assert.equal(
          session["fullscreenExitCount"],
          undefined,
          "the legacy field survived the rename",
        );

        // ── The ledger records what ran ──
        const ledger = await db
          .collection(COLLECTION_NAMES.schemaMigrations)
          .find({})
          .toArray();
        assert.deepEqual(
          ledger.map((row) => row["migrationId"]).sort(),
          [...KNOWN_MIGRATION_IDS].sort(),
          "the ledger does not record every migration as applied",
        );
      });
    });

    test("v0.2.0 — the unique indexes can be built once the duplicates are gone", async () => {
      await withRelease("v0.2.0", async ({ store }) => {
        await store.runMigrations();

        // The ordering this asserts is the one that only a real database can prove: the
        // index on `riskAssessmentId` cannot exist while two rows share one, so
        // `ensureIndexes` fails unless the migration ran first.
        await assert.doesNotReject(
          () => store.ensureIndexes(),
          "the unique index could not be built after the migration",
        );
      });
    });

    test("v0.2.0 — re-running the migrations is a no-op", async () => {
      await withRelease("v0.2.0", async ({ db, store }) => {
        await store.runMigrations();

        const assessmentsAfterFirstRun = await count(db, COLLECTION_NAMES.riskAssessments);

        const second = await store.runMigrations();

        assert.deepEqual(second.applied, [], "a second run applied something");
        assert.deepEqual(
          second.plan.filter((entry) => entry.state === "pending"),
          [],
          "a second run reported something pending",
        );
        assert.equal(
          await count(db, COLLECTION_NAMES.riskAssessments),
          assessmentsAfterFirstRun,
          "a second run removed more documents",
        );
      });
    });

    test("v0.2.0 — the upgraded data is readable through the store", async () => {
      await withRelease("v0.2.0", async ({ store, fixture }) => {
        await store.runMigrations();

        const session = await store.getSession(fixture.sessionId);
        assert.ok(session, "the session is unreadable after the upgrade");
        assert.equal(
          session["focusLossCount"],
          4,
          "the counter the migration renamed is not readable under its new name",
        );

        const assessments = await store.getRiskAssessments(fixture.sessionId);
        assert.equal(assessments.length, 1, "the assessment history is not readable");
      });
    });

    // ── v0.3.0: the upgrade that is already complete ────────────────

    test("v0.3.0 — nothing is pending, and a run applies nothing", async () => {
      await withRelease("v0.3.0", async ({ store }) => {
        const plan = await store.runMigrations({ dryRun: true });
        assert.deepEqual(
          plan.plan.filter((entry) => entry.state === "pending"),
          [],
          "the previous release left a migration pending",
        );

        const result = await store.runMigrations();
        assert.deepEqual(result.applied, [], "the upgrade was not a no-op");
      });
    });

    test("v0.3.0 — the connection path applies migrations and indexes in one step", async () => {
      await withRelease("v0.3.0", async ({ db, databaseName }) => {
        // The documented path for a normal deployment: `connect()` runs migrations and
        // then creates the indexes. A second store over the same database proves it is
        // idempotent end to end.
        const second = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });
        await assert.doesNotReject(
          () => second.connect(),
          "the documented connect path failed on an already-current database",
        );
        await second.disconnect();

        const indexes = await db.collection(COLLECTION_NAMES.riskAssessments).indexes();
        assert.ok(
          indexes.some((index) => index.unique === true),
          "the unique identity index is missing after connect()",
        );
      });
    });
  });
} else {
  // Reported as **skipped with the reason**, not as a passing test. A suite that reported
  // a pass here would be green for the wrong reason — it verified nothing — and the
  // integration job in CI asserts that nothing was skipped, because it provides the only
  // precondition this file has.
  test(
    "upgrading a published release's database",
    { skip: "CERBERUS_TEST_MONGODB_URI is not set, so there is no database to upgrade" },
    () => {},
  );
}

after(() => {
  // Nothing global to tear down: every test owns a disposable database and drops it.
});

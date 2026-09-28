/**
 * Migration `0005` against a real database: the upgrade gate for the live-list normal form.
 *
 * ── What this covers that nothing else does ───────────────────────────
 *
 * `live-list-normalisation.test.ts` proves the *decision* — that the normal form preserves the
 * durable-only liveness rule at every clock — without a database. This file proves the part
 * only a real server can: that the decision survives a round trip through BSON, that the write
 * changes exactly two fields and nothing else, that a re-run is a genuine no-op at the storage
 * layer (`modifiedCount` of zero, not merely "no ledger row"), that the compare-and-set guard
 * refuses to overwrite a document that changed underneath the scan, and that the dry run's
 * numbers are the applied run's numbers.
 *
 * ── Why the adversarial fixture rather than a realistic one ────────────
 *
 * Every row of `ADVERSARIAL_SESSION_ROWS` is a document the current reader has a definite
 * answer for, including shapes no Cerberus code path can produce. A migration whose fixture is
 * all happy-path documents proves that it works on the documents that never needed it.
 *
 * ── Gating ────────────────────────────────────────────────────────────
 *
 * Runs when `CERBERUS_TEST_MONGODB_URI` is set, and is **skipped with a stated reason** when it
 * is not. The CI integration job provides a `mongo:7` and asserts that nothing was skipped.
 * Each test gets its own disposable database, dropped afterwards.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { MongoClient, type Db } from "mongodb";

import { MongoStore } from "../../../../packages/mcp-mongodb/src/mongo-client.js";
import {
  MIGRATIONS,
  normaliseSessionListFields,
  type SessionListNormalisationReport,
} from "../../../../packages/mcp-mongodb/src/migrations.js";
import {
  buildSessionListGuard,
  buildSessionListUpdate,
  MAX_LIVENESS_INSTANT,
  planSessionListNormalisation,
} from "../../../../packages/mcp-mongodb/src/session-list-normalisation.js";
import { COLLECTION_NAMES } from "../../../../packages/mcp-mongodb/src/tool-names.js";
import { reconcileLiveList } from "../../src/services/session-reconciliation.js";
import {
  ADVERSARIAL_NOW_MS,
  ADVERSARIAL_SESSION_ROWS,
  ADVERSARIAL_TTL_SECONDS,
  seedV061AdversarialFixture,
  toApiDocument,
} from "../support/release-fixture.js";

const REAL_MONGODB_URI = process.env["CERBERUS_TEST_MONGODB_URI"]?.trim() ?? "";

const MIGRATION_ID = "0005-normalise-session-list-fields";

/**
 * A disposable database seeded with the adversarial session rows, plus a store over it.
 *
 * The store connects with `migrate: false`, the way the migration CLI does, so the plan an
 * operator inspects is still there to inspect.
 */
async function withAdversarialSessions(
  run: (context: { db: Db; store: MongoStore; databaseName: string }) => Promise<void>,
): Promise<void> {
  const databaseName = `cerberus_live_list_migration_${randomUUID().replace(/-/g, "")}`;
  const client = new MongoClient(REAL_MONGODB_URI);
  await client.connect();
  const db = client.db(databaseName);

  const store = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });
  await store.connect({ migrate: false });

  try {
    await seedV061AdversarialFixture(db);
    await run({ db, store, databaseName });
  } finally {
    await store.disconnect().catch(() => {});
    await db.dropDatabase().catch(() => {});
    await client.close();
  }
}

/** Every session document, as the API would see it. */
async function wireDocuments(db: Db): Promise<Record<string, unknown>[]> {
  const stored = await db.collection(COLLECTION_NAMES.sessions).find({}).toArray();
  return stored.map(toApiDocument);
}

/** The document for one `sessionId`, or the one with no `sessionId` at all. */
function rowFor(
  documents: readonly Record<string, unknown>[],
  sessionId: string | null,
): Record<string, unknown> | undefined {
  if (sessionId === null) return documents.find((document) => !("sessionId" in document));
  return documents.find((document) => document["sessionId"] === sessionId);
}

/** Collects the migration's log lines instead of printing them. */
function collectingLog(): { lines: string[]; log: (message: string) => void } {
  const lines: string[] = [];
  return { lines, log: (message) => lines.push(message) };
}

/** The counts a report states, without the one that differs between dry run and apply. */
function comparableReport(report: SessionListNormalisationReport): Record<string, number> {
  const { modifiedRows: _modified, ...rest } = report;
  return rest;
}

if (REAL_MONGODB_URI) {
  describe("0005 — the live-list normal form", () => {
    test("is the last migration in the registry", () => {
      // The append-only rule: an id is never reused and order comes from position, so a new
      // migration is only ever added at the end. This is also the assertion the `0004` test used
      // to make about itself, moved to where it stays true.
      assert.equal(MIGRATIONS[MIGRATIONS.length - 1]?.id, MIGRATION_ID);
    });

    test("a run interrupted part-way converges on the next run", async () => {
      // The failure mode the ledger cannot see. A migration that crashed after normalising some
      // documents recorded nothing — the ledger row is written **after** the work — so the next
      // run finds the migration pending and must complete it without disturbing what the first
      // run did. Simulated by normalising half the documents by hand and leaving no ledger row,
      // which is exactly the state a crash leaves.
      await withAdversarialSessions(async ({ db, store }) => {
        const collection = db.collection(COLLECTION_NAMES.sessions);
        const stored = await collection.find({}).toArray();
        const interruptedAt = Math.floor(stored.length / 2);

        for (const document of stored.slice(0, interruptedAt)) {
          const plan = planSessionListNormalisation(document as Record<string, unknown>);
          const update = buildSessionListUpdate(plan);
          if (update) await collection.updateOne({ _id: document["_id"] }, update as never);
        }

        const ledgerBefore = await db
          .collection(COLLECTION_NAMES.schemaMigrations)
          .countDocuments({ migrationId: MIGRATION_ID });
        assert.equal(
          ledgerBefore,
          0,
          "the interrupted state already carries a ledger row, so this is not the state a crash leaves",
        );

        // The next run completes it. `runMigrations` does not know which documents the first run
        // reached, and does not need to: every write is idempotent, so re-normalising the ones it
        // already did is a no-op.
        const result = await store.runMigrations();
        assert.ok(
          result.applied.includes(MIGRATION_ID),
          "a run that found the migration pending did not apply it",
        );

        const after = await wireDocuments(db);
        for (const document of after) {
          const status = document["status"];
          assert.ok(
            status === "active" || status === "locked" || status === "terminated",
            `a document was left with status ${JSON.stringify(status)} after the completing run`,
          );
          assert.ok(
            Number.isFinite(Date.parse(String(document["liveListUpdatedAt"]))),
            "a document was left without a usable liveListUpdatedAt after the completing run",
          );
        }

        // And the ledger now records it, exactly once.
        assert.equal(
          await db
            .collection(COLLECTION_NAMES.schemaMigrations)
            .countDocuments({ migrationId: MIGRATION_ID }),
          1,
        );
      });
    });

    test("an interrupted run's partial work is not rewritten", async () => {
      // The other half of convergence: the documents the first run reached are **already** in the
      // normal form, so the completing run must plan no write for them. Asserted through the
      // migration's own report rather than by comparing documents, because "it did not need to
      // write" and "it wrote the same value" are different claims.
      await withAdversarialSessions(async ({ db, store }) => {
        const collection = db.collection(COLLECTION_NAMES.sessions);
        const stored = await collection.find({}).toArray();

        for (const document of stored) {
          const plan = planSessionListNormalisation(document as Record<string, unknown>);
          const update = buildSessionListUpdate(plan);
          if (update) await collection.updateOne({ _id: document["_id"] }, update as never);
        }

        // Every document is normal and the ledger is empty: the state a crash *after* the work
        // but *before* the ledger write leaves.
        const log = collectingLog();
        const report = await normaliseSessionListFields(db, { apply: true, log: log.log });
        assert.equal(report.totalRows, stored.length);
        assert.equal(report.rewrittenRows, 0, "the completing run planned a write");
        assert.equal(report.modifiedRows, 0, "the completing run modified a document");
      });
    });

    test("the dry run reports the same categories as the applied run, and writes nothing", async () => {
      await withAdversarialSessions(async ({ db, store }) => {
        const before = await wireDocuments(db);

        const plan = await store.runMigrations({ dryRun: true });
        assert.deepEqual(
          plan.plan.filter((entry) => entry.state === "pending").map((entry) => entry.id),
          [MIGRATION_ID],
          "the v0.6.1 database is not left with exactly one migration pending",
        );
        assert.deepEqual(plan.applied, [], "a dry run applied something");

        assert.deepEqual(
          await wireDocuments(db),
          before,
          "a dry run changed a session document",
        );

        // The accounting itself, from the same code path the applied run uses. A dry run whose
        // numbers came from a second implementation could agree today and drift tomorrow.
        const dryLog = collectingLog();
        const dryReport = await normaliseSessionListFields(db, { apply: false, log: dryLog.log });
        assert.equal(dryReport.modifiedRows, 0, "a dry run modified a document");
        assert.ok(dryLog.lines.length >= 2, "the dry run reported nothing");

        const appliedLog = collectingLog();
        const appliedReport = await normaliseSessionListFields(db, {
          apply: true,
          log: appliedLog.log,
        });

        assert.deepEqual(
          comparableReport(appliedReport),
          comparableReport(dryReport),
          "the dry run's accounting differs from the applied run's",
        );
        assert.ok(appliedReport.modifiedRows > 0, "the applied run modified nothing");
        assert.equal(
          appliedReport.totalRows,
          ADVERSARIAL_SESSION_ROWS.length,
          "the migration did not examine every seeded document",
        );
      });
    });

    test("applying it normalises both fields and changes nothing else", async () => {
      await withAdversarialSessions(async ({ db, store }) => {
        const before = await wireDocuments(db);

        const result = await store.runMigrations();
        assert.deepEqual(result.applied, [MIGRATION_ID]);

        const after = await wireDocuments(db);

        for (const row of ADVERSARIAL_SESSION_ROWS) {
          const original = rowFor(before, row.sessionId);
          const migrated = rowFor(after, row.sessionId);
          assert.ok(original && migrated, `${row.label}: the document disappeared`);

          // ── The two fields the migration owns ──
          const status = migrated!["status"];
          assert.ok(
            status === "active" || status === "locked" || status === "terminated",
            `${row.label}: status is ${JSON.stringify(status)}, which is not a durable status`,
          );

          const instant = migrated!["liveListUpdatedAt"];
          // On the wire a BSON `Date` is an ISO string, exactly as `updatedAt` is.
          assert.equal(
            typeof instant,
            "string",
            `${row.label}: liveListUpdatedAt is ${typeof instant} on the wire`,
          );
          assert.ok(
            Number.isFinite(Date.parse(String(instant))),
            `${row.label}: liveListUpdatedAt does not parse as an instant`,
          );

          // ── And every other field is byte-identical ──
          //
          // The two fields the migration owns are removed from both sides and everything that
          // is left must compare equal — which is what makes "it does not touch `updatedAt`"
          // an assertion rather than a comment. `updatedAt`, `deployedAt` and `createdAt` are
          // all inside this comparison, and the model's §9.3 is the reason they must be.
          const withoutNormalForm = (document: Record<string, unknown>) => {
            const { liveListUpdatedAt: _instant, status: _status, ...rest } = document;
            return rest;
          };
          assert.deepEqual(
            withoutNormalForm(migrated!),
            withoutNormalForm(original!),
            `${row.label}: the migration changed a field outside the normal form`,
          );
        }
      });
    });

    test("the status it writes is the status the reconciler was already computing", async () => {
      await withAdversarialSessions(async ({ db, store }) => {
        await store.runMigrations();
        const after = await wireDocuments(db);

        const expectations: ReadonlyArray<[string, string | null]> = [
          ["status active", "active"],
          ["status locked", "locked"],
          ["status terminated", "terminated"],
          ["status missing", "active"],
          ["status null", "active"],
          ["status unknown (cleared)", "active"],
          ["status unknown (flagged)", "active"],
          // Case-sensitive: this one is *not* terminal, and must not be rewritten to it.
          ["status case variant (Terminated)", "active"],
          ["status wrong type (number)", "active"],
          ["status empty string", "active"],
        ];

        for (const [label, expected] of expectations) {
          const row = ADVERSARIAL_SESSION_ROWS.find((candidate) => candidate.label === label);
          assert.ok(row, `the fixture no longer has a row labelled "${label}"`);
          const document = rowFor(after, row!.sessionId);
          assert.equal(document?.["status"], expected, `${label}: status`);
        }
      });
    });

    test("a document with no verifiable instant keeps the never-expires sentinel", async () => {
      await withAdversarialSessions(async ({ db, store }) => {
        await store.runMigrations();
        const after = await wireDocuments(db);

        for (const label of [
          "updatedAt unparseable string",
          "updatedAt empty string",
          "updatedAt boolean",
          "updatedAt object",
          "deployedAt empty string blocks createdAt (permanently live)",
          "no updatedAt, no deployedAt, no createdAt (permanently live)",
        ]) {
          const row = ADVERSARIAL_SESSION_ROWS.find((candidate) => candidate.label === label);
          assert.ok(row, `the fixture no longer has a row labelled "${label}"`);
          const document = rowFor(after, row!.sessionId);
          assert.equal(
            Date.parse(String(document?.["liveListUpdatedAt"])),
            MAX_LIVENESS_INSTANT,
            `${label}: the stored instant is not the sentinel, so the row will expire`,
          );
        }
      });
    });

    test("the normal form makes the predicate total: sentinel > cutoff is equivalent to being listed", async () => {
      await withAdversarialSessions(async ({ db, store }) => {
        await store.runMigrations();
        const after = await wireDocuments(db);

        // The predicate the bounded query will use, evaluated over what is actually stored.
        for (const nowMs of [
          ADVERSARIAL_NOW_MS,
          ADVERSARIAL_NOW_MS + 365 * 24 * 3600 * 1000,
        ]) {
          const cutoff = nowMs - ADVERSARIAL_TTL_SECONDS * 1000;

          for (const row of ADVERSARIAL_SESSION_ROWS) {
            const document = rowFor(after, row.sessionId);
            assert.ok(document, `${row.label}: the document disappeared`);

            const status = String(document!["status"] ?? "");
            const instant = Date.parse(String(document!["liveListUpdatedAt"]));
            const usable = String(document!["sessionId"] ?? "").length > 0;
            const predicate =
              usable && (status === "active" || status === "locked") && instant > cutoff;

            const listed =
              reconcileLiveList([], [document!], {
                ttlSeconds: ADVERSARIAL_TTL_SECONDS,
                nowMs,
                alertThreshold: 1000,
              }).sessions.length === 1;

            assert.equal(
              listed,
              predicate,
              `${row.label}: stored predicate says ${predicate} but the reconciler listed it ${listed}`,
            );
          }
        }
      });
    });

    test("a second run modifies nothing, at the storage layer", async () => {
      await withAdversarialSessions(async ({ db, store }) => {
        await store.runMigrations();

        const second = await store.runMigrations();
        assert.deepEqual(second.applied, [], "a second run applied something");
        assert.deepEqual(
          second.plan.filter((entry) => entry.state === "pending"),
          [],
          "a second run reported something pending",
        );

        // Through the migration's own function rather than the ledger, so "no-op" means
        // `modifiedCount === 0` and not merely "the ledger said it was already applied".
        const log = collectingLog();
        const report = await normaliseSessionListFields(db, { apply: true, log: log.log });
        assert.equal(report.modifiedRows, 0, "a re-run rewrote a document");
        assert.equal(report.rewrittenRows, 0, "a re-run planned a write");
        assert.equal(
          report.unchangedRows,
          report.totalRows,
          "a re-run found documents that were not already in the normal form",
        );
      });
    });

    test("a document that changed under the scan is not overwritten by the stale plan", async () => {
      await withAdversarialSessions(async ({ db }) => {
        const collection = db.collection(COLLECTION_NAMES.sessions);
        const sessionId = "adv-status-cleared";

        // A plan computed from the document as the scan saw it.
        const asRead = await collection.findOne({ sessionId });
        assert.ok(asRead);
        const plan = planSessionListNormalisation(asRead as Record<string, unknown>);
        const update = buildSessionListUpdate(plan);
        assert.ok(update, "the fixture row no longer needs normalising");

        // Meanwhile the application transitions the session. A migration that wrote
        // unconditionally would now overwrite `locked` with the `active` it computed.
        await collection.updateOne(
          { sessionId },
          { $set: { status: "locked", updatedAt: new Date(ADVERSARIAL_NOW_MS) } },
        );

        const guarded = await collection.updateOne(
          buildSessionListGuard(asRead as Record<string, unknown>, plan),
          update!,
        );
        assert.equal(guarded.matchedCount, 0, "the stale plan overwrote a concurrent transition");

        const current = await collection.findOne({ sessionId });
        assert.equal(current?.["status"], "locked", "the concurrent transition was lost");
      });
    });

    test("a document that did not change is still normalised by the same guarded write", async () => {
      await withAdversarialSessions(async ({ db }) => {
        const collection = db.collection(COLLECTION_NAMES.sessions);
        const sessionId = "adv-status-flagged";

        const asRead = await collection.findOne({ sessionId });
        assert.ok(asRead);
        const plan = planSessionListNormalisation(asRead as Record<string, unknown>);
        const update = buildSessionListUpdate(plan);
        assert.ok(update);

        const guarded = await collection.updateOne(
          buildSessionListGuard(asRead as Record<string, unknown>, plan),
          update!,
        );
        assert.equal(guarded.matchedCount, 1, "the guard refused an unchanged document");

        const current = await collection.findOne({ sessionId });
        assert.equal(current?.["status"], "active");
        assert.ok(current?.["liveListUpdatedAt"] instanceof Date);
      });
    });

    test("the ledger records it, and connect() is idempotent afterwards", async () => {
      await withAdversarialSessions(async ({ db, databaseName }) => {
        const store = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });
        await assert.doesNotReject(
          () => store.connect(),
          "the documented connect path failed on a v0.6.1 database",
        );
        await store.disconnect();

        const ledger = await db
          .collection(COLLECTION_NAMES.schemaMigrations)
          .find({})
          .toArray();
        assert.deepEqual(
          ledger.map((row) => String(row["migrationId"])).sort(),
          MIGRATIONS.map((migration) => migration.id).sort(),
          "the ledger does not record every migration as applied",
        );

        // And a second `connect()` — migrations, then indexes — is still a no-op.
        const second = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });
        await assert.doesNotReject(
          () => second.connect(),
          "a second connect failed, so the migration and the index declarations disagree",
        );
        await second.disconnect();
      });
    });
  });
} else {
  // A skip, not a pass: this file verifies nothing without a database, and the integration job
  // asserts that nothing was skipped there.
  test(
    "0005 — the live-list normal form",
    { skip: "CERBERUS_TEST_MONGODB_URI is not set, so there is no database to migrate" },
    () => {},
  );
}

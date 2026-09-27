/**
 * Schema and data migrations.
 *
 * `classifyDuplicateGroups` decides which documents may be deleted, so it is the
 * part of the migration that can destroy data and the part that is tested hardest.
 * The runner is tested against a fake `Db` that implements only the four
 * operations the migration uses, because the interesting logic is the ordering,
 * the ledger and the refusal — not MongoDB's aggregation.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "mongodb";
// `MongoServerError` is a runtime class, not a type: the fake collection below throws a
// real one so the runner's `instanceof` check is exercised rather than a lookalike that
// happens to carry the same code.
import { MongoServerError } from "mongodb";

import {
  MIGRATIONS,
  MIGRATIONS_COLLECTION,
  MigrationConflictError,
  UnknownMigrationError,
  classifyDuplicateGroups,
  planMigrations,
  readAppliedMigrations,
  runMigrations,
} from "../../../packages/mcp-mongodb/src/migrations.js";
import { OPERATION_CLAIM_INDEXES } from "../../../packages/mcp-mongodb/src/operation-claims.js";

/** A document as it would come back from MongoDB. */
function doc(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: id,
    sessionId: "ses-1",
    eventId: "evt-1",
    eventType: "KEYSTROKE",
    payload: { deltaMs: 120 },
    _ingestedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════════════
// classifyDuplicateGroups — the data-safety decision
// ═══════════════════════════════════════════════════════════════════

describe("classifyDuplicateGroups", () => {
  test("identical copies are removable, keeping the earliest", () => {
    const { removableIds, conflictKeys } = classifyDuplicateGroups([
      { key: "ses-1/evt-1", docs: [doc("b"), doc("a"), doc("c")] },
    ]);

    assert.deepEqual(conflictKeys, []);
    assert.deepEqual(removableIds, ["b", "c"], "the earliest _id must be kept");
  });

  test("copies that disagree are a conflict, and nothing is removable", () => {
    const { removableIds, conflictKeys } = classifyDuplicateGroups([
      {
        key: "ses-1/evt-1",
        docs: [doc("a"), doc("b", { payload: { deltaMs: 999 } })],
      },
    ]);

    assert.deepEqual(removableIds, []);
    assert.deepEqual(conflictKeys, ["ses-1/evt-1"]);
  });

  test("a different payload is a conflict, not a duplicate", () => {
    // The whole safety property: removing either version would lose data.
    const { removableIds } = classifyDuplicateGroups([
      {
        key: "k",
        docs: [
          doc("a", { payload: { pasteContent: "first" } }),
          doc("b", { payload: { pasteContent: "second" } }),
        ],
      },
    ]);
    assert.deepEqual(removableIds, []);
  });

  test("a different event type is a conflict", () => {
    const { removableIds } = classifyDuplicateGroups([
      { key: "k", docs: [doc("a"), doc("b", { eventType: "PASTE" })] },
    ]);
    assert.deepEqual(removableIds, []);
  });

  test("_ingestedAt differences are ignored", () => {
    // Two copies written by a retry arrive at different times. That is not a
    // difference in the event.
    const { removableIds, conflictKeys } = classifyDuplicateGroups([
      {
        key: "k",
        docs: [
          doc("a", { _ingestedAt: new Date("2026-01-01T00:00:00.000Z") }),
          doc("b", { _ingestedAt: new Date("2026-06-01T00:00:00.000Z") }),
        ],
      },
    ]);

    assert.deepEqual(conflictKeys, []);
    assert.deepEqual(removableIds, ["b"]);
  });

  test("nested object key order does not create a false conflict", () => {
    // BSON round trips do not guarantee key order, so a naive JSON comparison
    // would report identical payloads as conflicting.
    const { removableIds, conflictKeys } = classifyDuplicateGroups([
      {
        key: "k",
        docs: [
          doc("a", { payload: { alpha: 1, beta: 2 } }),
          doc("b", { payload: { beta: 2, alpha: 1 } }),
        ],
      },
    ]);

    assert.deepEqual(conflictKeys, []);
    assert.deepEqual(removableIds, ["b"]);
  });

  test("array order is significant", () => {
    // Arrays are ordered data; [1,2] and [2,1] are different payloads.
    const { removableIds } = classifyDuplicateGroups([
      { key: "k", docs: [doc("a", { tags: [1, 2] }), doc("b", { tags: [2, 1] })] },
    ]);
    assert.deepEqual(removableIds, []);
  });

  test("a group of one is left alone", () => {
    const { removableIds, conflictKeys } = classifyDuplicateGroups([
      { key: "k", docs: [doc("a")] },
    ]);
    assert.deepEqual(removableIds, []);
    assert.deepEqual(conflictKeys, []);
  });

  test("an empty group list is a no-op", () => {
    assert.deepEqual(classifyDuplicateGroups([]), {
      removableIds: [],
      conflictKeys: [],
    });
  });

  test("one conflicting group does not stop the others being cleaned", () => {
    // The caller refuses the whole migration when any conflict exists, but the
    // classification must still report both accurately.
    const { removableIds, conflictKeys } = classifyDuplicateGroups([
      { key: "clean", docs: [doc("a"), doc("b")] },
      { key: "dirty", docs: [doc("c"), doc("d", { eventType: "PASTE" })] },
    ]);

    assert.deepEqual(conflictKeys, ["dirty"]);
    assert.deepEqual(removableIds, ["b"]);
  });

  test("every copy in a large group is checked, not just the second", () => {
    // A group where only the last copy differs must still be a conflict.
    const { removableIds, conflictKeys } = classifyDuplicateGroups([
      {
        key: "k",
        docs: [doc("a"), doc("b"), doc("c"), doc("d", { payload: { deltaMs: 1 } })],
      },
    ]);

    assert.deepEqual(removableIds, []);
    assert.deepEqual(conflictKeys, ["k"]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════════

interface FakeDb {
  db: Db;
  ledger: Array<Record<string, unknown>>;
  deletedIdBatches: unknown[][];
  riskAssessmentDeletedIdBatches: unknown[][];
  aggregateCalls: () => number;
  riskAssessmentAggregateCalls: () => number;
  sessionCountCalls: () => number;
  sessionUpdateCalls: () => number;
  ledgerIndexCalls: () => number;
  /** How many times a migration opened a cursor over `monitored_sessions`. */
  sessionFindCalls: () => number;
  /** Every guarded session write a migration attempted, in order. */
  sessionWrites: () => Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }>;
  /** Every index the claim migration created, in order, as `key -> options`. */
  claimIndexCalls: () => Array<{ key: Record<string, number>; options: Record<string, unknown> }>;
}

/**
 * A `Db` stand-in implementing only what the migration and the ledger use.
 *
 * Deliberately narrow: if a migration reaches for an operation this does not have,
 * the test fails loudly rather than the fake silently returning nothing.
 *
 * Each collection's `aggregate`/`deleteMany` is tracked separately, so a test can
 * assert what one migration touched without the other's calls being counted.
 */
function fakeDb(options: {
  applied?: Array<Record<string, unknown>>;
  groups?: Array<{
    _id: { sessionId: string; eventId: string };
    count: number;
    docs: Array<Record<string, unknown>>;
  }>;
  /** Duplicate groups for `risk_assessments`, keyed by `riskAssessmentId`. */
  /** How many session documents carry the legacy focus-loss field. */
  legacyFocusLossDocs?: number;
  /**
   * The session documents migration `0005` reads.
   *
   * Supplied by the caller rather than invented here, because the whole point of `0005` is that
   * its behaviour depends on what the documents hold — a fake that returned a fixed shape would
   * test the fake.
   */
  sessionDocuments?: Array<Record<string, unknown>>;
  riskAssessmentGroups?: Array<{
    _id: string;
    count: number;
    docs: Array<Record<string, unknown>>;
  }>;
} = {}): FakeDb {
  const ledger = [...(options.applied ?? [])];
  const deletedIdBatches: unknown[][] = [];
  const riskAssessmentDeletedIdBatches: unknown[][] = [];
  let aggregateCalls = 0;
  let riskAssessmentAggregateCalls = 0;
  let sessionCountCalls = 0;
  let sessionUpdateCalls = 0;
  let sessionFindCalls = 0;
  let ledgerIndexCalls = 0;
  const sessionWrites: Array<{
    filter: Record<string, unknown>;
    update: Record<string, unknown>;
  }> = [];
  const claimIndexCalls: Array<{
    key: Record<string, number>;
    options: Record<string, unknown>;
  }> = [];

  const microEvents = {
    aggregate() {
      aggregateCalls++;
      return { toArray: async () => options.groups ?? [] };
    },
    async deleteMany(filter: { _id: { $in: unknown[] } }) {
      deletedIdBatches.push(filter._id.$in);
      return { deletedCount: filter._id.$in.length };
    },
  };

  const riskAssessments = {
    aggregate() {
      riskAssessmentAggregateCalls++;
      return { toArray: async () => options.riskAssessmentGroups ?? [] };
    },
    async deleteMany(filter: { _id: { $in: unknown[] } }) {
      riskAssessmentDeletedIdBatches.push(filter._id.$in);
      return { deletedCount: filter._id.$in.length };
    },
  };

  const monitoredSessions = {
    async countDocuments() {
      sessionCountCalls++;
      return options.legacyFocusLossDocs ?? 0;
    },
    async updateMany() {
      sessionUpdateCalls++;
      return { modifiedCount: options.legacyFocusLossDocs ?? 0 };
    },
    /**
     * A cursor over the supplied documents.
     *
     * Migration `0005` streams `monitored_sessions` with `for await`, so the fake has to be an
     * async iterable rather than an object with `toArray()`. Returning a generator is also what
     * makes "the migration reads the collection once" checkable: the counter increments on
     * `find`, not on iteration, so a second pass shows up.
     */
    find() {
      sessionFindCalls++;
      const documents = options.sessionDocuments ?? [];
      return (async function* iterate() {
        for (const document of documents) yield document;
      })();
    },
    async bulkWrite(
      operations: Array<{
        updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> };
      }>,
    ) {
      for (const operation of operations) sessionWrites.push(operation.updateOne);
      return { modifiedCount: operations.length };
    },
  };

  // Migration 0004's whole job is to create two indexes, so this is the operation the fake
  // must model — and it records the specification rather than merely counting calls,
  // because "it created an index" and "it created the *right* index" are different
  // claims. The mutual exclusion is a unique index on a specific pair; an index on the
  // wrong pair would pass a call count and leave the claim non-exclusive.
  const operationClaims = {
    async createIndex(key: Record<string, number>, indexOptions: Record<string, unknown> = {}) {
      claimIndexCalls.push({ key, options: indexOptions });
      return Object.keys(key).join("_") + "_1";
    },
  };

  const schemaMigrations = {
    /** The runner makes the ledger idempotent before its first write. */
    async createIndex() {
      ledgerIndexCalls++;
      return "migrationId_1";
    },    find() {
      return {
        sort() {
          return {
            toArray: async () =>
              [...ledger].sort(
                (a, b) =>
                  (a["appliedAt"] as Date).getTime() - (b["appliedAt"] as Date).getTime(),
              ),
          };
        },
      };
    },
    async insertOne(document: Record<string, unknown>) {
      // Models the unique index: a second row for one migration is a duplicate-key error,
      // which the runner treats as "another runner recorded this".
      if (ledger.some((row) => row["migrationId"] === document["migrationId"])) {
        // A real driver error, so the runner's `instanceof MongoServerError` check is
        // exercised rather than a lookalike that happens to carry the same code.
        throw new MongoServerError({
          message: "E11000 duplicate key error collection: schema_migrations index: migrationId_1",
          code: 11000,
        });
      }
      ledger.push(document);
      return { insertedId: "ledger-1" };
    },
  };

  const db = {
    collection(name: string) {
      if (name === "micro_events") return microEvents;
      if (name === "risk_assessments") return riskAssessments;
      if (name === "monitored_sessions") return monitoredSessions;
      if (name === "operation_claims") return operationClaims;
      if (name === MIGRATIONS_COLLECTION) return schemaMigrations;
      throw new Error(`the fake Db has no collection named '${name}'`);
    },
  } as unknown as Db;

  return {
    db,
    ledger,
    deletedIdBatches,
    riskAssessmentDeletedIdBatches,
    aggregateCalls: () => aggregateCalls,
    riskAssessmentAggregateCalls: () => riskAssessmentAggregateCalls,
    sessionCountCalls: () => sessionCountCalls,
    sessionUpdateCalls: () => sessionUpdateCalls,
    sessionFindCalls: () => sessionFindCalls,
    sessionWrites: () => sessionWrites,
    ledgerIndexCalls: () => ledgerIndexCalls,
    claimIndexCalls: () => claimIndexCalls,
  };
}

/** A risk-assessment document, for the identity migration. */
function assessment(id: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    riskAssessmentId: "risk-1",
    sessionId: "ses-1",
    overallRiskScore: 40,
    _generatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function appliedEntry(migrationId: string, appliedAt = new Date("2026-01-01T00:00:00.000Z")) {
  return { migrationId, description: "recorded", appliedAt };
}

/** The migrations a full run applies, in order. */
const APPLIED_ALL = [
  "0001-dedupe-micro-event-identity",
  "0002-dedupe-risk-assessment-identity",
  "0003-rename-fullscreen-exit-to-focus-loss",
  "0004-paid-operation-claim-indexes",
  "0005-normalise-session-list-fields",
];

describe("planMigrations", () => {
  test("a fresh database has every migration pending", async () => {
    const { db } = fakeDb();
    const plan = await planMigrations(db);

    assert.equal(plan.length, MIGRATIONS.length);
    assert.ok(plan.every((entry) => entry.state === "pending"));
  });

  test("the plan names which migrations rewrite data", async () => {
    // An operator has to be able to see this before it happens.
    const { db } = fakeDb();
    const plan = await planMigrations(db);

    const dedupe = plan.find((entry) => entry.id === "0001-dedupe-micro-event-identity");
    assert.ok(dedupe);
    assert.equal(dedupe.rewritesData, true);
  });

  test("an applied migration is not pending", async () => {
    const { db } = fakeDb({ applied: [appliedEntry("0001-dedupe-micro-event-identity")] });
    const plan = await planMigrations(db);

    assert.equal(plan[0].state, "applied");
  });

  test("a migration the build does not know about is refused", async () => {
    // The code is older than the data, which is the one direction that is never
    // safe to guess about.
    const { db } = fakeDb({ applied: [appliedEntry("9999-from-the-future")] });

    await assert.rejects(
      () => planMigrations(db),
      (error: unknown) =>
        error instanceof UnknownMigrationError &&
        error.migrationIds.includes("9999-from-the-future"),
    );
  });
});

describe("runMigrations", () => {
  test("applies a pending migration and records it", async () => {
    const { db, ledger, deletedIdBatches } = fakeDb({
      groups: [
        {
          _id: { sessionId: "ses-1", eventId: "evt-1" },
          count: 2,
          docs: [doc("a"), doc("b")],
        },
      ],
    });

    const result = await runMigrations(db);

    assert.deepEqual(result.applied, APPLIED_ALL);
    assert.deepEqual(deletedIdBatches, [["b"]]);
    assert.equal(ledger.length, APPLIED_ALL.length);
    assert.equal(ledger[0]["migrationId"], "0001-dedupe-micro-event-identity");
    assert.equal(ledger[1]["migrationId"], "0002-dedupe-risk-assessment-identity");
    assert.equal(ledger[2]["migrationId"], "0003-rename-fullscreen-exit-to-focus-loss");
    assert.equal(ledger[3]["migrationId"], "0004-paid-operation-claim-indexes");
    assert.equal(ledger[4]["migrationId"], "0005-normalise-session-list-fields");
    assert.ok(ledger[0]["appliedAt"] instanceof Date);
  });

  test("records how many documents it removed", async () => {
    // A migration that deletes must say how much, and the ledger is where that
    // survives the process that did it.
    const { db, ledger } = fakeDb({
      groups: [
        {
          _id: { sessionId: "ses-1", eventId: "evt-1" },
          count: 3,
          docs: [doc("a"), doc("b"), doc("c")],
        },
      ],
    });

    await runMigrations(db);

    assert.match(String(ledger[0]["detail"]), /removed 2 duplicate document\(s\)/);
  });

  test("is idempotent: a second run applies nothing", async () => {
    const { db, deletedIdBatches } = fakeDb({
      groups: [
        {
          _id: { sessionId: "ses-1", eventId: "evt-1" },
          count: 2,
          docs: [doc("a"), doc("b")],
        },
      ],
    });

    const first = await runMigrations(db);
    const second = await runMigrations(db);

    assert.deepEqual(first.applied, APPLIED_ALL);
    assert.deepEqual(second.applied, []);
    assert.equal(deletedIdBatches.length, 1, "the second run deleted again");
  });

  test("a dry run changes nothing at all", async () => {
    const { db, ledger, deletedIdBatches, aggregateCalls } = fakeDb({
      groups: [
        {
          _id: { sessionId: "ses-1", eventId: "evt-1" },
          count: 2,
          docs: [doc("a"), doc("b")],
        },
      ],
    });

    const result = await runMigrations(db, { dryRun: true });

    assert.equal(result.dryRun, true);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(deletedIdBatches, []);
    assert.equal(ledger.length, 0);
    assert.equal(aggregateCalls(), 0, "a dry run must not even read the data");
  });

  test("a dry run still reports the plan", async () => {
    const { db } = fakeDb();
    const lines: string[] = [];

    const result = await runMigrations(db, { dryRun: true, log: (m) => lines.push(m) });

    assert.equal(result.plan.filter((e) => e.state === "pending").length, MIGRATIONS.length);
    assert.ok(lines.some((line) => line.includes("would apply")));
    assert.ok(lines.some((line) => line.includes("rewrites data")));
  });

  test("a clean database is a no-op that still records itself", async () => {
    // Recording a no-op is deliberate: it is what makes the ledger a complete
    // account of what this database has been through.
    const { db, ledger } = fakeDb({ groups: [] });

    const result = await runMigrations(db);

    assert.deepEqual(result.applied, APPLIED_ALL);
    assert.equal(ledger.length, APPLIED_ALL.length);
    assert.match(String(ledger[0]["detail"]), /no duplicate event identities found/);
    assert.match(
      String(ledger[1]["detail"]),
      /no duplicate risk-assessment identities found/,
    );
    // A migration that rewrites no data still reports what it did, so the ledger is a
    // complete account rather than one that silently skips the additions.
    assert.match(String(ledger[3]["detail"]), /operation_claims carries/);
  });

  test("the risk-assessment identity migration removes duplicates, ignoring _generatedAt", async () => {
    // Two copies of one assessment written by a retry differ only in `_generatedAt`,
    // which is when the copy *arrived* rather than part of the assessment. Treating
    // that as a disagreement would make the migration refuse on exactly the case it
    // exists to repair.
    const { db, ledger, riskAssessmentDeletedIdBatches } = fakeDb({
      riskAssessmentGroups: [
        {
          _id: "risk-1",
          count: 2,
          docs: [
            assessment("a", { _generatedAt: new Date("2026-01-01T00:00:00.000Z") }),
            assessment("b", { _generatedAt: new Date("2026-02-01T00:00:00.000Z") }),
          ],
        },
      ],
    });

    const result = await runMigrations(db);

    assert.deepEqual(result.applied, APPLIED_ALL);
    assert.deepEqual(riskAssessmentDeletedIdBatches, [["b"]], "the earliest copy is kept");
    assert.match(String(ledger[1]["detail"]), /removed 1 duplicate document\(s\)/);
  });

  test("the risk-assessment migration refuses when two copies disagree", async () => {
    // Different payloads under one id are a data-integrity problem, not a duplicate:
    // removing either would destroy whichever version the operator wanted.
    const { db, ledger, riskAssessmentDeletedIdBatches } = fakeDb({
      riskAssessmentGroups: [
        {
          _id: "risk-1",
          count: 2,
          docs: [
            assessment("a"),
            assessment("b", { overallRiskScore: 99 }),
          ],
        },
      ],
    });

    await assert.rejects(
      () => runMigrations(db),
      (error: unknown) =>
        error instanceof MigrationConflictError && error.message.includes("risk-1"),
    );

    assert.deepEqual(riskAssessmentDeletedIdBatches, [], "a conflict deleted something");
    assert.equal(ledger.length, 1, "0001 was recorded, 0002 was not");
  });

  test("a conflict refuses, deletes nothing, and is not recorded", async () => {
    const { db, ledger, deletedIdBatches } = fakeDb({
      groups: [
        {
          _id: { sessionId: "ses-1", eventId: "evt-1" },
          count: 2,
          docs: [doc("a"), doc("b", { payload: { deltaMs: 999 } })],
        },
      ],
    });

    await assert.rejects(
      () => runMigrations(db),
      (error: unknown) =>
        error instanceof MigrationConflictError && error.message.includes("ses-1/evt-1"),
    );

    assert.deepEqual(deletedIdBatches, [], "a conflict deleted something");
    assert.equal(ledger.length, 0, "a failed migration was recorded as applied");
  });

  test("a conflict names at most ten pairs and says how many more there are", async () => {
    const groups = Array.from({ length: 15 }, (_unused, index) => ({
      _id: { sessionId: "ses-1", eventId: `evt-${index}` },
      count: 2,
      docs: [doc(`a-${index}`), doc(`b-${index}`, { payload: { deltaMs: index } })],
    }));
    const { db } = fakeDb({ groups });

    await assert.rejects(
      () => runMigrations(db),
      (error: unknown) =>
        error instanceof MigrationConflictError &&
        error.message.includes("(+5 more)"),
    );
  });

  test("a failure leaves the migration pending for the next run", async () => {
    // Which is only safe because the migration is idempotent and fails before
    // mutating.
    const { db, ledger } = fakeDb({
      groups: [
        {
          _id: { sessionId: "ses-1", eventId: "evt-1" },
          count: 2,
          docs: [doc("a"), doc("b", { eventType: "PASTE" })],
        },
      ],
    });

    await assert.rejects(() => runMigrations(db));

    const plan = await planMigrations(db);
    assert.equal(plan[0].state, "pending");
    assert.equal(ledger.length, 0);
  });

  test("the migration reads the events collection exactly once", async () => {
    const { db, aggregateCalls } = fakeDb({
      groups: [
        {
          _id: { sessionId: "ses-1", eventId: "evt-1" },
          count: 2,
          docs: [doc("a"), doc("b")],
        },
      ],
    });

    await runMigrations(db);
    assert.equal(aggregateCalls(), 1);
  });

  test("the focus-loss rename touches nothing when no document carries the legacy field", async () => {
    // The common case for a database created after the rename. It must record itself as a
    // no-op rather than running an update over the whole collection.
    const { db, ledger, sessionUpdateCalls } = fakeDb({ legacyFocusLossDocs: 0 });

    const result = await runMigrations(db);

    assert.deepEqual(result.applied, APPLIED_ALL);
    assert.equal(sessionUpdateCalls(), 0, "an update ran with nothing to rename");
    assert.match(
      String(ledger[2]["detail"]),
      /no documents carry the legacy fullscreenExitCount field/,
    );
  });

  test("the focus-loss rename reports how many documents it rewrote", async () => {
    const { db, ledger, sessionCountCalls, sessionUpdateCalls } = fakeDb({
      legacyFocusLossDocs: 7,
    });

    await runMigrations(db);

    assert.equal(sessionCountCalls(), 1, "the migration did not check before mutating");
    assert.equal(sessionUpdateCalls(), 1);
    assert.match(
      String(ledger[2]["detail"]),
      /renamed the focus-loss counter on 7 of 7 document\(s\)/,
    );
  });

  test("the ledger is made idempotent before the first write", async () => {
    // Without a unique index on `migrationId`, two processes starting at the same time both
    // read a pending plan and both insert a ledger row for the same migration — so the
    // ledger stops being a faithful account of what the database has been through, which is
    // its whole purpose.
    const { db, ledgerIndexCalls } = fakeDb();

    await runMigrations(db);

    assert.equal(
      ledgerIndexCalls(),
      1,
      "the ledger's unique index was not ensured before writing to it",
    );
  });

  test("a ledger row another runner already wrote is not an error", async () => {
    // Two runners can both read a pending plan. The index makes the loser's insert raise a
    // duplicate key, which is the *expected* outcome of the race rather than a failure — and
    // the loser must not claim it applied the migration.
    const { db, ledger } = fakeDb();
    // A row for 0001 that appeared after the plan was read.
    ledger.push({
      migrationId: "0001-dedupe-micro-event-identity",
      description: "recorded by another runner",
      appliedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await runMigrations(db);

    assert.ok(
      !result.applied.includes("0001-dedupe-micro-event-identity"),
      "the losing runner claimed it applied a migration another runner recorded",
    );
    assert.equal(
      ledger.filter((row) => row["migrationId"] === "0001-dedupe-micro-event-identity").length,
      1,
      "the ledger gained a duplicate row for one migration",
    );
    // The later migrations still applied, so one lost race does not abandon the run.
    assert.ok(result.applied.includes("0002-dedupe-risk-assessment-identity"));
    assert.ok(result.applied.includes("0003-rename-fullscreen-exit-to-focus-loss"));
  });
});

// ═══════════════════════════════════════════════════════════════════
// 0004 — the paid-operation claim collection
// ═══════════════════════════════════════════════════════════════════

describe("0004 — the paid-operation claim indexes", () => {
  test("creates the unique claim index and the retention TTL index, and nothing else", async () => {
    const { db, claimIndexCalls } = fakeDb();
    await runMigrations(db);

    const calls = claimIndexCalls();

    // The mutual exclusion. Asserted as the exact specification rather than as a call
    // count: an index on the wrong pair would satisfy "it created an index" and leave the
    // claim non-exclusive, which is the failure this whole collection exists to prevent.
    assert.deepEqual(
      calls[0],
      { key: { routeFamily: 1, keyHash: 1 }, options: { unique: true } },
      "0004 did not create the unique (routeFamily, keyHash) index",
    );

    // The retention bound. `expireAfterSeconds: 0` means the deadline is the value of
    // `expiresAt`, so the window is data and the index specification is a constant.
    assert.deepEqual(
      calls[1],
      { key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
      "0004 did not create the expiresAt TTL index",
    );

    assert.equal(calls.length, 2, "0004 created an index the claim does not use");
  });

  test("rewrites no data, so it cannot refuse on any database", async () => {
    // The collection is new, so there is nothing to classify and nothing to delete. This
    // is why the migration is safe on a v0.5.0 database of any size.
    const migration = MIGRATIONS.find((entry) => entry.id === "0004-paid-operation-claim-indexes");
    assert.ok(migration);
    assert.equal(migration.rewritesData, false);
  });

  test("runs after the data migrations it depends on", () => {
    // The original form of this assertion was "it is the last migration", which stopped being
    // the same statement as soon as `0005` existed. The property that actually matters is
    // ordering: `0004` may create the claim collection's indexes only once `0001`–`0003` have
    // made them creatable, so it must never be reordered ahead of them.
    const order = MIGRATIONS.map((migration) => migration.id);
    const position = (id: string): number => {
      const index = order.indexOf(id);
      assert.ok(index >= 0, `${id} is missing from the registry`);
      return index;
    };

    for (const dependency of [
      "0001-dedupe-micro-event-identity",
      "0002-dedupe-risk-assessment-identity",
      "0003-rename-fullscreen-exit-to-focus-loss",
    ]) {
      assert.ok(
        position(dependency) < position("0004-paid-operation-claim-indexes"),
        `0004 now runs before ${dependency}, which it depends on`,
      );
    }
  });

  test("the shared index specification matches what the migration applied", async () => {
    // `MongoStore.ensureIndexes()` and this migration both create these indexes, and the
    // second one to run fails with `IndexOptionsConflict` if the two specifications
    // disagree. This asserts the shared list is the specification; the real-MongoDB tests
    // (`migration-from-previous-release.test.ts` for the migration,
    // `critical-indexes.test.ts` for the store) assert that both callers actually apply it.
    assert.deepEqual(
      OPERATION_CLAIM_INDEXES.map((entry) => ({ key: entry.key, options: entry.options })),
      [
        { key: { routeFamily: 1, keyHash: 1 }, options: { unique: true } },
        { key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
      ],
      "the shared claim-index specification changed, so the migration and the store can now " +
        "disagree and the second to run will fail",
    );
  });
});

describe("0005 — the live-list normal form", () => {
  /** A session document, with only the fields the normalisation reads. */
  const session = (
    id: string,
    overrides: Record<string, unknown> = {},
    remove: readonly string[] = [],
  ): Record<string, unknown> => {
    const document: Record<string, unknown> = {
      _id: id,
      sessionId: id,
      status: "active",
      updatedAt: new Date("2026-03-01T11:59:00.000Z"),
      deployedAt: new Date("2026-03-01T11:59:00.000Z"),
      createdAt: new Date("2026-03-01T11:59:00.000Z"),
      ...overrides,
    };
    for (const key of remove) delete document[key];
    return document;
  };

  const DOCUMENTS = [
    session("already-normal"),
    session("status-missing", {}, ["status"]),
    session("status-unknown", { status: "cleared" }),
    session("updated-at-missing", {}, ["updatedAt"]),
    // No verifiable instant anywhere: the sentinel case.
    session("unverifiable", { updatedAt: "not-a-date" }),
  ];

  test("is registered, rewrites data, and exposes the plan to a dry run", async () => {
    const migration = MIGRATIONS.find((entry) => entry.id === "0005-normalise-session-list-fields");
    assert.ok(migration);
    assert.equal(migration.rewritesData, true, "a data migration must say so");
    assert.ok(migration.inspect, "0005 must report its intended changes without applying them");
  });

  test("the dry run reports the categories and writes nothing", async () => {
    const { db, sessionWrites, sessionFindCalls } = fakeDb({ sessionDocuments: DOCUMENTS });
    const lines: string[] = [];

    const result = await runMigrations(db, { dryRun: true, log: (line) => lines.push(line) });

    assert.ok(
      result.plan.some((entry) => entry.id === "0005-normalise-session-list-fields"),
      "the plan does not name 0005",
    );
    assert.deepEqual(result.applied, [], "a dry run applied something");
    assert.deepEqual(sessionWrites(), [], "a dry run wrote a session document");
    assert.equal(sessionFindCalls(), 1, "the dry run did not scan the collection exactly once");

    const report = lines.join("\n");
    // The exact counts, from the five documents above: one missing status, one unrecognised and
    // three already normal; three instants from `updatedAt`, one from `deployedAt` because
    // `updatedAt` is absent, and one unverifiable because `updatedAt` cannot be parsed.
    assert.match(report, /scanned 5 document\(s\): status 1 missing and 1 unrecognised normalised, 3 already normal/);
    assert.match(report, /1 unverifiable/);
    assert.match(report, /1 from deployedAt/);
    assert.match(report, /dry run: nothing written/);
  });

  test("applying it writes only the two normal-form fields, guarded on what it read", async () => {
    const { db, sessionWrites } = fakeDb({ sessionDocuments: DOCUMENTS });

    const result = await runMigrations(db);
    assert.deepEqual(result.applied, APPLIED_ALL);

    const writes = sessionWrites();
    // Every document needs the derived instant, because none of them carries one — a document
    // whose status is already normal is still a document the field is missing from. That is the
    // distinction the "unchanged" category is about: `status` is untouched on three of these.
    assert.equal(writes.length, DOCUMENTS.length);
    assert.equal(
      writes.filter((write) => (write.update["$set"] as Record<string, unknown>)["status"] !== undefined)
        .length,
      2,
      "the wrong number of documents had their status normalised",
    );

    for (const write of writes) {
      assert.deepEqual(Object.keys(write.update), ["$set"]);
      const set = write.update["$set"] as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(set).filter((key) => key !== "status" && key !== "liveListUpdatedAt"),
        [],
        `0005 wrote a field outside the normal form: ${Object.keys(set).join(", ")}`,
      );
      // The guard: the write applies only while the fields the plan was computed from are
      // unchanged, so a session the application transitions mid-scan is not overwritten.
      assert.ok("_id" in write.filter, "a guarded write did not identify its document");
      if (set["status"] !== undefined) assert.ok("status" in write.filter);
      if (set["liveListUpdatedAt"] !== undefined) {
        assert.ok("liveListUpdatedAt" in write.filter);
      }
    }
  });

  test("the guard matches an absent field with $exists rather than null", async () => {
    // `{ field: null }` also matches a document where the field is *missing*, so a filter that
    // meant "it had no status" would also match a document that gained one after the scan.
    const { db, sessionWrites } = fakeDb({ sessionDocuments: DOCUMENTS });
    await runMigrations(db);

    const missingStatusWrite = sessionWrites().find(
      (write) => (write.update["$set"] as Record<string, unknown>)["status"] === "active" &&
        write.filter["status"] !== undefined,
    );
    assert.ok(missingStatusWrite, "no write normalised a status");
    assert.deepEqual(missingStatusWrite!.filter["status"], { $exists: false });
  });
});

describe("readAppliedMigrations", () => {
  test("returns the ledger in application order", async () => {
    const { db } = fakeDb({
      applied: [
        appliedEntry("second", new Date("2026-02-01T00:00:00.000Z")),
        appliedEntry("first", new Date("2026-01-01T00:00:00.000Z")),
      ],
    });

    const applied = await readAppliedMigrations(db);
    assert.deepEqual(
      applied.map((entry) => entry.migrationId),
      ["first", "second"],
    );
  });

  test("an empty ledger reads as empty", async () => {
    const { db } = fakeDb();
    assert.deepEqual(await readAppliedMigrations(db), []);
  });
});

describe("the registry", () => {
  test("migration ids are unique", () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("every migration has a description", () => {
    for (const migration of MIGRATIONS) {
      assert.ok(migration.description.length > 20, `${migration.id} has a thin description`);
    }
  });

  test("the dedupe migration runs before anything that depends on it", () => {
    // The unique index cannot be created over duplicates, so this ordering is
    // load-bearing rather than cosmetic.
    assert.equal(MIGRATIONS[0].id, "0001-dedupe-micro-event-identity");
  });
});

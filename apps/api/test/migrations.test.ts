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
  let ledgerIndexCalls = 0;

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
    ledgerIndexCalls: () => ledgerIndexCalls,
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
    assert.equal(ledger.length, 3);
    assert.equal(ledger[0]["migrationId"], "0001-dedupe-micro-event-identity");
    assert.equal(ledger[1]["migrationId"], "0002-dedupe-risk-assessment-identity");
    assert.equal(ledger[2]["migrationId"], "0003-rename-fullscreen-exit-to-focus-loss");
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
    assert.equal(ledger.length, 3);
    assert.match(String(ledger[0]["detail"]), /no duplicate event identities found/);
    assert.match(
      String(ledger[1]["detail"]),
      /no duplicate risk-assessment identities found/,
    );
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

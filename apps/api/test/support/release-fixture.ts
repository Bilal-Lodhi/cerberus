/**
 * A deterministic fixture for a **published release's** database.
 *
 * ── Why a builder, and not a hand-written test ────────────────────────
 *
 * `docs/development/failure-semantics.md` records the problem: a one-off migration test
 * built by hand drifts from the historical state it is supposed to represent, and nobody
 * notices, because the test keeps passing against a shape no deployment ever had.
 *
 * So the shape of each release is described **once**, in {@link RELEASE_SHAPES}, and the
 * description is derived from what the release notes actually say rather than from
 * memory:
 *
 *   `v0.2.0`  shipped migration `0001` only — its release notes say "`0001-dedupe-micro-event-identity`
 *             is the only [migration]". So `0002` and `0003` are pending, the focus-loss
 *             counter still carries the legacy `fullscreenExitCount` name, and a database
 *             can hold duplicate `riskAssessmentId` rows, which `0002` exists to remove.
 *   `v0.3.0`  shipped `0002` and `0003` as well — its release notes say "two migrations
 *             ship with it". So all three are applied, the counter is `focusLossCount`,
 *             and neither identity can be duplicated.
 *
 * ── What the fixture is for ───────────────────────────────────────────
 *
 * `apps/api/test/release/migration-from-previous-release.test.ts` seeds one of these and
 * then walks the whole upgrade: dry run, migrate, validate, re-run. Against a **real**
 * MongoDB, because the thing being verified is what a real database does — an index that
 * cannot be built over duplicates, a field that is renamed in place, a ledger row.
 *
 * The documents are inserted through the raw driver rather than through `MongoStore`,
 * deliberately: the point is to write the shape a *previous* build wrote, and the current
 * store's validation would refuse to produce some of it.
 */

import type { Db } from "mongodb";

import { COLLECTION_NAMES } from "../../../../packages/mcp-mongodb/src/tool-names.js";

/** A release whose database shape this fixture can reproduce. */
export type PublishedRelease = "v0.2.0" | "v0.3.0" | "v0.5.0" | "v0.6.1";

/** Every release the fixture knows, oldest first. */
export const PUBLISHED_RELEASES: readonly PublishedRelease[] = [
  "v0.2.0",
  "v0.3.0",
  "v0.5.0",
  "v0.6.1",
];

export interface ReleaseShape {
  /** Where the claim comes from, so a reader can check it rather than trust it. */
  source: string;
  /** Migrations the release had already applied. */
  appliedMigrations: readonly string[];
  /** The focus-loss counter's field name at that release. */
  focusLossField: "focusLossCount" | "fullscreenExitCount";
  /** Whether a document at that release could hold two rows sharing a `riskAssessmentId`. */
  duplicateAssessmentIdentity: boolean;
}

/**
 * What each published release's database looks like.
 *
 * Derived from the release notes, not from the code: the code has moved on, which is
 * exactly why the historical shape has to be recorded somewhere that does not move with
 * it. `docs/release/v0.2.0-release-notes.md` and
 * `docs/release/v0.3.0-release-notes.md` are the sources named in each entry.
 */
export const RELEASE_SHAPES: Record<PublishedRelease, ReleaseShape> = {
  "v0.2.0": {
    source:
      "docs/release/v0.2.0-release-notes.md — \"migration " +
      "`0001-dedupe-micro-event-identity` is the only [one]\"",
    appliedMigrations: ["0001-dedupe-micro-event-identity"],
    focusLossField: "fullscreenExitCount",
    duplicateAssessmentIdentity: true,
  },
  "v0.3.0": {
    source:
      "docs/release/v0.3.0-release-notes.md — \"Two migrations ship with it — `0002` and " +
      "`0003`\"",
    appliedMigrations: [
      "0001-dedupe-micro-event-identity",
      "0002-dedupe-risk-assessment-identity",
      "0003-rename-fullscreen-exit-to-focus-loss",
    ],
    focusLossField: "focusLossCount",
    duplicateAssessmentIdentity: false,
  },
  "v0.5.0": {
    // The most recent published release, and therefore the shape an upgrade actually
    // starts from. Its release notes are explicit: "**No schema migration ships with this
    // release.**" — so the ledger holds exactly the three migrations `v0.3.0` shipped, and
    // the only thing this cycle adds to a database is `0004`.
    source:
      "docs/release/v0.5.0-release-notes.md — \"No schema migration ships with this " +
      "release.\"",
    appliedMigrations: [
      "0001-dedupe-micro-event-identity",
      "0002-dedupe-risk-assessment-identity",
      "0003-rename-fullscreen-exit-to-focus-loss",
    ],
    focusLossField: "focusLossCount",
    duplicateAssessmentIdentity: false,
  },
  "v0.6.1": {
    // The starting point for this cycle, and the shape an upgrade actually begins from.
    // Its release notes are explicit: "Migration `0004` is untouched; there is no `0005`",
    // and "Unchanged. Migration 0004 is untouched" in the schema row of the summary table.
    // So the ledger holds all four migrations and nothing this cycle adds is applied yet.
    source:
      "docs/release/v0.6.1-release-notes.md — \"Migration `0004` is untouched; there is " +
      "no `0005`\"",
    appliedMigrations: [
      "0001-dedupe-micro-event-identity",
      "0002-dedupe-risk-assessment-identity",
      "0003-rename-fullscreen-exit-to-focus-loss",
      "0004-paid-operation-claim-indexes",
    ],
    focusLossField: "focusLossCount",
    duplicateAssessmentIdentity: false,
  },
};

/** Fixed identifiers, so two runs of the fixture produce the same database. */
const SESSION_ID = "fixture-session-1";
const EMPLOYEE_ID = "fixture-operator-1";
const AUDIT_ID = "fixture-audit-1";
const ASSESSMENT_ID = "fixture-assessment-1";
const REFERENCE_ID = "fixture-reference-1";

export interface SeededFixture {
  release: PublishedRelease;
  shape: ReleaseShape;
  sessionId: string;
  assessmentId: string;
  /** Documents written, by collection, for the report. */
  counts: Record<string, number>;
}

/**
 * Writes the shape of `release` into `db`, replacing whatever is there.
 *
 * Deterministic: the same release always produces the same documents with the same
 * identifiers, so a failure is reproducible and two runs can be compared.
 */
export async function seedPublishedRelease(
  db: Db,
  release: PublishedRelease,
): Promise<SeededFixture> {
  const shape = RELEASE_SHAPES[release];
  const counts: Record<string, number> = {};

  /** Writes `documents` and records how many. */
  async function seed(collection: string, documents: Record<string, unknown>[]): Promise<void> {
    if (documents.length === 0) {
      counts[collection] = 0;
      return;
    }
    await db.collection(collection).insertMany(documents as never[]);
    counts[collection] = documents.length;
  }

  const timestamp = new Date("2026-01-01T00:00:00.000Z");

  await seed(COLLECTION_NAMES.threatScenarios, [
    {
      metadata: {
        matrixId: "fixture-matrix-1",
        generatedAt: timestamp,
        model: "fixture",
        version: release,
      },
      regulatoryMandates: [],
      targetSystems: [],
      threatVectors: [],
    },
  ]);

  // ── The session, with the counter under the name that release used ──
  //
  // Both spellings are written for `v0.2.0`: a deployment that had not yet run `0003`
  // holds the legacy name, and a deployment part-way through holds both. Migration `0003`
  // keeps the **larger**, so a fixture holding both is what proves it cannot lose the
  // higher total.
  const sessionDocument: Record<string, unknown> = {
    sessionId: SESSION_ID,
    employeeId: EMPLOYEE_ID,
    auditId: AUDIT_ID,
    matrixId: "fixture-matrix-1",
    targetSystem: "Fixture Ledger",
    status: "active",
    eventCount: 2,
    pasteCount: 1,
    tabSwitchCount: 0,
    copyAttemptCount: 0,
    peakRiskScore: 61,
    deployedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  sessionDocument[shape.focusLossField] = 4;
  if (release === "v0.2.0") {
    // The mixed state, so `0003`'s "keep the larger" rule is exercised.
    sessionDocument["focusLossCount"] = 2;
  }
  await seed(COLLECTION_NAMES.sessions, [sessionDocument]);

  await seed(COLLECTION_NAMES.microEvents, [
    {
      eventId: "fixture-event-1",
      sessionId: SESSION_ID,
      employeeId: EMPLOYEE_ID,
      auditId: AUDIT_ID,
      eventType: "KEYSTROKE",
      timestamp,
      payload: { deltaMs: 120 },
    },
  ]);

  // ── The assessment identity `0002` exists to repair ──
  //
  // Two rows sharing a `riskAssessmentId` and otherwise identical: the shape the
  // pre-`0002` retry path wrote. `v0.3.0` shipped `0002`, so its database cannot hold it.
  const assessmentBase = {
    riskAssessmentId: ASSESSMENT_ID,
    sessionId: SESSION_ID,
    employeeId: EMPLOYEE_ID,
    auditId: AUDIT_ID,
    overallRiskScore: 61,
    dimensionScores: { dataExfiltration: 61 },
    flags: [],
    exfiltrationReport: null,
    behavioralAnomalies: [],
    generatedAt: timestamp,
  };

  await seed(
    COLLECTION_NAMES.riskAssessments,
    shape.duplicateAssessmentIdentity
      ? [assessmentBase, { ...assessmentBase }]
      : [assessmentBase],
  );

  await seed(COLLECTION_NAMES.referenceDocuments, [
    {
      referenceId: REFERENCE_ID,
      label: "fixture policy",
      content: "fixture reference content",
      tags: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ]);

  // The corpus counter, so `connect()`'s reconciliation has something to reconcile.
  await db
    .collection<{ _id: string; count: number }>(COLLECTION_NAMES.referenceCorpusMeta)
    .updateOne(
      { _id: COLLECTION_NAMES.referenceDocuments },
      { $set: { count: 1 } },
      { upsert: true },
    );

  // ── The ledger ──
  //
  // A database records what it has had applied. Writing only the release's own
  // migrations is what makes the rest *pending*, which is the state an upgrade starts
  // from.
  await seed(
    COLLECTION_NAMES.schemaMigrations,
    shape.appliedMigrations.map((migrationId) => ({
      migrationId,
      appliedAt: timestamp,
      description: `${migrationId} (recorded by the ${release} fixture)`,
    })),
  );

  return {
    release,
    shape,
    sessionId: SESSION_ID,
    assessmentId: ASSESSMENT_ID,
    counts,
  };
}

// ═══════════════════════════════════════════════════════════════════
// The adversarial session fixture
// ═══════════════════════════════════════════════════════════════════

/**
 * The instant every adversarial row is defined relative to, and the window it is judged in.
 *
 * Both are **fixed constants**, never `Date.now()`. The live list's whole semantics turn on
 * a comparison against `now - ttl`, so a fixture built from the wall clock would move under a
 * test between seeding and asserting, and would make a failure unreproducible. Every test
 * that uses these rows passes `ADVERSARIAL_NOW_MS` as the injected clock instant, which is
 * the same discipline `createManualClock` exists for.
 */
export const ADVERSARIAL_NOW_MS = Date.parse("2026-03-01T12:00:00.000Z");

/** The TTL the adversarial rows are designed around: one hour. */
export const ADVERSARIAL_TTL_SECONDS = 3600;

const ONE_HOUR_MS = ADVERSARIAL_TTL_SECONDS * 1000;

/** Comfortably inside the monitoring window: one minute of age. */
const RECENT = new Date(ADVERSARIAL_NOW_MS - 60_000);
/** Comfortably outside it: the TTL plus one more minute. */
const OLD = new Date(ADVERSARIAL_NOW_MS - ONE_HOUR_MS - 60_000);
/** Exactly at the boundary. `isExpired` compares with `>=`, so this is **expired**. */
const AT_CUTOFF = new Date(ADVERSARIAL_NOW_MS - ONE_HOUR_MS);
/** One millisecond inside it, so **not** expired. The pair with `AT_CUTOFF` pins the boundary. */
const JUST_INSIDE = new Date(ADVERSARIAL_NOW_MS - ONE_HOUR_MS + 1);
/** A backwards host clock: an instant ahead of `now`, which `resolveLastActivityMs` clamps. */
const FUTURE = new Date(ADVERSARIAL_NOW_MS + ONE_HOUR_MS);

/** One row of the adversarial fixture, with the reason it exists. */
export interface AdversarialSessionRow {
  /** What this row exercises, in one line. Used as the test-case name. */
  label: string;
  /** The `sessionId` the row is inserted under, or `null` when the row has none. */
  sessionId: string | null;
  document: Record<string, unknown>;
}

/**
 * Builds one adversarial session document.
 *
 * `remove` deletes keys rather than setting them to `undefined` **on purpose**: the MongoDB
 * driver serialises `undefined` as BSON `null`, so a key left at `undefined` would produce a
 * document with an explicit `null`, which is a different shape from one that is missing.
 * Three of the cases below (`status`, `updatedAt`, `createdAt`) turn on exactly that
 * difference, and the historical status-clobbering defect was `undefined` becoming `null`.
 */
function sessionRow(
  sessionId: string,
  overrides: Record<string, unknown> = {},
  remove: readonly string[] = [],
): Record<string, unknown> {
  const document: Record<string, unknown> = {
    sessionId,
    employeeId: "adv-operator",
    auditId: "adv-audit",
    matrixId: "adv-matrix",
    targetSystem: "Adversarial Fixture",
    status: "active",
    eventCount: 3,
    pasteCount: 1,
    tabSwitchCount: 2,
    focusLossCount: 1,
    copyAttemptCount: 0,
    peakRiskScore: 17,
    deployedAt: RECENT,
    createdAt: RECENT,
    updatedAt: RECENT,
    ...overrides,
  };
  for (const key of remove) delete document[key];
  return document;
}

/**
 * Every row of the adversarial session fixture, in the order the fixture inserts them.
 *
 * The set is organised around the two case tables in
 * [live-list-equivalence-model.md](../../../../docs/development/live-list-equivalence-model.md)
 * §3 and §5 — status values, then `updatedAt` values, then `createdAt`/`deployedAt` fallbacks,
 * then the combinations — so that a change to the model shows up as a missing or wrong row
 * here rather than as a silent gap in coverage.
 *
 * Every row here is a document the **current** code has a definite answer for. None of them
 * is a "should" case: the fixture's job is to record the answer the shipped code gives, which
 * is the only thing an equivalence proof can compare against.
 */
export const ADVERSARIAL_SESSION_ROWS: readonly AdversarialSessionRow[] = [
  // ── Status: the normalisation table (model §3) ──────────────────────
  {
    label: "status active",
    sessionId: "adv-status-active",
    document: sessionRow("adv-status-active", { status: "active" }),
  },
  {
    label: "status locked",
    sessionId: "adv-status-locked",
    document: sessionRow("adv-status-locked", { status: "locked" }),
  },
  {
    label: "status terminated",
    sessionId: "adv-status-terminated",
    document: sessionRow("adv-status-terminated", { status: "terminated" }),
  },
  {
    label: "status missing",
    sessionId: "adv-status-missing",
    document: sessionRow("adv-status-missing", {}, ["status"]),
  },
  {
    label: "status null",
    sessionId: "adv-status-null",
    document: sessionRow("adv-status-null", { status: null }),
  },
  {
    label: "status unknown (cleared)",
    sessionId: "adv-status-cleared",
    document: sessionRow("adv-status-cleared", { status: "cleared" }),
  },
  {
    label: "status unknown (flagged)",
    sessionId: "adv-status-flagged",
    document: sessionRow("adv-status-flagged", { status: "flagged" }),
  },
  {
    // The trap: `normalizeStatus` is case-sensitive, so this is `active` and **live**.
    label: "status case variant (Terminated)",
    sessionId: "adv-status-case-terminated",
    document: sessionRow("adv-status-case-terminated", { status: "Terminated" }),
  },
  {
    label: "status wrong type (number)",
    sessionId: "adv-status-number",
    document: sessionRow("adv-status-number", { status: 42 }),
  },
  {
    label: "status empty string",
    sessionId: "adv-status-empty",
    document: sessionRow("adv-status-empty", { status: "" }),
  },

  // ── updatedAt: the timestamp table (model §5) ───────────────────────
  {
    label: "updatedAt recent BSON Date",
    sessionId: "adv-updated-recent",
    document: sessionRow("adv-updated-recent", { updatedAt: RECENT }),
  },
  {
    label: "updatedAt old BSON Date (expired)",
    sessionId: "adv-updated-old",
    document: sessionRow("adv-updated-old", { updatedAt: OLD }),
  },
  {
    label: "updatedAt exactly at the cutoff (expired, >= boundary)",
    sessionId: "adv-updated-at-cutoff",
    document: sessionRow("adv-updated-at-cutoff", { updatedAt: AT_CUTOFF }),
  },
  {
    label: "updatedAt one millisecond inside the cutoff (live)",
    sessionId: "adv-updated-just-inside",
    document: sessionRow("adv-updated-just-inside", { updatedAt: JUST_INSIDE }),
  },
  {
    label: "updatedAt in the future (clamped, live)",
    sessionId: "adv-updated-future",
    document: sessionRow("adv-updated-future", { updatedAt: FUTURE }),
  },
  {
    // A hand-edited document: the store writes Dates, so this shape can only arrive from
    // outside the product. The current reader parses it and treats it as an ordinary instant.
    label: "updatedAt ISO string (live)",
    sessionId: "adv-updated-iso-recent",
    document: sessionRow("adv-updated-iso-recent", {
      updatedAt: RECENT.toISOString(),
    }),
  },
  {
    label: "updatedAt ISO string, old (expired)",
    sessionId: "adv-updated-iso-old",
    document: sessionRow("adv-updated-iso-old", { updatedAt: OLD.toISOString() }),
  },
  {
    label: "updatedAt missing, deployedAt recent",
    sessionId: "adv-updated-missing",
    document: sessionRow("adv-updated-missing", {}, ["updatedAt"]),
  },
  {
    // Durable-only: the chain falls to `deployedAt`, which is old, so it is expired.
    // Local: `readDurableString(updatedAt)` is null, so the local instant decides instead.
    // This is the row that distinguishes the two branches (model §4.1).
    label: "updatedAt missing, deployedAt old, createdAt recent",
    sessionId: "adv-updated-missing-stale-deployed",
    document: sessionRow(
      "adv-updated-missing-stale-deployed",
      { deployedAt: OLD, createdAt: RECENT },
      ["updatedAt"],
    ),
  },
  {
    label: "updatedAt null, deployedAt recent",
    sessionId: "adv-updated-null",
    document: sessionRow("adv-updated-null", { updatedAt: null }, ["updatedAt"]),
  },
  {
    label: "updatedAt unparseable string",
    sessionId: "adv-updated-garbage",
    document: sessionRow("adv-updated-garbage", {
      updatedAt: "not-a-date",
      deployedAt: OLD,
    }),
  },
  {
    label: "updatedAt empty string",
    sessionId: "adv-updated-empty",
    document: sessionRow("adv-updated-empty", { updatedAt: "", deployedAt: OLD }),
  },
  {
    label: "updatedAt number (epoch ms, unparseable as a string)",
    sessionId: "adv-updated-number",
    document: sessionRow("adv-updated-number", {
      updatedAt: 1_700_000_000_000,
      deployedAt: OLD,
    }),
  },
  {
    // V8's `Date.parse` accepts "123" as a legacy format, so this is a *parseable* number
    // that resolves to the year 12 — i.e. permanently expired.
    label: "updatedAt number that V8 parses as a legacy date",
    sessionId: "adv-updated-number-parseable",
    document: sessionRow("adv-updated-number-parseable", {
      updatedAt: 123,
      deployedAt: OLD,
    }),
  },
  {
    label: "updatedAt boolean",
    sessionId: "adv-updated-boolean",
    document: sessionRow("adv-updated-boolean", { updatedAt: true, deployedAt: OLD }),
  },
  {
    label: "updatedAt array that stringifies to an unparseable value",
    sessionId: "adv-updated-array",
    document: sessionRow("adv-updated-array", {
      updatedAt: ["nope"],
      deployedAt: OLD,
    }),
  },
  {
    label: "updatedAt array that stringifies to a parseable value",
    sessionId: "adv-updated-array-parseable",
    document: sessionRow("adv-updated-array-parseable", {
      updatedAt: [1, 2],
      deployedAt: OLD,
    }),
  },
  {
    label: "updatedAt object",
    sessionId: "adv-updated-object",
    document: sessionRow("adv-updated-object", {
      updatedAt: { at: "whenever" },
      deployedAt: OLD,
    }),
  },

  // ── createdAt / deployedAt: the fallback chain (model §5.1) ─────────
  {
    label: "createdAt missing, deployedAt recent",
    sessionId: "adv-created-missing",
    document: sessionRow(
      "adv-created-missing",
      { updatedAt: OLD },
      ["createdAt"],
    ),
  },
  {
    label: "createdAt unparseable, no deployedAt, no updatedAt",
    sessionId: "adv-created-garbage",
    document: sessionRow(
      "adv-created-garbage",
      { createdAt: "garbage" },
      ["updatedAt", "deployedAt"],
    ),
  },
  {
    label: "createdAt old, no deployedAt, no updatedAt (expired by createdAt)",
    sessionId: "adv-created-old",
    document: sessionRow(
      "adv-created-old",
      { createdAt: OLD },
      ["updatedAt", "deployedAt"],
    ),
  },
  {
    label: "createdAt recent, no deployedAt, no updatedAt (live by createdAt)",
    sessionId: "adv-created-recent",
    document: sessionRow(
      "adv-created-recent",
      { createdAt: RECENT },
      ["updatedAt", "deployedAt"],
    ),
  },
  {
    // `??` stops at the first non-nullish value, so the empty `deployedAt` blocks
    // `createdAt` and the document has no usable instant at all — permanently live.
    label: "deployedAt empty string blocks createdAt (permanently live)",
    sessionId: "adv-deployed-empty-blocks-created",
    document: sessionRow(
      "adv-deployed-empty-blocks-created",
      { deployedAt: "", createdAt: RECENT },
      ["updatedAt"],
    ),
  },
  {
    label: "no updatedAt, no deployedAt, no createdAt (permanently live)",
    sessionId: "adv-no-timestamps",
    document: sessionRow(
      "adv-no-timestamps",
      {},
      ["updatedAt", "deployedAt", "createdAt"],
    ),
  },

  // ── Combinations ────────────────────────────────────────────────────
  {
    label: "combination: status missing with updatedAt missing",
    sessionId: "adv-combo-status-and-updated-missing",
    document: sessionRow(
      "adv-combo-status-and-updated-missing",
      { deployedAt: OLD },
      ["status", "updatedAt"],
    ),
  },
  {
    label: "combination: status unknown with unparseable updatedAt",
    sessionId: "adv-combo-unknown-status-garbage-updated",
    document: sessionRow("adv-combo-unknown-status-garbage-updated", {
      status: "investigating",
      updatedAt: "n/a",
    }),
  },
  {
    label: "combination: status locked with expired updatedAt",
    sessionId: "adv-combo-locked-expired",
    document: sessionRow("adv-combo-locked-expired", {
      status: "locked",
      updatedAt: OLD,
    }),
  },
  {
    label: "combination: status terminated with recent updatedAt",
    sessionId: "adv-combo-terminated-recent",
    document: sessionRow("adv-combo-terminated-recent", {
      status: "terminated",
      updatedAt: RECENT,
    }),
  },
  {
    label: "combination: status missing with recent updatedAt",
    sessionId: "adv-combo-missing-status-recent",
    document: sessionRow("adv-combo-missing-status-recent", {}, ["status"]),
  },

  // ── Identity: rows the reconciler must handle specially ─────────────
  {
    label: "no sessionId at all (skipped by the reconciler)",
    sessionId: null,
    document: sessionRow("adv-no-session-id", {}, ["sessionId"]),
  },
  {
    label: "empty sessionId (skipped by the reconciler)",
    sessionId: "",
    document: sessionRow("", { sessionId: "" }),
  },
  // ── Deliberately absent: two documents sharing a `sessionId` ────────
  //
  // `ensureIndexes()` creates a **unique** index on `sessionId`, so a deployed database
  // cannot hold two documents for one session, and a fixture that seeded them would make
  // that index impossible to build — breaking the upgrade test that asserts it can. The
  // reconciler's last-wins collapse is a defensive behaviour, so it is pinned by a pure
  // unit test over `reconcileLiveList` instead of by a document no database may hold.
];

/** Fixed identifier so a failed adversarial run names a row a reader can find. */
export const ADVERSARIAL_EMPLOYEE_ID = "adv-operator";

/**
 * Writes a **v0.6.1 database plus the adversarial session rows**.
 *
 * The combination is what matters. The adversarial rows alone leave the migration ledger empty,
 * so every migration from `0001` onward is pending and a test of `0005` would be exercising the
 * whole upgrade rather than the one migration it is about. The ledger is seeded from
 * {@link RELEASE_SHAPES} — rather than repeating the ids here — so "what `v0.6.1` shipped" stays
 * in the one place the release notes are transcribed into.
 */
export async function seedV061AdversarialFixture(db: Db): Promise<{
  inserted: number;
  rows: readonly AdversarialSessionRow[];
}> {
  const shape = RELEASE_SHAPES["v0.6.1"];

  await db.collection(COLLECTION_NAMES.schemaMigrations).insertMany(
    shape.appliedMigrations.map((migrationId) => ({
      migrationId,
      appliedAt: new Date(ADVERSARIAL_NOW_MS),
      description: `${migrationId} (recorded by the v0.6.1 adversarial fixture)`,
    })) as never[],
  );

  return seedAdversarialSessionRows(db);
}

/**
 * Writes the adversarial rows into `db`.
 *
 * Through the raw driver, like {@link seedPublishedRelease}, and for the same reason: the
 * point is to write shapes the current store's validation would refuse to produce, and some
 * of these (`status: 42`, `updatedAt: true`) are precisely that.
 *
 * Uses `insertMany` with `ordered: false` so the two rows sharing a `sessionId` both land —
 * there is no unique index on `sessionId` in the fixture database until `ensureIndexes()`
 * runs, and the duplicate case is only meaningful if both documents exist.
 */
export async function seedAdversarialSessionRows(
  db: Db,
): Promise<{ inserted: number; rows: readonly AdversarialSessionRow[] }> {
  const documents = ADVERSARIAL_SESSION_ROWS.map((row) => row.document);
  if (documents.length === 0) return { inserted: 0, rows: ADVERSARIAL_SESSION_ROWS };

  const result = await db
    .collection(COLLECTION_NAMES.sessions)
    .insertMany(documents as never[], { ordered: false });

  return { inserted: result.insertedCount, rows: ADVERSARIAL_SESSION_ROWS };
}

/**
 * The document as **the API sees it**.
 *
 * The route never touches a BSON document: it calls `list_sessions` over HTTP, and the MCP
 * adapter answers with `JSON.stringify`. A BSON `Date` therefore reaches the reconciler as an
 * ISO-8601 string, an `ObjectId` as a string, and a `undefined` becomes absent. Any test that
 * feeds a raw driver document straight to `reconcileLiveList` is modelling a path that does
 * not exist in a deployment — and, as
 * [live-list-equivalence-model.md](../../../../docs/development/live-list-equivalence-model.md)
 * §5.1 records, the two paths disagree by up to 999 ms on a `Date` because
 * `String(Date)` carries no milliseconds.
 */
export function toApiDocument(document: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
}

/** The whole adversarial fixture in the form the API would receive it. */
export function adversarialApiDocuments(): Record<string, unknown>[] {
  return ADVERSARIAL_SESSION_ROWS.map((row) => toApiDocument(row.document));
}

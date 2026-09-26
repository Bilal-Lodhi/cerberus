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
export type PublishedRelease = "v0.2.0" | "v0.3.0" | "v0.5.0";

/** Every release the fixture knows, oldest first. */
export const PUBLISHED_RELEASES: readonly PublishedRelease[] = [
  "v0.2.0",
  "v0.3.0",
  "v0.5.0",
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

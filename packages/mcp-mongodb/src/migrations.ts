/**
 * Schema and data migrations.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 *
 * Cerberus previously had no migration concept at all: `docs/migration.md`
 * documented a one-off rename and nothing else, and the storage layer's only
 * startup work was `ensureIndexes()`. That is fine until a change is not a pure
 * addition — and the very first durable-identity change was one. Creating a unique
 * index on `(sessionId, eventId)` **fails** on a database that already contains
 * duplicates, and those duplicates are exactly what the pre-fix ingestion path
 * produced. Without a migration, that deployment cannot start.
 *
 * ── Rules every migration here follows ────────────────────────────────
 *
 * 1. **Ordered and append-only.** The registry is a list, and each entry has a
 *    stable `id` that is never renamed or reused. Order comes from position, so
 *    there is no numeric prefix to get wrong.
 * 2. **Idempotent.** Applying a migration twice must be a no-op. The runner
 *    records what it applied, but a migration must not *rely* on that record —
 *    a crash between the work and the ledger write must be recoverable.
 * 3. **Fail before mutating.** A migration that discovers it cannot complete
 *    safely throws *before* writing anything, so a failure leaves the database
 *    as it was rather than half-changed.
 * 4. **Never silently destructive.** A migration that removes documents must say
 *    how many, and must refuse rather than guess when the documents disagree.
 *
 * ── What is deliberately absent ───────────────────────────────────────
 *
 * No down-migrations. Reversing a data migration is usually impossible to do
 * honestly — the removed rows are gone — and a `down` that pretends otherwise is
 * worse than none. The registry's type has no `down` member, so this is a
 * property of the code rather than a convention.
 *
 * No automatic rollback on failure. A partially applied migration is a state an
 * operator needs to see, not one to hide.
 */

import type { Db, ObjectId } from "mongodb";

import { isDuplicateKeyError } from "./mongo-client.js";
import { ensureOperationClaimIndexes } from "./operation-claims.js";
import {
  buildSessionListGuard,
  buildSessionListUpdate,
  planChangesDocument,
  planSessionListNormalisation,
} from "./session-list-normalisation.js";

/** Collection holding the migration ledger. */
export const MIGRATIONS_COLLECTION = "schema_migrations";

export interface MigrationContext {
  db: Db;
  /** Records a line in the migration report. Never used for secrets. */
  log(message: string): void;
}

export interface Migration {
  /** Stable identifier. Never renamed, never reused. */
  id: string;
  /** One line describing what it does. */
  description: string;
  /**
   * Whether this migration removes or rewrites existing documents.
   *
   * Informational: it is surfaced in the dry-run plan so an operator can see what
   * is about to happen before it happens.
   */
  rewritesData: boolean;
  /** Applies the migration. Must be idempotent and must fail before mutating. */
  up(context: MigrationContext): Promise<void>;
  /**
   * Reports what {@link up} would change, **without changing anything**.
   *
   * Optional, and called only for a pending migration during a dry run. The runner's dry run
   * otherwise answers one question — which migrations are pending — which is enough for a
   * schema migration and not enough for a data migration whose effect depends on what the
   * documents currently hold. "Fifty rows have no verifiable timestamp and will be kept live"
   * is the kind of sentence an operator needs *before* the run, so the classification is
   * available on both paths from one implementation.
   *
   * A migration that implements this must not write. `0005` achieves that by running the same
   * scan with its write path disabled, so the dry-run numbers and the applied numbers come from
   * one code path rather than two that could drift.
   */
  inspect?(context: MigrationContext): Promise<void>;
}

/** A migration the database has recorded as applied. */
export interface AppliedMigration {
  migrationId: string;
  appliedAt: Date;
  description: string;
  /** Free-form result detail, e.g. how many documents were removed. */
  detail?: string;
}

export interface MigrationPlanEntry {
  id: string;
  description: string;
  rewritesData: boolean;
  state: "applied" | "pending";
}

export interface MigrationRunResult {
  plan: MigrationPlanEntry[];
  applied: string[];
  /** Applied ids that this build of the code does not know about. */
  unknown: string[];
  dryRun: boolean;
}

/**
 * Thrown when the database records a migration this build does not know about.
 *
 * That means the code is older than the data, which is the one direction that is
 * never safe to guess about.
 */
export class UnknownMigrationError extends Error {
  constructor(readonly migrationIds: string[]) {
    super(
      `The database has migrations this build does not know about: ` +
        `${migrationIds.join(", ")}. The running code is older than the data. ` +
        `Deploy the newer build, or restore from a backup taken before those ` +
        `migrations were applied.`,
    );
    this.name = "UnknownMigrationError";
  }
}

/**
 * Thrown when a migration cannot complete without losing information.
 *
 * Nothing is written when this is raised: the migration classifies the whole
 * database first and only then mutates.
 */
export class MigrationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationConflictError";
  }
}

// ═══════════════════════════════════════════════════════════════════
// 0001 — durable micro-event identity
// ═══════════════════════════════════════════════════════════════════

/** The fields that make up an event's identity. */
const EVENT_IDENTITY = ["sessionId", "eventId"] as const;

/** Fields that legitimately differ between two copies of the same event. */
const IGNORED_WHEN_COMPARING = ["_id", "_ingestedAt"] as const;

/**
 * Fields that legitimately differ between two copies of the same risk assessment.
 *
 * `_generatedAt` is when the copy *arrived*, not part of the assessment — the same
 * distinction `_ingestedAt` draws for an event. Without this, a retry that wrote a
 * second copy of one assessment would be classified as a *conflict* rather than a
 * duplicate, and the migration would refuse on exactly the case it exists to repair.
 */
const IGNORED_FOR_ASSESSMENTS = ["_id", "_generatedAt"] as const;

/** How many conflicting pairs to name in an error before truncating. */
const MAX_REPORTED_CONFLICTS = 10;

/** One set of documents that claim the same event identity. */
export interface DuplicateGroup {
  /** Human-readable identity, for reporting. */
  key: string;
  docs: Array<Record<string, unknown>>;
}

export interface DuplicateClassification {
  /** `_id` values safe to remove: every copy in their group is identical. */
  removableIds: unknown[];
  /** Group keys whose copies disagree, so nothing in them may be removed. */
  conflictKeys: string[];
}

/**
 * Decides which duplicate documents may be removed.
 *
 * Pure, so the decision is testable without a database — and the decision is the
 * part worth testing, because it is the part that can destroy data.
 *
 * A group is removable only when **every** copy is identical apart from the fields in
 * `ignoredFields`. Copies that disagree are not duplicates: they are a data
 * integrity problem with more than one possible resolution, and picking one would
 * destroy whichever version the operator wanted.
 *
 * The earliest `_id` is kept, chosen by sorted order rather than by the server's
 * return order, so the outcome does not depend on how the documents came back.
 *
 * `ignoredFields` is a parameter because the volatile field differs by collection:
 * `_ingestedAt` for a micro-event, `_generatedAt` for a risk assessment. Passing the
 * wrong one turns a repairable duplicate into a refusal.
 */
export function classifyDuplicateGroups(
  groups: DuplicateGroup[],
  ignoredFields: readonly string[] = IGNORED_WHEN_COMPARING,
): DuplicateClassification {
  const removableIds: unknown[] = [];
  const conflictKeys: string[] = [];

  for (const group of groups) {
    if (group.docs.length < 2) continue;

    const sorted = [...group.docs].sort((a, b) =>
      String(a["_id"]).localeCompare(String(b["_id"])),
    );

    const [first, ...rest] = sorted;
    const firstShape = comparableShape(first, ignoredFields);

    if (rest.some((doc) => comparableShape(doc, ignoredFields) !== firstShape)) {
      conflictKeys.push(group.key);
      continue;
    }

    removableIds.push(...rest.map((doc) => doc["_id"]));
  }

  return { removableIds, conflictKeys };
}

/**
 * Removes duplicate `micro_events` documents so the unique identity index can be
 * created.
 *
 * The pre-fix ingestion path wrote every event in a retried batch, so a database
 * that ran it can hold several copies of the same event. Two copies written by a
 * retry are byte-identical apart from `_id` and `_ingestedAt`, which is what makes
 * removing them information-preserving rather than lossy.
 *
 * One aggregate call, grouping in the database and pushing the full documents for
 * only the groups that have duplicates. That keeps the transfer proportional to
 * the number of *duplicates* rather than to the size of the collection.
 */
const dedupeMicroEventIdentity: Migration = {
  id: "0001-dedupe-micro-event-identity",
  description:
    "Remove duplicate micro_events documents that share (sessionId, eventId), so the unique identity index can be created.",
  rewritesData: true,

  async up({ db, log }) {
    const collection = db.collection("micro_events");

    const groups = await collection
      .aggregate<{
        _id: { sessionId?: unknown; eventId?: unknown };
        count: number;
        docs: Array<Record<string, unknown>>;
      }>([
        { $match: { eventId: { $exists: true, $ne: null } } },
        {
          $group: {
            _id: { sessionId: "$sessionId", eventId: "$eventId" },
            count: { $sum: 1 },
            docs: { $push: "$$ROOT" },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();

    if (groups.length === 0) {
      log("no duplicate event identities found");
      return;
    }

    log(`${groups.length} duplicated event identity/identities found`);

    const { removableIds, conflictKeys } = classifyDuplicateGroups(
      groups.map((group) => ({
        key: `${String(group._id.sessionId)}/${String(group._id.eventId)}`,
        docs: group.docs,
      })),
    );

    // Fail before mutating: a conflict means this migration cannot complete, and
    // a half-applied migration is worse than an unapplied one.
    if (conflictKeys.length > 0) {
      const shown = conflictKeys.slice(0, MAX_REPORTED_CONFLICTS);
      const more = conflictKeys.length - shown.length;
      throw new MigrationConflictError(
        `${conflictKeys.length} (sessionId, eventId) pair(s) have copies that are ` +
          `NOT identical, so they are not duplicates and removing either version ` +
          `would lose data. Resolve them before re-running this migration. ` +
          `Pairs: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}. ` +
          `Nothing has been deleted.`,
      );
    }

    if (removableIds.length === 0) {
      log("no removable duplicates found");
      return;
    }

    const result = await collection.deleteMany({
      _id: { $in: removableIds as ObjectId[] },
    });
    log(`removed ${result.deletedCount} duplicate document(s)`);
  },
};

/**
 * The shape used to decide whether two copies of one event are identical.
 *
 * `_id` and `_ingestedAt` are excluded: the first is the storage identity and the
 * second is when the copy arrived, and neither is part of the event. Every other
 * field is included, so a copy with a different payload is *not* treated as a
 * duplicate.
 */
function comparableShape(
  doc: Record<string, unknown>,
  ignoredFields: readonly string[] = IGNORED_WHEN_COMPARING,
): string {
  const entries = Object.entries(doc)
    .filter(([key]) => !ignoredFields.includes(key))
    .sort(([a], [b]) => a.localeCompare(b));

  return JSON.stringify(entries, (_key, value) => {
    // Object key order is not stable across BSON round trips, so nested objects
    // are sorted too; otherwise identical payloads could compare unequal.
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return value;
  });
}

// ═══════════════════════════════════════════════════════════════════
// 0002 — durable risk-assessment identity
// ═══════════════════════════════════════════════════════════════════

/**
 * Removes duplicate `risk_assessments` documents that share a `riskAssessmentId`, so
 * the unique identity index can be created.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 *
 * The risk assessment is the only durable artefact of the paid analysis path, and it
 * had **no durable identity**: `storeRiskAssessment` was a plain insert with no unique
 * index, so a re-analysis after a restart wrote a second row for one incident. The
 * module header of `guardian.ts` described a dedup layer on the provider's assessment
 * id that was never implemented.
 *
 * Adding the unique index without this migration would fail on any database that
 * already holds such a duplicate — and the failure would be an opaque duplicate-key
 * error at startup rather than a repair. Same ordering constraint as migration 0001:
 * migrations run before indexes.
 *
 * ── What it will not do ───────────────────────────────────────────────
 *
 * Two copies that disagree on anything but `_id` and `_generatedAt` are not duplicates
 * — they are a data-integrity problem with more than one possible resolution. The
 * migration refuses and deletes nothing, naming the ids.
 *
 * Documents with no `riskAssessmentId` are skipped: they have no identity to
 * deduplicate on, and the unique index does not constrain them.
 */
const dedupeRiskAssessmentIdentity: Migration = {
  id: "0002-dedupe-risk-assessment-identity",
  description:
    "Remove duplicate risk_assessments documents that share a riskAssessmentId, so the unique identity index can be created.",
  rewritesData: true,

  async up({ db, log }) {
    const collection = db.collection("risk_assessments");

    const groups = await collection
      .aggregate<{
        _id: unknown;
        count: number;
        docs: Array<Record<string, unknown>>;
      }>([
        // Only documents that actually carry an identity. A missing, null or empty
        // `riskAssessmentId` has nothing to deduplicate on, and the unique index does
        // not constrain it — so such documents are skipped rather than grouped
        // together under one null key.
        { $match: { riskAssessmentId: { $exists: true, $type: "string", $ne: "" } } },
        {
          $group: {
            _id: "$riskAssessmentId",
            count: { $sum: 1 },
            docs: { $push: "$$ROOT" },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();

    if (groups.length === 0) {
      log("no duplicate risk-assessment identities found");
      return;
    }

    log(`${groups.length} duplicated risk-assessment identity/identities found`);

    const { removableIds, conflictKeys } = classifyDuplicateGroups(
      groups.map((group) => ({
        key: String(group._id),
        docs: group.docs,
      })),
      // The volatile field is `_generatedAt`, not `_ingestedAt`: a retry writes the
      // same payload with a different arrival stamp, and that is a duplicate.
      IGNORED_FOR_ASSESSMENTS,
    );

    // Fail before mutating: a conflict means this migration cannot complete, and a
    // half-applied migration is worse than an unapplied one.
    if (conflictKeys.length > 0) {
      const shown = conflictKeys.slice(0, MAX_REPORTED_CONFLICTS);
      const more = conflictKeys.length - shown.length;
      throw new MigrationConflictError(
        `${conflictKeys.length} riskAssessmentId value(s) have copies that are NOT ` +
          `identical, so they are not duplicates and removing either version would ` +
          `lose data. Resolve them before re-running this migration. ` +
          `Ids: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}. ` +
          `Nothing has been deleted.`,
      );
    }

    if (removableIds.length === 0) {
      log("no removable duplicates found");
      return;
    }

    const result = await collection.deleteMany({
      _id: { $in: removableIds as ObjectId[] },
    });
    log(`removed ${result.deletedCount} duplicate document(s)`);
  },
};

// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// 0003 — truthful focus-loss vocabulary
// ═══════════════════════════════════════════════════════════════════

/**
 * Renames `monitored_sessions.fullscreenExitCount` to `focusLossCount`.
 *
 * ── Why this is a data migration and not just a rename in code ────────
 *
 * The counter was incremented by **both** `WINDOW_BLUR` and `FULLSCREEN_EXIT`, so its
 * name described one of the two events that produced it: a window blur that was never a
 * fullscreen exit was counted as one. Browser telemetry cannot distinguish the two, so
 * the counter has always measured *focus loss* and the field name has always been wrong.
 *
 * The **score contribution is unchanged**. It was gated on "focus was lost", never on
 * "fullscreen was exited", so this corrects a name rather than a behaviour — which is why
 * the rename is safe to apply without re-scoring anything, and why it needs no
 * compatibility shim on the read path beyond a fallback for an un-migrated document.
 *
 * ── What it does ──────────────────────────────────────────────────────
 *
 * Copies the value to the new field and removes the old one, per document. A document
 * that already has `focusLossCount` keeps the **larger** of the two, so a database where
 * both fields exist — one written by a new process, one by an old — cannot lose the higher
 * total. A pipeline update is used rather than `$rename` so the `$max` can be expressed
 * and the whole operation stays idempotent: applying it twice cannot change the result.
 */
const renameFullscreenExitToFocusLoss: Migration = {
  id: "0003-rename-fullscreen-exit-to-focus-loss",
  description:
    "Rename monitored_sessions.fullscreenExitCount to focusLossCount, which is what the counter has always measured.",
  rewritesData: true,

  async up({ db, log }) {
    const sessions = db.collection("monitored_sessions");

    const legacy = await sessions.countDocuments({
      fullscreenExitCount: { $exists: true, $type: "number" },
    });
    if (legacy === 0) {
      log("no documents carry the legacy fullscreenExitCount field");
      return;
    }

    const copied = await sessions.updateMany(
      { fullscreenExitCount: { $exists: true, $type: "number" } },
      [
        {
          $set: {
            focusLossCount: {
              $max: [
                { $ifNull: ["$focusLossCount", 0] },
                { $ifNull: ["$fullscreenExitCount", 0] },
              ],
            },
          },
        },
        { $unset: "fullscreenExitCount" },
      ],
    );

    log(
      `renamed the focus-loss counter on ${copied.modifiedCount} of ${legacy} ` +
        `document(s) that carried the legacy field`,
    );
  },
};

// ═══════════════════════════════════════════════════════════════════
// 0004 — the paid-operation claim collection
// ═══════════════════════════════════════════════════════════════════

/**
 * Creates the two indexes `operation_claims` depends on.
 *
 * ── Why this is a migration and not only `ensureIndexes()` ────────────
 *
 * Both run on a normal deployment — `connect()` applies the migrations and then creates
 * the indexes — so this migration is not what makes a running API safe. It exists for the
 * path where they do **not** both run: an operator who upgrades with `npm run migrate`
 * and only then starts the services, or who inspects a database with the migration CLI.
 * After `0004`, a database that has been migrated already carries the mutual exclusion
 * and the retention bound, so "the schema is current" and "the claim is enforceable" are
 * the same statement rather than two.
 *
 * ── Why it rewrites no data ───────────────────────────────────────────
 *
 * The collection is new. There is nothing to repair, nothing to classify, and therefore
 * no way for this migration to refuse — which is why `rewritesData` is `false` and why it
 * is safe on a `v0.5.0` database of any size. It is idempotent because `createIndex` is
 * idempotent for an identical specification, and the specification is shared with
 * `ensureIndexes()` through `operation-claims.ts` rather than repeated here, so the two
 * cannot drift into an `IndexOptionsConflict`.
 */
const createPaidOperationClaimIndexes: Migration = {
  id: "0004-paid-operation-claim-indexes",
  description:
    "Create the unique claim index and the retention TTL index on operation_claims, so a database upgraded by the migration CLI alone already enforces the claim.",
  rewritesData: false,

  async up({ db, log }) {
    await ensureOperationClaimIndexes(db.collection("operation_claims"));
    log("operation_claims carries the unique (routeFamily, keyHash) index and the expiresAt TTL index");
  },
};

// ═══════════════════════════════════════════════════════════════════
// 0005 — the live-list normal form
// ═══════════════════════════════════════════════════════════════════

/**
 * How many session documents one bulk write covers.
 *
 * The migration rewrites a collection that grows with every session ever created, so the work
 * is streamed through a cursor and written in bounded batches rather than loaded, planned and
 * written as one array. 500 is small enough that a failure re-does little and large enough that
 * the round trips do not dominate; the value is not a tuning knob and nothing depends on it
 * beyond memory.
 */
const SESSION_NORMALISATION_BATCH = 500;

/**
 * The only fields the normal form depends on.
 *
 * Projected explicitly rather than reading whole documents: the normalisation must not be able
 * to read session content, and a projection is what makes that a property of the query rather
 * than of the code that follows it.
 */
const SESSION_NORMALISATION_PROJECTION = {
  _id: 1,
  status: 1,
  updatedAt: 1,
  deployedAt: 1,
  createdAt: 1,
  liveListUpdatedAt: 1,
} as const;

/**
 * What {@link normaliseSessionListFields} did, or would do.
 *
 * Every category is a count of documents, never a value: the report is printed by the migration
 * CLI and recorded in the ledger, and a session id or a status from a document is not something
 * either should carry.
 */
export interface SessionListNormalisationReport {
  /** Documents examined. */
  totalRows: number;
  /** Status absent or `null`, written as `active`. */
  statusMissingNormalized: number;
  /** Status present but not one of the three durable values, written as its normalised form. */
  statusUnknownNormalized: number;
  /** Status already exactly the durable value; no write. */
  statusAlreadyNormal: number;
  /** The instant came from `updatedAt`. */
  liveListUpdatedAtFromUpdatedAt: number;
  /** The instant came from `deployedAt`, because `updatedAt` was absent or `null`. */
  liveListUpdatedAtFromDeployedAt: number;
  /** The instant came from `createdAt`, because `updatedAt` and `deployedAt` were absent. */
  liveListUpdatedAtFromCreatedAt: number;
  /**
   * **No verifiable last-activity instant exists**, so the document is conservatively treated
   * as never expiring — which is what the current reader does with it. See the module header.
   */
  liveListUpdatedAtUnverifiable: number;
  /** The stored instant was already exactly the target value; no write. */
  liveListUpdatedAtAlreadyNormal: number;
  /** Neither field needed a write. */
  unchangedRows: number;
  /** At least one field needed a write. */
  rewrittenRows: number;
  /** Documents a bulk write actually modified. Zero on a dry run, and zero on a re-run. */
  modifiedRows: number;
}

function emptyNormalisationReport(): SessionListNormalisationReport {
  return {
    totalRows: 0,
    statusMissingNormalized: 0,
    statusUnknownNormalized: 0,
    statusAlreadyNormal: 0,
    liveListUpdatedAtFromUpdatedAt: 0,
    liveListUpdatedAtFromDeployedAt: 0,
    liveListUpdatedAtFromCreatedAt: 0,
    liveListUpdatedAtUnverifiable: 0,
    liveListUpdatedAtAlreadyNormal: 0,
    unchangedRows: 0,
    rewrittenRows: 0,
    modifiedRows: 0,
  };
}

/**
 * Normalises every session document into the live list's normal form.
 *
 * Pure per document (`planSessionListNormalisation`), streaming, batched, idempotent, and
 * **not destructive**: it writes two fields and deletes nothing. Every field the reconciler or
 * any other read surface consults is left exactly as it was, including `updatedAt` — the module
 * header of `session-list-normalisation.ts` carries the proof that rewriting it would change the
 * answer for the malformed documents this migration exists to preserve.
 *
 * Each write is guarded by {@link buildSessionListGuard}, a compare-and-set on the values the
 * plan was computed from, so a session the application transitions while the scan is running is
 * left alone rather than overwritten with a normalisation of its previous state.
 *
 * There is nothing to refuse, so unlike `0001` and `0002` this migration cannot raise a
 * conflict. A crash part-way leaves the documents it reached normalised and the rest untouched,
 * which is a state the next run converges from because every write is idempotent — that is why
 * the ledger's "apply twice" rule is enough here and a claim protocol is not needed.
 */
export async function normaliseSessionListFields(
  db: Db,
  options: { apply: boolean; log: (message: string) => void },
): Promise<SessionListNormalisationReport> {
  const collection = db.collection("monitored_sessions");
  const report = emptyNormalisationReport();

  const cursor = collection.find({}, { projection: SESSION_NORMALISATION_PROJECTION });

  let operations: Array<Record<string, unknown>> = [];

  const flush = async (): Promise<void> => {
    if (!options.apply || operations.length === 0) return;
    const result = await collection.bulkWrite(operations as never[], { ordered: false });
    report.modifiedRows += result.modifiedCount;
    operations = [];
  };

  for await (const document of cursor as AsyncIterable<Record<string, unknown>>) {
    report.totalRows += 1;

    const plan = planSessionListNormalisation(document);

    if (plan.status === null) {
      report.statusAlreadyNormal += 1;
    } else if (plan.statusWasMissing) {
      report.statusMissingNormalized += 1;
    } else {
      report.statusUnknownNormalized += 1;
    }

    switch (plan.source) {
      case "updatedAt":
        report.liveListUpdatedAtFromUpdatedAt += 1;
        break;
      case "deployedAt":
        report.liveListUpdatedAtFromDeployedAt += 1;
        break;
      case "createdAt":
        report.liveListUpdatedAtFromCreatedAt += 1;
        break;
      case "unverifiable":
        report.liveListUpdatedAtUnverifiable += 1;
        break;
    }

    if (plan.liveListUpdatedAt === null) report.liveListUpdatedAtAlreadyNormal += 1;

    if (!planChangesDocument(plan)) {
      report.unchangedRows += 1;
      continue;
    }

    report.rewrittenRows += 1;

    // A dry run counts the same things and writes nothing: the plan is computed either way, so
    // the numbers an operator reads before applying are the numbers the run reports after.
    if (!options.apply) continue;

    operations.push({
      updateOne: {
        filter: buildSessionListGuard(document, plan),
        update: buildSessionListUpdate(plan),
      },
    });

    if (operations.length >= SESSION_NORMALISATION_BATCH) await flush();
  }

  await flush();

  if (report.liveListUpdatedAtUnverifiable > 0) {
    options.log(
      `${report.liveListUpdatedAtUnverifiable} document(s) carry no verifiable last-activity ` +
        `instant and are conservatively kept live, exactly as the current reader treats them; ` +
        `any later write replaces the sentinel with a real instant`,
    );
  }

  options.log(
    `scanned ${report.totalRows} document(s): status ${report.statusMissingNormalized} missing ` +
      `and ${report.statusUnknownNormalized} unrecognised normalised, ` +
      `${report.statusAlreadyNormal} already normal`,
  );
  options.log(
    `liveListUpdatedAt: ${report.liveListUpdatedAtFromUpdatedAt} from updatedAt, ` +
      `${report.liveListUpdatedAtFromDeployedAt} from deployedAt, ` +
      `${report.liveListUpdatedAtFromCreatedAt} from createdAt, ` +
      `${report.liveListUpdatedAtUnverifiable} unverifiable, ` +
      `${report.liveListUpdatedAtAlreadyNormal} already normal`,
  );
  options.log(
    `${report.unchangedRows} document(s) unchanged, ${report.rewrittenRows} rewritten` +
      (options.apply ? `, ${report.modifiedRows} modified` : " (dry run: nothing written)"),
  );

  return report;
}

/**
 * Brings every session document into the live list's normal form, so the live-list predicate
 * can be evaluated by an index instead of by reading the collection.
 *
 * ── Why this is a migration and not a read-path shim ──────────────────
 *
 * The live list cannot be bounded without it. `normalizeStatus` treats any unrecognised or
 * absent status as `active`, so a `status` filter alone would silently drop rows the current
 * code lists, and the liveness rule treats an unreadable timestamp as *not expired*, so no
 * recency range on `updatedAt` reproduces it. Both facts are measured and documented in
 * `docs/release/v0.6.1-release-notes.md` under "Known limitation, deliberately not fixed",
 * which is why the bound was deferred rather than guessed at.
 *
 * ── What it is not ───────────────────────────────────────────────────
 *
 * Not a retention policy: nothing is deleted, and an expired session stays exactly as readable
 * through the review surfaces as it was. Not a status change: every status it writes is the
 * value the reconciler was already computing from the stored one. Not a rewrite of
 * `updatedAt` or any other timestamp the read surfaces display.
 *
 * `rewritesData` is `true` because it does rewrite documents — but only into their normal form,
 * and the migration cannot fail, refuse or delete. A dry run reports the exact counts by
 * category through `inspect`, because "which documents will change" is the question an operator
 * about to run a data migration actually has.
 */
const normaliseSessionListFieldsMigration: Migration = {
  id: "0005-normalise-session-list-fields",
  description:
    "Normalise monitored_sessions.status and derive monitored_sessions.liveListUpdatedAt, so the live session list can be answered by a bounded index-backed query instead of a full collection scan.",
  rewritesData: true,

  async up({ db, log }) {
    await normaliseSessionListFields(db, { apply: true, log });
  },

  async inspect({ db, log }) {
    await normaliseSessionListFields(db, { apply: false, log });
  },
};

// ═══════════════════════════════════════════════════════════════════
// Registry
// ═══════════════════════════════════════════════════════════════════

/**
 * Every migration, in application order.
 *
 * Append only. Reordering this array changes what a database has already applied,
 * and the runner will refuse to proceed if the ledger names an id that is not
 * here.
 */
export const MIGRATIONS: readonly Migration[] = [
  dedupeMicroEventIdentity,
  dedupeRiskAssessmentIdentity,
  renameFullscreenExitToFocusLoss,
  createPaidOperationClaimIndexes,
  normaliseSessionListFieldsMigration,
];

// ═══════════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════════

export async function readAppliedMigrations(db: Db): Promise<AppliedMigration[]> {
  const docs = await db
    .collection(MIGRATIONS_COLLECTION)
    .find({})
    .sort({ appliedAt: 1 })
    .toArray();

  return docs.map((doc) => ({
    migrationId: String(doc["migrationId"]),
    appliedAt: (doc["appliedAt"] as Date) ?? new Date(0),
    description: String(doc["description"] ?? ""),
    ...(doc["detail"] ? { detail: String(doc["detail"]) } : {}),
  }));
}

/**
 * Works out what would happen, without changing anything.
 *
 * Throws {@link UnknownMigrationError} when the ledger names an id this build does
 * not have — the code is older than the data, and proceeding would be a guess.
 */
export async function planMigrations(db: Db): Promise<MigrationPlanEntry[]> {
  const applied = await readAppliedMigrations(db);
  const appliedIds = new Set(applied.map((entry) => entry.migrationId));

  const knownIds = new Set(MIGRATIONS.map((migration) => migration.id));
  const unknown = [...appliedIds].filter((id) => !knownIds.has(id));
  if (unknown.length > 0) throw new UnknownMigrationError(unknown);

  return MIGRATIONS.map((migration) => ({
    id: migration.id,
    description: migration.description,
    rewritesData: migration.rewritesData,
    state: appliedIds.has(migration.id) ? "applied" : "pending",
  }));
}

/**
 * Applies every pending migration, in order.
 *
 * Stops at the first failure. A migration that throws is **not** recorded as
 * applied, so the next run retries it — and because every migration here is
 * idempotent and fails before mutating, a retry is safe.
 */
export async function runMigrations(
  db: Db,
  options: { dryRun?: boolean; log?: (message: string) => void } = {},
): Promise<MigrationRunResult> {
  const log = options.log ?? (() => {});
  const plan = await planMigrations(db);
  const applied: string[] = [];

  if (options.dryRun) {
    for (const entry of plan) {
      if (entry.state !== "pending") continue;
      log(`would apply ${entry.id}${entry.rewritesData ? " (rewrites data)" : ""}`);

      // A dry run of a data migration answers "which documents would change" only if the
      // migration is asked. `inspect` is read-only by contract, and it is the same code path
      // the applied run classifies with, so the two cannot report different numbers.
      const migration = MIGRATIONS.find((candidate) => candidate.id === entry.id);
      if (migration?.inspect) {
        await migration.inspect({ db, log: (message) => log(`  ${message}`) });
      }
    }
    return { plan, applied, unknown: [], dryRun: true };
  }

  const ledger = db.collection(MIGRATIONS_COLLECTION);

  // ── Make the ledger write idempotent, so two runners cannot double-record ──
  //
  // Without a unique index, two processes starting at the same time both read a pending
  // plan and both insert a ledger row for the same migration — so the ledger stops being a
  // faithful account of what the database has been through, which is its whole purpose.
  //
  // The index is created here rather than in `ensureIndexes` because this module owns the
  // ledger. It is idempotent for an identical specification, so calling it on every run is
  // safe, and it is created before the first write rather than after.
  //
  // ── What this does and does not fix ──
  //
  // **Fixed:** duplicate ledger rows. A losing runner's insert raises a duplicate-key error,
  // which is caught below and treated as "another runner recorded this".
  //
  // **Not fixed, and deliberately:** two runners may still *execute* the same migration
  // concurrently. That is safe here because every migration is idempotent and fails before
  // mutating — a property the registry's type and its documentation already require — so the
  // second execution is a no-op rather than a second rewrite. Making execution exclusive
  // would need a claim protocol and a lease, and the evidence does not require one: the
  // documented deployment is a single API and a single adapter, and both connect to the same
  // database at startup. An operator running a second instance concurrently should stop one
  // of them, which `docs/operations/upgrade.md` says.
  await ledger.createIndex({ migrationId: 1 }, { unique: true });

  for (const migration of MIGRATIONS) {
    const entry = plan.find((candidate) => candidate.id === migration.id);
    if (entry?.state === "applied") continue;

    log(`applying ${migration.id}`);
    const detailLines: string[] = [];
    await migration.up({
      db,
      log: (message) => {
        detailLines.push(message);
        log(`  ${message}`);
      },
    });

    try {
      await ledger.insertOne({
        migrationId: migration.id,
        description: migration.description,
        appliedAt: new Date(),
        ...(detailLines.length > 0 ? { detail: detailLines.join("; ") } : {}),
      });
    } catch (error) {
      // Classified from the driver's error code rather than by matching a message, and only
      // for a duplicate key: any other failure must still surface, because a migration whose
      // work succeeded but whose ledger write failed for another reason is a state an
      // operator needs to see.
      if (isDuplicateKeyError(error)) {
        log(
          `another runner recorded ${migration.id} — the work is idempotent, so this is not an error`,
        );
        continue;
      }
      throw error;
    }

    applied.push(migration.id);
  }

  return { plan, applied, unknown: [], dryRun: false };
}

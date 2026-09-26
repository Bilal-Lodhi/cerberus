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
      if (entry.state === "pending") {
        log(`would apply ${entry.id}${entry.rewritesData ? " (rewrites data)" : ""}`);
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

/**
 * MongoDB native client — MCP server data layer.
 *
 * Uses the official MongoDB Node.js driver with no ORM.
 *
 * Schema naming: Cerberus-native collection names are the default. The
 * historical Assessment-era collection names are deliberately NOT supported as
 * fallbacks — this is a fresh open-source repository with no legacy data to
 * stay compatible with. The old → new mapping is documented in
 * docs/migration.md.
 */

import { randomUUID } from "node:crypto";
import { MongoClient, Db, Collection, Document, MongoServerError } from "mongodb";
import {
  COLLECTION_NAMES,
  DEFAULT_DATABASE_NAME,
} from "./tool-names.js";
import { ensureOperationClaimIndexes } from "./operation-claims.js";
import { runMigrations, type MigrationRunResult } from "./migrations.js";

export interface MongoCollections {
  threatScenarios: string;
  sessions: string;
  microEvents: string;
  riskAssessments: string;
  referenceDocuments: string;
  referenceCorpusMeta: string;
  operationClaims: string;
}

export interface MongoConfig {
  uri: string;
  databaseName: string;
  collections: MongoCollections;
}

export const DEFAULT_COLLECTIONS: MongoCollections = { ...COLLECTION_NAMES };

/**
 * Thrown when a new reference document would take the corpus past its ceiling.
 *
 * The corpus is read in full on every risk analysis, so its size is a bound on the work
 * one analysis does as well as on storage. Before this existed the ceiling was a *read*
 * ceiling only: a 201st document was stored and then never returned by a list, so it was
 * invisible rather than refused.
 */
export class ReferenceCorpusLimitError extends Error {
  constructor(
    readonly limit: number,
    readonly count: number,
  ) {
    super(
      `The reference corpus is full: ${count} of ${limit} documents. ` +
        `Remove a document before adding another.`,
    );
    this.name = "ReferenceCorpusLimitError";
  }
}

/**
 * Drops keys whose value is `undefined`.
 *
 * The MongoDB driver serialises `undefined` as BSON `null`, so spreading an
 * object with optional-but-absent fields straight into `$set` silently
 * overwrites existing values with `null`. Every partial update goes through
 * this first.
 */
export function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  const output: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key as keyof T] = value as T[keyof T];
  }
  return output;
}

/**
 * True when an error is MongoDB's duplicate-key violation (E11000).
 *
 * Classified from the driver's error code rather than by matching the message: a
 * message is localised and version-dependent, and a substring test for "11000" would
 * also match an unrelated number in an error's text.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

/** The aggregate counters one ingestion may update on a session document. */
export interface SessionCountsUpdate {
  eventCount: number;
  pasteCount?: number;
  tabSwitchCount?: number;
  /**
   * How many times the monitored window lost focus.
   *
   * Canonical name. The counter used to be called `fullscreenExitCount` and was
   * incremented by **both** `WINDOW_BLUR` and `FULLSCREEN_EXIT`, so its name described
   * one of the two events that produced it: a window blur that was never a fullscreen
   * exit was counted as one. Browser telemetry cannot distinguish the two, so the
   * truthful name is the one that covers what the counter measures.
   *
   * The score contribution is unchanged — it was always gated on "focus was lost", never
   * on "fullscreen was exited" — so this is a naming correction, not a scoring change.
   */
  focusLossCount?: number;
  /**
   * The deprecated spelling of {@link focusLossCount}.
   *
   * Accepted so an existing MCP caller keeps working, and written to the *same* durable
   * field. When both are supplied the larger wins, so a caller that sends both cannot
   * lower the total.
   */
  fullscreenExitCount?: number;
  copyAttemptCount?: number;
  peakRiskScore?: number;
  status?: string;
}

/** The durable field the focus-loss counter lives in. */
export const FOCUS_LOSS_FIELD = "focusLossCount";

/** The deprecated durable field name, read as a fallback for an un-migrated document. */
export const LEGACY_FOCUS_LOSS_FIELD = "fullscreenExitCount";

/**
 * The domain components a session deletion can remove.
 *
 * **Domain names, not collection names.** A caller reasons about "this session's
 * telemetry" and "its assessments"; freezing `micro_events` and `risk_assessments` into a
 * public response would make a collection rename a breaking change to the API contract.
 */
export type SessionDeletionComponent = "session" | "telemetry" | "assessments";

/** Every component, in the order a deletion attempts them. */
export const SESSION_DELETION_COMPONENTS: readonly SessionDeletionComponent[] = [
  "telemetry",
  "assessments",
  "session",
];

/**
 * What a session deletion actually removed, per component.
 *
 * `failed` is empty for a complete deletion. A non-empty `failed` means the deletion ran
 * and only part of it succeeded, which is a **different fact** from "the store did not
 * answer" and has to be reported differently: the first says retrying is safe and
 * necessary, the second says nothing was attempted.
 */
export interface SessionDeletionReport {
  /** Documents removed from each component. */
  session: number;
  telemetry: number;
  assessments: number;
  /** The components whose removal raised. Empty for a complete deletion. */
  failed: SessionDeletionComponent[];
}

/** True when every component was removed, or was already absent. */
export function isCompleteDeletion(report: SessionDeletionReport): boolean {
  return report.failed.length === 0;
}


/**
 * Builds the update document for an aggregate-counter write.
 *
 * Extracted and exported so its shape can be asserted directly rather than by
 * reading the source text. Two properties matter, and both come from a real
 * incident:
 *
 *   - **Counters are monotonic.** They are applied with `$max`, never `$set`.
 *     None of them can legitimately decrease, and `$set` made them depend on what
 *     the API happened to hold in memory — a process that had just restarted held
 *     counters starting at zero, so its first write replaced the durable totals
 *     with the post-restart ones.
 *   - **`status` is set only when supplied.** The MongoDB driver serialises
 *     `undefined` as BSON `null`, so spreading the whole `counts` object into
 *     `$set` clobbered a stored status whenever the caller omitted it. That was
 *     observed live: a session's status became `null` after a counter update.
 *   - **The two focus-loss spellings write one field.** `fullscreenExitCount` is
 *     deprecated in favour of `focusLossCount`, and both map to the same durable field so
 *     a caller on either name sees one counter rather than two that could drift. When
 *     both are supplied the larger wins, so sending both cannot lower the total.
 */
export function buildSessionCountsUpdate(counts: SessionCountsUpdate): Document {
  const { status, focusLossCount, fullscreenExitCount, ...rest } = counts;

  // `compact` is typed to the input, so the focus-loss field is added after it rather
  // than being part of the spread — the two spellings collapse into one key here.
  const counters: Record<string, unknown> = { ...compact(rest) };

  const focusLossCandidates = [focusLossCount, fullscreenExitCount].filter(
    (value): value is number => typeof value === "number",
  );
  if (focusLossCandidates.length > 0) {
    counters[FOCUS_LOSS_FIELD] = Math.max(...focusLossCandidates);
  }

  const update: Document = { $set: { updatedAt: new Date() } };
  if (Object.keys(counters).length > 0) update["$max"] = counters;
  if (status !== undefined) (update["$set"] as Document)["status"] = status;
  return update;
}

/**
 * A batch's **newly accepted** counts, applied additively.
 *
 * ── Why an additive mode exists ───────────────────────────────────────
 *
 * `$max` on an absolute total is monotonic, which is what stopped a restarted process from
 * replacing the durable totals with its post-restart ones. It is **not** correct under more
 * than one writer, and the gap is exact:
 *
 *   process A hydrates `eventCount: 10`, accepts 5 events, writes `$max` 15
 *   process B hydrates `eventCount: 10`, accepts 3 events, writes `$max` 13
 *   durable = max(15, 13) = 15      true total = 10 + 5 + 3 = 18
 *
 * Neither process ever sees the other's batch, so the durable aggregate converges to the
 * largest single process's total rather than to the sum, and the missing counts are never
 * recovered — a later batch by either process continues from its own baseline.
 *
 * An increment has none of that. The delta is a property of the batch, not of the writer's
 * memory, so it cannot be "low" after a restart and it cannot be lost to a concurrent write:
 * MongoDB applies `$inc` atomically per document, so two processes accepting distinct events
 * both count. A replayed batch contributes nothing, because the route sends the delta for the
 * events the store reported as **newly inserted**.
 *
 * ── The monotonic guard ───────────────────────────────────────────────
 *
 * A counter must never decrease, so a negative or non-finite delta is dropped rather than
 * applied. That keeps the storage layer the guarantee rather than the caller's bookkeeping,
 * exactly as `$max` does on the absolute path.
 */
export interface SessionCountsDelta {
  eventCount?: number;
  pasteCount?: number;
  tabSwitchCount?: number;
  focusLossCount?: number;
  /** Deprecated spelling of {@link focusLossCount}. Both map to one durable field. */
  fullscreenExitCount?: number;
  copyAttemptCount?: number;
}

/** The `$inc` document for an additive counter write. */
export function buildSessionCountsDeltaUpdate(delta: SessionCountsDelta): Document {
  const { focusLossCount, fullscreenExitCount, ...rest } = delta;

  const counters: Record<string, number> = {};
  for (const [key, value] of Object.entries(compact(rest))) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      counters[key] = Math.floor(value);
    }
  }

  const focusCandidates = [focusLossCount, fullscreenExitCount].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  if (focusCandidates.length > 0) {
    counters[FOCUS_LOSS_FIELD] = Math.floor(Math.max(...focusCandidates));
  }

  const update: Document = {};
  if (Object.keys(counters).length > 0) update["$inc"] = counters;
  return update;
}

export class MongoStore {
  private client: MongoClient;
  private db: Db | null = null;
  private config: MongoConfig;

  constructor(config?: Partial<MongoConfig>) {
    const uri =
      config?.uri ?? process.env["MONGODB_URI"] ?? "mongodb://localhost:27017";
    const databaseName =
      config?.databaseName ??
      process.env["MONGODB_DATABASE"] ??
      DEFAULT_DATABASE_NAME;

    this.config = {
      uri,
      databaseName,
      collections: {
        ...DEFAULT_COLLECTIONS,
        ...config?.collections,
      },
    };

    this.client = new MongoClient(uri);
  }

  /**
   * Connects, then brings the database up to date.
   *
   * `migrate: false` connects without applying anything, which is what the
   * migration CLI needs: `connect()` would apply the migrations and the plan an
   * operator wants to inspect would already be gone. Nothing else should pass it.
   */
  async connect(options: { migrate?: boolean } = {}): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.config.databaseName);

    if (options.migrate === false) return;

    // ── Migrations run BEFORE indexes, and the order is load-bearing ──
    //
    // The unique index on `(sessionId, eventId)` cannot be created while
    // duplicates exist, and duplicates are exactly what a database that ran the
    // pre-fix ingestion path holds. Creating indexes first would make that
    // deployment fail to start with an opaque duplicate-key error instead of
    // being repaired. Migration 0001 removes those duplicates; the index then
    // succeeds.
    await this.runMigrations();

    await this.ensureIndexes();

    // Reconcile the corpus counter at startup, where nothing can be in flight.
    //
    // This is the one place the counter may be *lowered*, and it is the only safe one: a
    // claim that incremented the counter but did not insert its document — a process that
    // died between the two — would otherwise leak that reservation for the life of the
    // database, permanently shrinking the corpus by one. With no in-flight claims there
    // is nothing to discard.
    //
    // A failure here must not stop the process: the counter is an optimisation for
    // atomicity, and the claim path raises it when it has fallen behind. A store that
    // cannot reconcile still enforces the ceiling correctly, only less efficiently.
    try {
      await this.reconcileReferenceDocumentCount();
    } catch (error) {
      console.warn(
        `[mongo] reference-corpus counter could not be reconciled at startup: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Applies pending migrations, logging the outcome.
   *
   * Called by {@link connect}. Exposed so a CLI can run a dry run, and so a test
   * can drive the runner against a disposable database.
   */
  async runMigrations(options: { dryRun?: boolean } = {}): Promise<MigrationRunResult> {
    const db = this.dbOrThrow();
    const result = await runMigrations(db, {
      ...options,
      log: (message) => console.log(`[migrations] ${message}`),
    });

    if (result.dryRun) {
      const pending = result.plan.filter((entry) => entry.state === "pending");
      console.log(
        `[migrations] dry run: ${pending.length} pending, ` +
          `${result.plan.length - pending.length} already applied`,
      );
    } else if (result.applied.length > 0) {
      console.log(`[migrations] applied ${result.applied.join(", ")}`);
    } else {
      console.log(`[migrations] up to date (${result.plan.length} migration(s) known)`);
    }

    return result;
  }

  async disconnect(): Promise<void> {
    await this.client.close();
    this.db = null;
  }

  private dbOrThrow(): Db {
    if (!this.db) {
      throw new Error("MongoDB not connected. Call connect() first.");
    }
    return this.db;
  }

  /** Exposed for diagnostics and tests. */
  get collectionNames(): MongoCollections {
    return { ...this.config.collections };
  }

  // ─── Collection Accessors ──────────────────────────────────────

  private collection(name: keyof MongoCollections): Collection<Document> {
    return this.dbOrThrow().collection(this.config.collections[name]);
  }

  // ─── Index Creation ────────────────────────────────────────────

  /**
   * Creates the indexes Cerberus relies on. Safe to call repeatedly;
   * `createIndex` is idempotent for identical specifications.
   */
  async ensureIndexes(): Promise<void> {
    const sessions = this.collection("sessions");
    const microEvents = this.collection("microEvents");
    const riskAssessments = this.collection("riskAssessments");
    const threatScenarios = this.collection("threatScenarios");
    const referenceDocuments = this.collection("referenceDocuments");

    await sessions.createIndex({ sessionId: 1 }, { unique: true });
    await sessions.createIndex({ employeeId: 1, auditId: 1 });
    await sessions.createIndex({ createdAt: -1 });

    await microEvents.createIndex({ sessionId: 1, timestamp: -1 });
    await microEvents.createIndex({ eventType: 1 });
    // Durable idempotency: one document per (session, event). A retried batch —
    // including one retried after a restart, when the in-process dedup ring is
    // empty — is stored once. This is the only dedup layer that survives a
    // restart, and it is why the ingest path applies only the events the store
    // reports as newly inserted.
    await microEvents.createIndex({ sessionId: 1, eventId: 1 }, { unique: true });

    await riskAssessments.createIndex({ sessionId: 1, generatedAt: -1 });
    await riskAssessments.createIndex({ employeeId: 1 });
    // Durable identity for a risk assessment, so the one artefact of the paid analysis
    // path is stored once per incident. Without it, `storeRiskAssessment` was a plain
    // insert and a re-analysis after a restart wrote a second row for one incident —
    // which the module header of `guardian.ts` wrongly described as an implemented
    // dedup layer.
    //
    // Migration 0002 removes any pre-existing duplicates first, and runs before this
    // (see `connect`), because this index cannot be created while they exist.
    //
    // `sparse` is deliberately NOT used: a document without a `riskAssessmentId` would
    // be unconstrained by a sparse index, and `storeRiskAssessment` always writes one,
    // so a missing id means a hand-written document rather than a supported shape.
    await riskAssessments.createIndex({ riskAssessmentId: 1 }, { unique: true });

    await threatScenarios.createIndex({ "metadata.matrixId": 1 }, { unique: true });
    await threatScenarios.createIndex({ "metadata.generatedAt": -1 });

    // The reference corpus is read in full on every risk analysis, so it is
    // indexed by its own id and by recency.
    await referenceDocuments.createIndex({ referenceId: 1 }, { unique: true });
    await referenceDocuments.createIndex({ updatedAt: -1 });

    // ── The paid-operation claim ─────────────────────────────────────
    //
    // Two indexes, and neither is an optimisation. The unique index on
    // `(routeFamily, keyHash)` **is** the mutual exclusion for a paid operation: two API
    // processes racing one `Idempotency-Key` both attempt the insert, the index refuses
    // the second, and the loser reads the winner's record instead of calling the
    // provider. Without it, a retry after a lost response spends a second time and
    // nothing says so. The TTL index on `expiresAt` bounds the collection, which holds a
    // record per caller-supplied key and would otherwise grow with traffic forever.
    //
    // The specification lives in `operation-claims.ts` and is applied by migration `0004`
    // as well as here, from that one list. A database is brought up to date by whichever
    // runs first, and two declarations that drifted would make the second fail with
    // `IndexOptionsConflict` — so the list is shared rather than repeated.
    await ensureOperationClaimIndexes(this.collection("operationClaims"));
  }

  // ─── Threat Scenario Operations ────────────────────────────────

  async storeThreatScenario(scenario: Document): Promise<string> {
    const result = await this.collection("threatScenarios").insertOne({
      ...scenario,
      _createdAt: new Date(),
    });
    return result.insertedId.toString();
  }

  async getThreatScenario(matrixId: string): Promise<Document | null> {
    return this.collection("threatScenarios").findOne({
      "metadata.matrixId": matrixId,
    });
  }

  // ─── Session Operations ────────────────────────────────────────

  async createSession(session: Document): Promise<string> {
    const now = new Date();
    await this.collection("sessions").updateOne(
      { sessionId: session["sessionId"] },
      {
        $setOnInsert: {
          // "active" is the only creation status: it is a member of both the
          // ActiveSession vocabulary and the MCP SESSION_STATUSES set, so a
          // freshly created session is always a legal status everywhere.
          status: "active",
          ...compact(session),
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    return session["sessionId"] as string;
  }

  async getSession(sessionId: string): Promise<Document | null> {
    return this.collection("sessions").findOne({ sessionId });
  }

  async updateSession(sessionId: string, update: Document): Promise<void> {
    await this.collection("sessions").updateOne(
      { sessionId },
      { $set: { ...compact(update), updatedAt: new Date() } },
    );
  }

  /**
   * Writes the terminal workspace content, optionally gated on the document's state.
   *
   * ── Why this is not just `updateSession` ──────────────────────────────
   *
   * `monitored_sessions.terminalContent` is one fact — "the workspace as monitoring ended" —
   * and `updateSession` writes it unconditionally, which makes two processes terminating the
   * same session decide it by arrival order. The last writer wins, and the last writer is
   * whichever process happened to hold the **staler** reconstruction of the workspace.
   *
   * `expectedStatuses` turns the write into a compare-and-set on the lifecycle state, so the
   * process whose `terminate` transition actually applied is the one that owns the field.
   * `onlyIfAbsent` narrows it further, to the repair case: a session that is already
   * terminated but holds no content — because the winning process died between the transition
   * and the write — may be repaired by a later caller, while a session that already holds
   * content never is.
   *
   * Both options are optional, so a direct MCP client calling the tool with neither keeps the
   * previous unconditional behaviour and the published capability is unchanged.
   *
   * Returns whether a document matched. `false` means the write did not happen — the session
   * does not exist, its status was not one of `expectedStatuses`, or content was already
   * present and `onlyIfAbsent` was set.
   */
  async updateSessionTerminalContent(
    sessionId: string,
    terminalContent: string,
    options: { expectedStatuses?: readonly string[]; onlyIfAbsent?: boolean } = {},
  ): Promise<boolean> {
    const filter: Document = { sessionId };

    const expected = options.expectedStatuses;
    if (expected && expected.length > 0) {
      filter["status"] = { $in: [...expected] };
    }

    if (options.onlyIfAbsent) {
      // A document that has never been written holds no field; one written with an empty
      // string holds a field that says nothing. Both are "no content", and neither should
      // block a repair.
      filter["$or"] = [
        { terminalContent: { $exists: false } },
        { terminalContent: null },
        { terminalContent: "" },
      ];
    }

    const result = await this.collection("sessions").updateOne(filter, {
      $set: { terminalContent, updatedAt: new Date() },
    });

    return result.matchedCount > 0;
  }

  /**
   * Permanently deletes a session and every document derived from it.
   *
   * ── The order is load-bearing ─────────────────────────────────────────
   *
   * The **derived** documents are removed first and the session document **last**. The
   * reverse order — which this used to use — makes a partial failure unrecoverable: the
   * session document is what identifies its telemetry, so removing it first leaves
   * `micro_events` and `risk_assessments` orphaned, unfindable by any query and
   * unreportable by any surface. Deleting the children first means a failure leaves the
   * identifying document in place, so the operation is **retryable** and nothing is
   * orphaned.
   *
   * ── Why each component is caught separately ───────────────────────────
   *
   * A single `Promise.all` over all three reports nothing about which one failed, so a
   * partial deletion was reported as a complete one. Each component is attempted on its
   * own and its outcome recorded, so the caller can say exactly what happened.
   *
   * The session document is **not** attempted when a derived component failed, because
   * removing it would destroy the only way to find the rest. That is a deliberate
   * refusal, not an omission: the report says so through `failed`.
   */
  async deleteSession(sessionId: string): Promise<SessionDeletionReport> {
    const report: SessionDeletionReport = {
      session: 0,
      telemetry: 0,
      assessments: 0,
      failed: [],
    };

    const derived: Array<["telemetry" | "assessments", "microEvents" | "riskAssessments"]> = [
      ["telemetry", "microEvents"],
      ["assessments", "riskAssessments"],
    ];

    for (const [component, collection] of derived) {
      try {
        report[component] = (await this.collection(collection).deleteMany({ sessionId }))
          .deletedCount;
      } catch {
        report.failed.push(component);
      }
    }

    // Only when every derived document is gone: see the note above.
    if (report.failed.length === 0) {
      try {
        report.session = (await this.collection("sessions").deleteOne({ sessionId }))
          .deletedCount;
      } catch {
        report.failed.push("session");
      }
    }

    return report;
  }

  async listSessions(): Promise<Document[]> {
    return this.collection("sessions")
      .find(
        {},
        {
          projection: {
            sessionId: 1,
            employeeId: 1,
            auditId: 1,
            matrixId: 1,
            targetSystem: 1,
            status: 1,
            eventCount: 1,
            pasteCount: 1,
            tabSwitchCount: 1,
            // Both spellings are projected: a document written before migration 0003 still
            // carries the legacy field, and a list that projected only the canonical name
            // would report zero for it.
            focusLossCount: 1,
            fullscreenExitCount: 1,
            copyAttemptCount: 1,
            peakRiskScore: 1,
            overallRiskScore: 1,
            riskIndex: 1,
            deployedAt: 1,
            createdAt: 1,
            updatedAt: 1,
            _id: 0,
          },
        },
      )
      .sort({ createdAt: -1 })
      .toArray();
  }

  /**
   * Updates the aggregate counters on a session document after micro-event
   * ingestion.
   *
   * Counters are applied with `$max`, not `$set`. They are monotonic: none of
   * them can legitimately decrease, and `$set` made them depend on what the API
   * happened to have in memory. A process that had just restarted held counters
   * starting at zero, so its first write replaced the durable totals with the
   * post-restart ones — the comment below used to claim the opposite. `$max` makes
   * the storage layer the guarantee rather than the caller's bookkeeping.
   *
   * `status` is a state, not a counter, so it stays `$set`.
   */
  async updateSessionCounts(
    sessionId: string,
    counts: SessionCountsUpdate,
    options: { delta?: SessionCountsDelta } = {},
  ): Promise<void> {
    const update = buildSessionCountsUpdate(counts);

    if (options.delta) {
      const increment = buildSessionCountsDeltaUpdate(options.delta)["$inc"] as
        | Record<string, number>
        | undefined;

      if (increment) {
        // MongoDB refuses an update that touches one path through two operators, so a field
        // present in both is removed from `$max` rather than making the whole write fail.
        // The increment is the correct one for it: an absolute total and a delta are not two
        // opinions about the same field, and `$max` on a stale absolute is what loses a
        // concurrent writer's events.
        const maxed = update["$max"] as Record<string, unknown> | undefined;
        if (maxed) {
          for (const key of Object.keys(increment)) delete maxed[key];
          if (Object.keys(maxed).length === 0) delete update["$max"];
        }
        update["$inc"] = increment;
      }
    }

    await this.collection("sessions").updateOne({ sessionId }, update);
  }

  /**
   * Flips the session status (e.g. "active" → "locked" on high risk).
   * Returns true when a session document actually matched, so callers can
   * distinguish "status changed" from "no such session".
   *
   * ── Why the optional predicate exists ─────────────────────────────────
   *
   * Without it this is an unconditional `$set`, which makes every status change
   * last-writer-wins: `terminate` racing `auto-lock` is decided by arrival order and
   * nothing detects the conflict. `expectedStatuses` turns the write into a
   * compare-and-set — the document is only updated while its current status is one
   * of the listed values — so a transition that lost a race reports
   * `matchedCount === 0` instead of silently overwriting the winner.
   *
   * It is optional and defaults to the previous unconditional behaviour, so every
   * existing caller is unaffected. A single-document predicate is enough here: it
   * closes the race without requiring a transaction, and therefore without requiring
   * a replica set the documented single-node deployment does not have.
   *
   * An empty `expectedStatuses` array is treated as "no predicate" rather than
   * "match nothing": an empty `$in` matches nothing, which would turn a caller's
   * empty list into a silent no-op instead of the unconditional write it asked for.
   */
  async setSessionStatus(
    sessionId: string,
    status: string,
    options: { expectedStatuses?: readonly string[] } = {},
  ): Promise<boolean> {
    const filter: Document = { sessionId };
    const expected = options.expectedStatuses;
    if (expected && expected.length > 0) {
      filter["status"] = { $in: [...expected] };
    }

    const result = await this.collection("sessions").updateOne(filter, {
      $set: { status, updatedAt: new Date() },
    });
    return result.matchedCount > 0;
  }

  // ─── Micro-Event Operations ────────────────────────────────────

  /**
   * Stores a batch of micro-events idempotently, keyed on `(sessionId, eventId)`.
   *
   * Each event is an upsert with `$setOnInsert`, so re-sending a batch inserts
   * nothing the second time and the driver reports exactly which events were new
   * via `upsertedIds`. That report is the point: the API applies **only** the
   * accepted events to its in-memory counters, so a retry cannot inflate them —
   * including a retry after a restart, when the in-process dedup ring is empty.
   *
   * `ordered: false` so one failure does not abandon the rest of the batch. An
   * upsert with `$setOnInsert` does not raise a duplicate-key error, so the
   * ordinary replay case is not an error path at all.
   *
   * An event with no `eventId` cannot be deduplicated and is always accepted; the
   * route validates `eventId` as required, so this is a fallback rather than a
   * supported shape.
   */
  async ingestMicroEvents(
    events: Document[],
  ): Promise<{ acceptedEventIds: string[]; duplicateEventIds: string[] }> {
    if (events.length === 0) return { acceptedEventIds: [], duplicateEventIds: [] };

    const ingestedAt = new Date();
    const operations = events.map((event) => {
      const eventId = typeof event["eventId"] === "string" ? event["eventId"] : "";
      return {
        updateOne: {
          filter: { sessionId: event["sessionId"], eventId },
          update: { $setOnInsert: { ...event, eventId, _ingestedAt: ingestedAt } },
          upsert: true,
        },
      };
    });

    const result = await this.collection("microEvents").bulkWrite(operations, {
      ordered: false,
    });

    const acceptedEventIds: string[] = [];
    const duplicateEventIds: string[] = [];

    events.forEach((event, index) => {
      const eventId = String(event["eventId"] ?? "");
      if (result.upsertedIds?.[index] !== undefined) acceptedEventIds.push(eventId);
      else duplicateEventIds.push(eventId);
    });

    return { acceptedEventIds, duplicateEventIds };
  }

  async getSessionEvents(
    sessionId: string,
    options?: { limit?: number; eventType?: string },
  ): Promise<Document[]> {
    const query: Document = { sessionId };
    if (options?.eventType) query["eventType"] = options.eventType;

    return this.collection("microEvents")
      .find(query)
      .sort({ timestamp: -1 })
      .limit(options?.limit ?? 500)
      .toArray();
  }

  async countEventType(sessionId: string, eventType: string): Promise<number> {
    return this.collection("microEvents").countDocuments({ sessionId, eventType });
  }

  // ─── Risk Assessment Operations ────────────────────────────────

  /**
   * Stores one risk assessment, idempotently on `riskAssessmentId`.
   *
   * ── Why this is not a plain insert ────────────────────────────────────
   *
   * This is the only durable artefact of the paid analysis path. As a plain insert it
   * had no identity, so a re-analysis after a restart wrote a **second row for one
   * incident** — inflating `riskSummary` on the review surface and double-counting in
   * the auditor. A unique index on `riskAssessmentId` makes the write idempotent, and
   * migration 0002 removes any pre-existing duplicates so that index can exist.
   *
   * ── Why the duplicate-key path is handled rather than pre-checked ─────
   *
   * A read-then-insert would race: two concurrent analyses of the same incident would
   * both see nothing and both insert. The unique index is the arbiter, so the insert is
   * attempted and the duplicate-key error is the *expected* outcome of a retry. That
   * is also why this cannot use `$setOnInsert` with an upsert the way
   * `ingestMicroEvents` does: an upsert would silently succeed and the caller would not
   * learn whether the evidence was already there.
   *
   * An assessment with no `riskAssessmentId` gets one. It has no identity to be
   * idempotent on, so a retry stores a second row — which is the pre-existing behaviour
   * for that shape, and `parseRiskAssessment` always supplies one at the provider
   * boundary.
   */
  async storeRiskAssessment(
    report: Document,
  ): Promise<{ documentId: string; riskAssessmentId: string; inserted: boolean }> {
    const supplied = report["riskAssessmentId"];
    const riskAssessmentId =
      typeof supplied === "string" && supplied.length > 0 ? supplied : randomUUID();

    try {
      const result = await this.collection("riskAssessments").insertOne({
        ...report,
        riskAssessmentId,
        _generatedAt: new Date(),
      });
      return {
        documentId: result.insertedId.toString(),
        riskAssessmentId,
        inserted: true,
      };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;

      // A retry, or a concurrent analysis of the same incident. The evidence already
      // exists, so the existing document's id is returned.
      const existing = await this.collection("riskAssessments").findOne(
        { riskAssessmentId },
        { projection: { _id: 1 } },
      );
      return {
        documentId: existing?.["_id"]?.toString() ?? riskAssessmentId,
        riskAssessmentId,
        inserted: false,
      };
    }
  }

  /**
   * Risk assessments for one session, newest first.
   *
   * `limit` is optional and unbounded by default, which preserves the previous behaviour
   * for every existing caller. A caller that needs one field from the latest assessment —
   * the terminal-content owner, for instance — passes `limit: 1` rather than reading the
   * whole history.
   */
  async getRiskAssessments(
    sessionId: string,
    options: { limit?: number } = {},
  ): Promise<Document[]> {
    const cursor = this.collection("riskAssessments")
      .find({ sessionId })
      .sort({ generatedAt: -1 });
    // `.limit(0)` means "no limit" in MongoDB, so 0 is treated as "not specified" rather
    // than passed down. The tool layer is where "0 means none" lives, and it skips the
    // query instead.
    if (typeof options.limit === "number" && options.limit > 0) {
      cursor.limit(options.limit);
    }
    return cursor.toArray();
  }

  async getEmployeeRiskHistory(employeeId: string): Promise<Document[]> {
    return this.collection("riskAssessments")
      .find({ employeeId })
      .sort({ generatedAt: -1 })
      .toArray();
  }

  // ─── Reference Corpus Operations ───────────────────────────────

  /**
   * The `_id` of the corpus counter document.
   *
   * A fixed id so there is exactly one, and so a conditional `$inc` on it is the single
   * arbiter of the ceiling.
   */
  private static readonly CORPUS_COUNTER_ID = "reference_documents";

  /**
   * The corpus size, from the counter.
   *
   * Reads the counter rather than counting the collection, and reconciles it first when
   * it is absent — so a database that predates the counter, or one whose documents were
   * written outside this store, is measured correctly rather than reported as empty.
   */
  async referenceDocumentCount(): Promise<number> {
    const counters = this.collection("referenceCorpusMeta");
    const existing = await counters.findOne({ _id: MongoStore.CORPUS_COUNTER_ID as never });
    if (existing && typeof existing["count"] === "number") {
      return existing["count"];
    }
    return this.reconcileReferenceDocumentCount();
  }

  /**
   * Recomputes the corpus counter from the collection and writes it back.
   *
   * Sets the counter to the **exact** document count, which is only safe when no claim is
   * outstanding — a claim that has incremented the counter but not yet inserted its
   * document would be discarded, handing the same slot out twice. So this is called at
   * `connect()` (where nothing is in flight) and by an operator, and never from the claim
   * path. The claim path uses {@link raiseReferenceDocumentCount}, which cannot lower the
   * counter.
   */
  async reconcileReferenceDocumentCount(): Promise<number> {
    const count = await this.collection("referenceDocuments").countDocuments({});
    await this.collection("referenceCorpusMeta").updateOne(
      { _id: MongoStore.CORPUS_COUNTER_ID as never },
      { $set: { count, updatedAt: new Date() } },
      { upsert: true },
    );
    return count;
  }

  /**
   * Raises the corpus counter to at least the real document count. **Never lowers it.**
   *
   * The counter is a count of *reservations*, not of documents: a claim increments it and
   * the insert completes it, so between the two the counter is legitimately ahead of the
   * collection. Lowering it to the document count in that window would discard the
   * reservation and let the same slot be claimed twice — which is exactly the bug this
   * method exists to avoid.
   *
   * Raising it is always safe and is the direction that matters: a counter *behind*
   * reality (after a restore, or a write that bypassed this store) would let the corpus
   * grow past its ceiling. `$max` fixes that without ever losing a claim.
   */
  private async raiseReferenceDocumentCount(): Promise<number> {
    const actual = await this.collection("referenceDocuments").countDocuments({});
    await this.collection("referenceCorpusMeta").updateOne(
      { _id: MongoStore.CORPUS_COUNTER_ID as never },
      {
        // `$max` alone is enough on an insert: MongoDB treats a missing field as lower
        // than any number, so the upserted document takes `actual`. Adding a
        // `$setOnInsert` for the same field is rejected as a path conflict.
        $max: { count: actual },
        $set: { updatedAt: new Date() },
      },
      { upsert: true },
    );
    return this.referenceDocumentCount();
  }

  /**
   * Claims one slot in the corpus, atomically.
   *
   * The conditional `$inc` is the whole mechanism: MongoDB applies a single-document
   * update atomically, so of N concurrent callers only those that find `count < limit`
   * can increment, and exactly `limit` slots exist. A count-then-insert would let two
   * callers at one below the limit both read the same count and both insert.
   *
   * The upward reconcile before the claim is what makes a counter that has fallen behind
   * reality self-healing, and it is safe to run concurrently because `$max` can only
   * raise. The reconcile *after* a refusal exists for the same reason and runs only when
   * the claim already failed, so it cannot lose a slot that is still in flight.
   */
  private async claimReferenceDocumentSlot(limit: number): Promise<number> {
    await this.raiseReferenceDocumentCount();

    const counters = this.collection("referenceCorpusMeta");
    const filter = {
      _id: MongoStore.CORPUS_COUNTER_ID as never,
      count: { $lt: limit },
    };

    let claim = await counters.updateOne(filter, { $inc: { count: 1 } });
    if (claim.matchedCount === 0) {
      const reconciled = await this.raiseReferenceDocumentCount();
      if (reconciled >= limit) throw new ReferenceCorpusLimitError(limit, reconciled);

      claim = await counters.updateOne(filter, { $inc: { count: 1 } });
      if (claim.matchedCount === 0) {
        // Reconciled to below the limit and still refused: another caller took the last
        // slot between the reconcile and the retry.
        throw new ReferenceCorpusLimitError(limit, await this.referenceDocumentCount());
      }
    }

    return this.referenceDocumentCount();
  }

  /** Releases a claimed slot. Best-effort: a floor of zero keeps it sane. */
  private async releaseReferenceDocumentSlot(): Promise<void> {
    await this.collection("referenceCorpusMeta").updateOne(
      { _id: MongoStore.CORPUS_COUNTER_ID as never, count: { $gt: 0 } },
      { $inc: { count: -1 } },
    );
  }

  /**
   * Upserts one operator-managed reference document, enforcing the corpus ceiling.
   *
   * Idempotent on `referenceId`, so re-submitting the same document **updates** it
   * rather than creating a duplicate that would double-count in similarity scoring — and
   * an update is always allowed, because it does not grow the corpus. Only a genuinely
   * new document claims a slot.
   *
   * The ceiling used to be a *read* ceiling: `listReferenceDocuments` returns at most
   * `MAX_REFERENCE_DOCUMENTS`, so a 201st document was stored and then never returned —
   * invisible rather than refused, and silently excluded from every similarity
   * comparison. It is now a store-side rejection with a stable error.
   */
  async storeReferenceDocument(
    document: Document,
    options: { limit?: number } = {},
  ): Promise<{ referenceId: string; created: boolean; count: number }> {
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const referenceId = document["referenceId"];
    const now = new Date();
    const collection = this.collection("referenceDocuments");

    // An update of an existing document is always allowed, and never claims a slot.
    const updated = await collection.updateOne(
      { referenceId },
      {
        $set: { ...compact(document), updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
    );
    if (updated.matchedCount > 0) {
      return {
        referenceId: referenceId as string,
        created: false,
        count: await this.referenceDocumentCount(),
      };
    }

    // A new document: claim a slot before writing it, so the ceiling cannot be exceeded.
    const countAfterClaim = await this.claimReferenceDocumentSlot(limit);

    try {
      await collection.insertOne({ ...compact(document), createdAt: now, updatedAt: now });
    } catch (error) {
      // The slot was claimed but the document was not written, so give the slot back
      // rather than leaking it — otherwise a failed create would permanently shrink the
      // corpus.
      await this.releaseReferenceDocumentSlot();
      throw error;
    }

    return { referenceId: referenceId as string, created: true, count: countAfterClaim };
  }

  /** Lists reference documents, newest first. */
  async listReferenceDocuments(limit: number): Promise<Document[]> {
    return this.collection("referenceDocuments")
      .find(
        {},
        {
          projection: {
            referenceId: 1,
            label: 1,
            content: 1,
            tags: 1,
            createdAt: 1,
            updatedAt: 1,
            _id: 0,
          },
        },
      )
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Removes one reference document and releases its slot.
   *
   * The slot is released **only when a document was actually removed**, so a delete for
   * an unknown id cannot shrink the counter and hand out a slot twice.
   */
  async deleteReferenceDocument(referenceId: string): Promise<boolean> {
    const result = await this.collection("referenceDocuments").deleteOne({
      referenceId,
    });
    if (result.deletedCount === 0) return false;

    await this.releaseReferenceDocumentSlot();
    return true;
  }

  // ─── Health Check ──────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      await this.dbOrThrow().command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  isConnected(): boolean {
    return this.db !== null;
  }
}

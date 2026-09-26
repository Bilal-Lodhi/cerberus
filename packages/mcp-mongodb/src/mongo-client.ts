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

import { MongoClient, Db, Collection, Document } from "mongodb";
import {
  COLLECTION_NAMES,
  DEFAULT_DATABASE_NAME,
} from "./tool-names.js";
import { runMigrations, type MigrationRunResult } from "./migrations.js";

export interface MongoCollections {
  threatScenarios: string;
  sessions: string;
  microEvents: string;
  riskAssessments: string;
  referenceDocuments: string;
}

export interface MongoConfig {
  uri: string;
  databaseName: string;
  collections: MongoCollections;
}

export const DEFAULT_COLLECTIONS: MongoCollections = { ...COLLECTION_NAMES };

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

/** The aggregate counters one ingestion may update on a session document. */
export interface SessionCountsUpdate {
  eventCount: number;
  pasteCount?: number;
  tabSwitchCount?: number;
  fullscreenExitCount?: number;
  copyAttemptCount?: number;
  peakRiskScore?: number;
  status?: string;
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
 */
export function buildSessionCountsUpdate(counts: SessionCountsUpdate): Document {
  const { status, ...counterFields } = counts;
  const counters = compact(counterFields);

  const update: Document = { $set: { updatedAt: new Date() } };
  if (Object.keys(counters).length > 0) update["$max"] = counters;
  if (status !== undefined) (update["$set"] as Document)["status"] = status;
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

    await threatScenarios.createIndex({ "metadata.matrixId": 1 }, { unique: true });
    await threatScenarios.createIndex({ "metadata.generatedAt": -1 });

    // The reference corpus is read in full on every risk analysis, so it is
    // indexed by its own id and by recency.
    await referenceDocuments.createIndex({ referenceId: 1 }, { unique: true });
    await referenceDocuments.createIndex({ updatedAt: -1 });
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

  async deleteSession(sessionId: string): Promise<boolean> {
    const sessionResult = await this.collection("sessions").deleteOne({ sessionId });
    await Promise.all([
      this.collection("microEvents").deleteMany({ sessionId }),
      this.collection("riskAssessments").deleteMany({ sessionId }),
    ]);
    return sessionResult.deletedCount > 0;
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
  ): Promise<void> {
    await this.collection("sessions").updateOne(
      { sessionId },
      buildSessionCountsUpdate(counts),
    );
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

  async storeRiskAssessment(report: Document): Promise<string> {
    const result = await this.collection("riskAssessments").insertOne({
      ...report,
      _generatedAt: new Date(),
    });
    return result.insertedId.toString();
  }

  async getRiskAssessments(sessionId: string): Promise<Document[]> {
    return this.collection("riskAssessments")
      .find({ sessionId })
      .sort({ generatedAt: -1 })
      .toArray();
  }

  async getEmployeeRiskHistory(employeeId: string): Promise<Document[]> {
    return this.collection("riskAssessments")
      .find({ employeeId })
      .sort({ generatedAt: -1 })
      .toArray();
  }

  // ─── Reference Corpus Operations ───────────────────────────────

  /**
   * Upserts one operator-managed reference document.
   *
   * Idempotent on `referenceId`, so re-submitting the same document updates it
   * rather than creating a duplicate that would double-count in similarity
   * scoring.
   */
  async storeReferenceDocument(document: Document): Promise<string> {
    const now = new Date();
    await this.collection("referenceDocuments").updateOne(
      { referenceId: document["referenceId"] },
      {
        $set: { ...compact(document), updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    return document["referenceId"] as string;
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

  async deleteReferenceDocument(referenceId: string): Promise<boolean> {
    const result = await this.collection("referenceDocuments").deleteOne({
      referenceId,
    });
    return result.deletedCount > 0;
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

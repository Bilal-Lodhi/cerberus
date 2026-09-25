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

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.config.databaseName);
    await this.ensureIndexes();
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
   * Updates live aggregate counts on the session document after micro-event
   * ingestion so the console session list stays accurate after a restart.
   */
  async updateSessionCounts(
    sessionId: string,
    counts: {
      eventCount: number;
      pasteCount?: number;
      tabSwitchCount?: number;
      copyAttemptCount?: number;
      peakRiskScore?: number;
      status?: string;
    },
  ): Promise<void> {
    await this.collection("sessions").updateOne(
      { sessionId },
      { $set: { ...compact(counts), updatedAt: new Date() } },
    );
  }

  /**
   * Flips the session status (e.g. "active" → "locked" on high risk).
   * Returns true when a session document actually matched, so callers can
   * distinguish "status changed" from "no such session".
   */
  async setSessionStatus(sessionId: string, status: string): Promise<boolean> {
    const result = await this.collection("sessions").updateOne(
      { sessionId },
      { $set: { status, updatedAt: new Date() } },
    );
    return result.matchedCount > 0;
  }

  // ─── Micro-Event Operations ────────────────────────────────────

  async ingestMicroEvents(events: Document[]): Promise<number> {
    if (events.length === 0) return 0;
    const enriched = events.map((event) => ({ ...event, _ingestedAt: new Date() }));
    const result = await this.collection("microEvents").insertMany(enriched);
    return result.insertedCount;
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

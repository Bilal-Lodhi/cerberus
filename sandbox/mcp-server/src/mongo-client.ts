/**
 * MongoDB Atlas Native Client — MCP Server Data Layer
 * Uses the official MongoDB Node.js driver with zero ORM dependencies.
 */

import { MongoClient, Db, Collection, Document } from "mongodb";

export interface MongoConfig {
  uri: string;
  databaseName: string;
  collections: {
    testSuites: string;
    sessions: string;
    microEvents: string;
    suspicionReports: string;
  };
}

const DEFAULT_COLLECTIONS = {
  testSuites: "test_suites",
  sessions: "assessment_sessions",
  microEvents: "micro_events",
  suspicionReports: "suspicion_reports",
};

export class MongoStore {
  private client: MongoClient;
  private db: Db | null = null;
  private config: MongoConfig;

  constructor(config?: Partial<MongoConfig>) {
    const uri = config?.uri ?? process.env["MONGODB_URI"] ?? "mongodb://localhost:27017";
    const databaseName = config?.databaseName ?? process.env["MONGODB_DATABASE"] ?? "gorilla_agents";

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

    // Create indexes for performance
    await this.ensureIndexes();
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }

  private dbOrThrow(): Db {
    if (!this.db) {
      throw new Error("MongoDB not connected. Call connect() first.");
    }
    return this.db;
  }

  // ─── Collection Accessors ──────────────────────────────────────

  private collection(name: keyof MongoConfig["collections"]): Collection<Document> {
    return this.dbOrThrow().collection(this.config.collections[name]);
  }

  // ─── Index Creation ────────────────────────────────────────────

  private async ensureIndexes(): Promise<void> {
    const sessions = this.collection("sessions");
    const microEvents = this.collection("microEvents");
    const suspicionReports = this.collection("suspicionReports");
    const testSuites = this.collection("testSuites");

    await sessions.createIndex({ sessionId: 1 }, { unique: true });
    await sessions.createIndex({ candidateId: 1, assessmentId: 1 });
    await sessions.createIndex({ createdAt: -1 });

    await microEvents.createIndex({ sessionId: 1, timestamp: -1 });
    await microEvents.createIndex({ eventType: 1 });

    await suspicionReports.createIndex({ sessionId: 1, generatedAt: -1 });
    await suspicionReports.createIndex({ candidateId: 1 });

    await testSuites.createIndex({ "metadata.suiteId": 1 }, { unique: true });
    await testSuites.createIndex({ "metadata.generatedAt": -1 });
  }

  // ─── Test Suite Operations ─────────────────────────────────────

  async storeTestSuite(suite: Document): Promise<string> {
    const result = await this.collection("testSuites").insertOne({
      ...suite,
      _createdAt: new Date(),
    });
    return result.insertedId.toString();
  }

  async getTestSuite(suiteId: string): Promise<Document | null> {
    return this.collection("testSuites").findOne({ "metadata.suiteId": suiteId });
  }

  // ─── Session Operations ────────────────────────────────────────

  async createSession(session: Document): Promise<string> {
    const now = new Date();
    await this.collection("sessions").updateOne(
      { sessionId: session.sessionId },
      {
        $setOnInsert: {
          ...session,
          status: "in_progress",
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true }
    );
    return session.sessionId as string;
  }

  async getSession(sessionId: string): Promise<Document | null> {
    return this.collection("sessions").findOne({ sessionId });
  }

  async updateSession(sessionId: string, update: Document): Promise<void> {
    await this.collection("sessions").updateOne(
      { sessionId },
      { $set: { ...update, updatedAt: new Date() } }
    );
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    // Delete the session document and all associated data
    const sessionResult = await this.collection("sessions").deleteOne({ sessionId });
    // Also clean up associated micro-events and suspicion reports
    await Promise.all([
      this.collection("microEvents").deleteMany({ sessionId }),
      this.collection("suspicionReports").deleteMany({ sessionId }),
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
            candidateId: 1,
            employeeId: 1,
            assessmentId: 1,
            auditId: 1,
            matrixId: 1,
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
        }
      )
      .sort({ createdAt: -1 })
      .toArray();
  }

  /**
   * Updates live aggregate counts on the session document after micro-event
   * ingestion. Called by the Hono API after every batch so the left-drawer
   * session list always shows accurate eventCount even post-restart.
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
    }
  ): Promise<void> {
    await this.collection("sessions").updateOne(
      { sessionId },
      { $set: { ...counts, updatedAt: new Date() } }
    );
  }

  /**
   * Flips the session status in MongoDB (e.g. "active" → "locked" on high-risk
   * detection, "locked" → "active" on safe-behavior auto-clear).
   * Called by the Hono API through the HTTP adapter.
   */
  async setSessionStatus(sessionId: string, status: string): Promise<void> {
    await this.collection("sessions").updateOne(
      { sessionId },
      { $set: { status, updatedAt: new Date() } }
    );
  }

  // ─── Micro-Event Operations ────────────────────────────────────

  async ingestMicroEvents(events: Document[]): Promise<number> {
    const enriched = events.map((e) => ({
      ...e,
      _ingestedAt: new Date(),
    }));
    const result = await this.collection("microEvents").insertMany(enriched);
    return result.insertedCount;
  }

  async getSessionEvents(
    sessionId: string,
    options?: { limit?: number; eventType?: string }
  ): Promise<Document[]> {
    const query: Document = { sessionId };
    if (options?.eventType) {
      query["eventType"] = options.eventType;
    }
    return this.collection("microEvents")
      .find(query)
      .sort({ timestamp: -1 })
      .limit(options?.limit ?? 500)
      .toArray();
  }

  async countEventType(sessionId: string, eventType: string): Promise<number> {
    return this.collection("microEvents").countDocuments({ sessionId, eventType });
  }

  // ─── Suspicion Report Operations ───────────────────────────────

  async storeSuspicionReport(report: Document): Promise<string> {
    const result = await this.collection("suspicionReports").insertOne({
      ...report,
      _generatedAt: new Date(),
    });
    return result.insertedId.toString();
  }

  async getSuspicionReports(sessionId: string): Promise<Document[]> {
    return this.collection("suspicionReports")
      .find({ sessionId })
      .sort({ generatedAt: -1 })
      .toArray();
  }

  async getCandidateReport(candidateId: string): Promise<Document[]> {
    return this.collection("suspicionReports")
      .find({ candidateId })
      .sort({ generatedAt: -1 })
      .toArray();
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
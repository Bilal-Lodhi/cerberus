/**
 * A faithful in-process double for the MCP MongoDB persistence layer.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 *
 * This repository found four defects that its own suite could not see, and every
 * one of them for the same reason: a double that did not match the real store.
 * There were four independent reimplementations of the same store interface, each
 * with different semantics, and nothing asserted that any of them agreed with
 * `MongoStore`. Three of them returned `{success: true, updated: true}` from
 * `set_session_status` **without persisting anything**, which is how a terminated
 * session being resurrected to `locked` by a later ingest survived 481 passing
 * tests. See `docs/development/test-double-contract.md`.
 *
 * ── What makes this one different ─────────────────────────────────────
 *
 * Two things, and both are structural rather than a matter of care:
 *
 *   1. **The tool layer is not faked at all.** This double implements the
 *      `MongoStore` *method* surface, and the real `createToolRegistry()` wraps it.
 *      So tool-name mapping, argument validation, the `SESSION_STATUSES` check, the
 *      bounded-string and bounded-tag rules, the `ToolArgumentError` distinction and
 *      every response shape are the production implementations. The only thing
 *      simulated is storage.
 *   2. **The update documents are the production ones.** Counters go through the
 *      real `buildSessionCountsUpdate()`, so `$max` monotonicity, the `updatedAt`
 *      write and the "set `status` only when supplied" rule are the real rules
 *      rather than a spread-merge that happens to look similar.
 *
 * The error mapping mirrors `http-adapter.ts` exactly — 404 for an unknown tool,
 * 400 for `ToolArgumentError`, 500 for anything else, 200 with a `correlationId`
 * otherwise — so a route's behaviour on an adapter *rejection* is reachable, which
 * it was not while every stub answered 200 unconditionally.
 *
 * ── What it deliberately does NOT model ───────────────────────────────
 *
 * BSON, indexes, `ordered: false` partial-batch semantics, `limit(0)` meaning "no
 * limit", transactions, or replica-set behaviour. Those belong to the real-database
 * suite (`store-contract.test.ts` runs the same assertions against a real
 * `MongoStore` when `CERBERUS_TEST_MONGODB_URI` is set).
 *
 * Where the real store has a behaviour that is a *defect* — no store-side corpus
 * ceiling, no unique index on `riskAssessmentId` — this double reproduces the defect
 * rather than the intent. A double that is better than the store hides bugs.
 */

import { randomUUID } from "node:crypto";

import {
  buildSessionCountsUpdate,
  compact,
  type SessionCountsUpdate,
} from "../../../../packages/mcp-mongodb/src/mongo-client.js";
import {
  ToolArgumentError,
  createToolRegistry,
  type ToolHandler,
} from "../../../../packages/mcp-mongodb/src/tools.js";
import { MCP_TOOL_NAMES } from "../../../../packages/mcp-mongodb/src/tool-names.js";

/** A stored document. Plain objects, no BSON. */
export type StoredDocument = Record<string, unknown>;

/**
 * The fields `MongoStore.listSessions()` projects.
 *
 * Kept as a list rather than "return everything" so a route cannot depend on a
 * field the real query does not return. `terminalContent` is deliberately absent,
 * exactly as it is absent from the real projection.
 */
const LIST_SESSIONS_PROJECTION = [
  "sessionId",
  "employeeId",
  "auditId",
  "matrixId",
  "targetSystem",
  "status",
  "eventCount",
  "pasteCount",
  "tabSwitchCount",
  "fullscreenExitCount",
  "copyAttemptCount",
  "peakRiskScore",
  "overallRiskScore",
  "riskIndex",
  "deployedAt",
  "createdAt",
  "updatedAt",
] as const;

/** The fields `MongoStore.listReferenceDocuments()` projects. */
const LIST_REFERENCE_PROJECTION = [
  "referenceId",
  "label",
  "content",
  "tags",
  "createdAt",
  "updatedAt",
] as const;

/** Applies a projection, dropping everything not named. */
function project(
  document: StoredDocument,
  fields: readonly string[],
): StoredDocument {
  const output: StoredDocument = {};
  for (const field of fields) {
    if (document[field] !== undefined) output[field] = document[field];
  }
  return output;
}

/**
 * MongoDB's `$max`.
 *
 * Sets the field when the stored value is absent or not a number, and otherwise
 * keeps the larger of the two. A lower value is *refused*, which is the whole
 * point of the operator: a restarted process holding counters starting at zero
 * cannot lower a durable total.
 */
function applyMax(document: StoredDocument, field: string, value: unknown): void {
  if (typeof value !== "number") return;
  const current = document[field];
  if (typeof current !== "number" || value > current) {
    document[field] = value;
  }
}

/** Reads a comparable timestamp for sorting. Missing or unusable sorts last. */
function timeOf(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** How a simulated failure should present itself to `callMcpTool`. */
interface SimulatedFailure {
  /** When set, the responder throws — a transport failure, not an HTTP status. */
  transport?: Error;
  /** When set, the responder answers with this HTTP status. */
  status?: number;
}

/**
 * An in-memory stand-in for `MongoStore`.
 *
 * The public method surface mirrors `MongoStore` method for method; the contract
 * suite asserts that it still does, because the cast at the registry call site
 * would otherwise hide a missing method until a route happened to call it.
 */
export class McpStoreDouble {
  readonly sessions = new Map<string, StoredDocument>();
  readonly events = new Map<string, StoredDocument[]>();
  readonly assessments = new Map<string, StoredDocument[]>();
  readonly referenceDocuments = new Map<string, StoredDocument>();
  readonly threatScenarios = new Map<string, StoredDocument>();

  /** Every tool name invoked, in order. */
  readonly calls: string[] = [];

  private readonly failures = new Map<string, SimulatedFailure>();
  private readonly matchers: Array<{ fragment: string; failure: SimulatedFailure }> = [];
  private connected = true;

  // ─── Failure injection ──────────────────────────────────────────────

  /**
   * Makes every call to `tool` fail as a transport error.
   *
   * This is the "the sidecar is unreachable" case, which reaches `callMcpTool` as a
   * rejected fetch rather than an HTTP status.
   */
  failToolTransport(tool: string, message = "mongo unreachable"): void {
    this.failures.set(tool, { transport: new Error(message) });
  }

  /** Makes every call to `tool` answer with an HTTP status. */
  failToolWithStatus(tool: string, status: number): void {
    this.failures.set(tool, { status });
  }

  /**
   * Makes every tool whose name contains `fragment` fail as a transport error.
   *
   * For a whole *family* of tools, so a test can model "the corpus store is down"
   * without enumerating every corpus tool — and without accidentally leaving one of
   * them answering normally, which is the failure mode a per-tool list invites.
   */
  failToolsMatching(fragment: string, message = "mongo unreachable"): void {
    this.matchers.push({ fragment, failure: { transport: new Error(message) } });
  }

  clearFailures(): void {
    this.failures.clear();
    this.matchers.length = 0;
  }

  private failureFor(tool: string): SimulatedFailure | undefined {
    const exact = this.failures.get(tool);
    if (exact) return exact;
    return this.matchers.find((entry) => tool.includes(entry.fragment))?.failure;
  }

  /** Simulates the adapter being unable to reach MongoDB at all. */
  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  // ─── Seeding ────────────────────────────────────────────────────────

  /** Inserts a session document directly, as a previous process would have. */
  seedSession(document: StoredDocument): void {
    const sessionId = String(document["sessionId"]);
    this.sessions.set(sessionId, { ...document });
  }

  /** Appends a risk assessment, oldest first, as ingestion writes them. */
  seedAssessment(
    sessionId: string,
    options: {
      overallRiskScore: number;
      generatedAt: string;
      codeSnapshot?: string;
      employeeId?: string;
      auditId?: string;
    },
  ): StoredDocument {
    const assessment: StoredDocument = {
      riskAssessmentId: randomUUID(),
      sessionId,
      employeeId: options.employeeId ?? "op-trader-001",
      auditId: options.auditId ?? "audit-2026-q1",
      overallRiskScore: options.overallRiskScore,
      dimensionScores: { dataExfiltration: options.overallRiskScore },
      flags: [],
      exfiltrationReport: null,
      behavioralAnomalies: [],
      generatedAt: options.generatedAt,
      ...(options.codeSnapshot !== undefined
        ? { codeSnapshot: options.codeSnapshot }
        : {}),
    };
    const list = this.assessments.get(sessionId) ?? [];
    list.push(assessment);
    this.assessments.set(sessionId, list);
    return assessment;
  }

  /** Pre-stores an event identity, as a previous process would have. */
  seedEvent(sessionId: string, event: StoredDocument): void {
    const list = this.events.get(sessionId) ?? [];
    list.push({ ...event });
    this.events.set(sessionId, list);
  }

  // ─── MongoStore method surface ──────────────────────────────────────

  async storeThreatScenario(scenario: StoredDocument): Promise<string> {
    const matrixId = String(
      (scenario["metadata"] as StoredDocument | undefined)?.["matrixId"] ?? randomUUID(),
    );
    this.threatScenarios.set(matrixId, { ...scenario, _createdAt: new Date() });
    return matrixId;
  }

  async getThreatScenario(matrixId: string): Promise<StoredDocument | null> {
    return this.threatScenarios.get(matrixId) ?? null;
  }

  /**
   * `$setOnInsert` semantics: an existing document is left completely untouched,
   * including its `updatedAt`. A second deploy for the same id therefore cannot
   * overwrite a status, which is what makes a deploy against a `terminated`
   * session a silent no-op.
   */
  async createSession(session: StoredDocument): Promise<string> {
    const sessionId = String(session["sessionId"]);
    if (!this.sessions.has(sessionId)) {
      const now = new Date();
      this.sessions.set(sessionId, {
        // Order matters, and mirrors `MongoStore.createSession`: the caller's own
        // fields are spread *after* the default status, so a supplied status wins,
        // and the timestamps are written after both.
        status: "active",
        ...compact(session),
        createdAt: now,
        updatedAt: now,
      });
    }
    return sessionId;
  }

  async getSession(sessionId: string): Promise<StoredDocument | null> {
    const document = this.sessions.get(sessionId);
    return document ? { ...document } : null;
  }

  /** `$set` with no upsert. Matching nothing is silent, and is not an error. */
  async updateSession(sessionId: string, update: StoredDocument): Promise<void> {
    const document = this.sessions.get(sessionId);
    if (!document) return;
    Object.assign(document, compact(update), { updatedAt: new Date() });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const existed = this.sessions.delete(sessionId);
    this.events.delete(sessionId);
    this.assessments.delete(sessionId);
    return existed;
  }

  /** Newest first by `createdAt`, with the real projection applied. */
  async listSessions(): Promise<StoredDocument[]> {
    return [...this.sessions.values()]
      .map((document) => project(document, LIST_SESSIONS_PROJECTION))
      .sort((a, b) => timeOf(b["createdAt"]) - timeOf(a["createdAt"]));
  }

  /**
   * Applies the production update document.
   *
   * `buildSessionCountsUpdate` is the real builder, so counters are `$max`
   * (refusing a regression) and `status` is written only when supplied.
   */
  async updateSessionCounts(
    sessionId: string,
    counts: SessionCountsUpdate,
  ): Promise<void> {
    const document = this.sessions.get(sessionId);
    if (!document) return;

    const update = buildSessionCountsUpdate(counts) as {
      $set?: StoredDocument;
      $max?: StoredDocument;
    };

    if (update.$max) {
      for (const [field, value] of Object.entries(update.$max)) {
        applyMax(document, field, value);
      }
    }
    if (update.$set) {
      Object.assign(document, update.$set);
    }
  }

  /**
   * `$set` of the status, reporting whether a document matched.
   *
   * The return value is load-bearing: the route distinguishes "status changed" from
   * "no such session" with it, and three of the four doubles this replaces returned
   * `true` unconditionally — which made that distinction untestable.
   */
  async setSessionStatus(sessionId: string, status: string): Promise<boolean> {
    const document = this.sessions.get(sessionId);
    if (!document) return false;
    document["status"] = status;
    document["updatedAt"] = new Date();
    return true;
  }

  /**
   * Upserts each event on `(sessionId, eventId)`, reporting which were new.
   *
   * A duplicate inside the *same* batch is reported as a duplicate, because the
   * unique index is applied as each operation runs — which is what makes the
   * accepted/duplicate report trustworthy for a batch containing a repeat.
   */
  async ingestMicroEvents(
    events: StoredDocument[],
  ): Promise<{ acceptedEventIds: string[]; duplicateEventIds: string[] }> {
    const acceptedEventIds: string[] = [];
    const duplicateEventIds: string[] = [];
    const ingestedAt = new Date();

    for (const event of events) {
      const sessionId = String(event["sessionId"]);
      const eventId = typeof event["eventId"] === "string" ? event["eventId"] : "";
      const list = this.events.get(sessionId) ?? [];

      const alreadyStored = list.some(
        (stored) => String(stored["eventId"] ?? "") === eventId,
      );
      if (alreadyStored) {
        duplicateEventIds.push(eventId);
        continue;
      }

      list.push({ ...event, eventId, _ingestedAt: ingestedAt });
      this.events.set(sessionId, list);
      acceptedEventIds.push(eventId);
    }

    return { acceptedEventIds, duplicateEventIds };
  }

  /**
   * Newest first by `timestamp`, capped at `limit ?? 500`.
   *
   * The cap is the real one and it is a cap on a *read*, not on storage: the
   * collection can hold far more than 500 events for a session, and the oldest are
   * simply not returned. A double without this cap made a benchmark attribute the
   * re-serialisation of a growing array to the application.
   */
  async getSessionEvents(
    sessionId: string,
    options?: { limit?: number; eventType?: string },
  ): Promise<StoredDocument[]> {
    let list = this.events.get(sessionId) ?? [];
    if (options?.eventType) {
      list = list.filter((event) => event["eventType"] === options.eventType);
    }
    return [...list]
      .sort((a, b) => timeOf(b["timestamp"]) - timeOf(a["timestamp"]))
      .slice(0, options?.limit ?? 500)
      .map((event) => ({ ...event }));
  }

  async countEventType(sessionId: string, eventType: string): Promise<number> {
    return (this.events.get(sessionId) ?? []).filter(
      (event) => event["eventType"] === eventType,
    ).length;
  }

  /**
   * A plain insert, with no unique index on `riskAssessmentId`.
   *
   * This reproduces the real store rather than the intended behaviour: there is no
   * idempotency here, so a re-analysis after a restart writes a second row for one
   * incident. Recorded as open work in `docs/development/failure-semantics.md` §3.9.
   */
  async storeRiskAssessment(report: StoredDocument): Promise<string> {
    const sessionId = String(report["sessionId"] ?? "");
    const list = this.assessments.get(sessionId) ?? [];
    list.push({ ...report, _generatedAt: new Date() });
    this.assessments.set(sessionId, list);
    return randomUUID();
  }

  /** Newest first by `generatedAt`, which is `{ generatedAt: -1 }`. */
  async getRiskAssessments(sessionId: string): Promise<StoredDocument[]> {
    return [...(this.assessments.get(sessionId) ?? [])]
      .sort((a, b) => timeOf(b["generatedAt"]) - timeOf(a["generatedAt"]))
      .map((assessment) => ({ ...assessment }));
  }

  async getEmployeeRiskHistory(employeeId: string): Promise<StoredDocument[]> {
    const all: StoredDocument[] = [];
    for (const list of this.assessments.values()) {
      for (const assessment of list) {
        if (assessment["employeeId"] === employeeId) all.push({ ...assessment });
      }
    }
    return all.sort((a, b) => timeOf(b["generatedAt"]) - timeOf(a["generatedAt"]));
  }

  /** Upserts on `referenceId`, preserving `createdAt` across an update. */
  async storeReferenceDocument(document: StoredDocument): Promise<string> {
    const referenceId = String(document["referenceId"]);
    const existing = this.referenceDocuments.get(referenceId);
    this.referenceDocuments.set(referenceId, {
      ...compact(document),
      updatedAt: new Date(),
      createdAt: existing?.["createdAt"] ?? new Date(),
    });
    return referenceId;
  }

  /** Newest first by `updatedAt`, capped at `limit`. */
  async listReferenceDocuments(limit: number): Promise<StoredDocument[]> {
    return [...this.referenceDocuments.values()]
      .sort((a, b) => timeOf(b["updatedAt"]) - timeOf(a["updatedAt"]))
      .slice(0, limit)
      .map((document) => project(document, LIST_REFERENCE_PROJECTION));
  }

  async deleteReferenceDocument(referenceId: string): Promise<boolean> {
    return this.referenceDocuments.delete(referenceId);
  }

  async ping(): Promise<boolean> {
    return this.connected;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Tool-level responder ───────────────────────────────────────────

  /**
   * The responder to hand to `installFetchStub({ mcpResponse })`.
   *
   * Returns a real `Response`, so the adapter's status codes are reachable from a
   * route test instead of every call answering 200. It is async because the tool
   * handlers are; `installFetchStub` awaits it.
   */
  responder(): (tool: string, body: StoredDocument) => Promise<Response> {
    const registry = createToolRegistry(
      this as unknown as Parameters<typeof createToolRegistry>[0],
    );

    return async (tool: string, body: StoredDocument): Promise<Response> => {
      this.calls.push(tool);

      const failure = this.failureFor(tool);
      if (failure?.transport) throw failure.transport;
      if (failure?.status !== undefined) {
        return Response.json(
          { success: false, error: `HTTP ${failure.status}` },
          { status: failure.status },
        );
      }

      const handler = registry[tool as keyof typeof registry] as
        | ToolHandler
        | undefined;

      // The real adapter answers 404 for an unknown tool rather than falling
      // through to a plausible success, which is what made an unmodelled call
      // invisible in the doubles this replaces.
      if (!handler) {
        return Response.json(
          {
            success: false,
            error: `Unknown tool: ${tool}`,
            availableTools: Object.keys(registry),
          },
          { status: 404 },
        );
      }

      try {
        const result = await handler(body);
        return Response.json({
          ...(result as StoredDocument),
          correlationId: randomUUID(),
        });
      } catch (error) {
        const isArgumentError = error instanceof ToolArgumentError;
        return Response.json(
          {
            success: false,
            error: error instanceof Error ? error.message : "Internal MCP tool error",
          },
          { status: isArgumentError ? 400 : 500 },
        );
      }
    };
  }
}

/** The tool names this double is expected to answer. */
export const DOUBLE_KNOWN_TOOLS: readonly string[] = Object.values(MCP_TOOL_NAMES);

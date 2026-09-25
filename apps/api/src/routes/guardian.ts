/**
 * Route group: /api/v1/guardian
 *
 * Real-time insider-threat and data-exfiltration monitoring.
 *
 *   POST   /ingest                              batch telemetry ingestion
 *   POST   /deploy                              create a monitored session
 *   GET    /sessions                            list live sessions (expired excluded)
 *   GET    /sessions/:sessionId                 session detail, with derived liveness
 *   POST   /sessions/:sessionId/reactivate      explicitly resume an expired session
 *   POST   /sessions/:sessionId/terminate       stop monitoring, preserve data
 *   DELETE /sessions/:sessionId                 delete session and all derived data
 *
 * Persistence flows through the MCP MongoDB sidecar. Every MCP call is
 * timeout-isolated so a slow database degrades the response rather than
 * stalling the ingestion loop.
 *
 * Session liveness is derived from `SESSION_TTL_SECONDS` by
 * `../services/session-liveness.ts`. The TTL bounds how long a session is
 * monitored; it never deletes or hides review evidence. See that module for the
 * full contract.
 *
 * Deduplication layers (all preserved from the original implementation):
 *   1. identical risk-assessment id from the AI provider
 *   2. code-hash equality — skip re-analysis when the workspace is unchanged
 *   3. micro-event fingerprint ring (last 128) — suppress replayed batches
 *   4. behavioural counter blend — repeated violations amplify the score
 */

import { Hono } from "hono";
import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type {
  ActiveSession,
  DeploySessionRequest,
  DeploySessionResponse,
  IngestMicroEventRequest,
  IngestMicroEventResponse,
  MicroEvent,
  RiskAssessmentPayload,
} from "../types.js";
import { getAIProvider } from "../ai/provider.js";
import { callMcpTool, MCP_TOOL_NAMES } from "../services/mcp-client.js";
import { notifySlack, sendEmail } from "../services/notifications.js";
import {
  isExpired,
  resolveLiveness,
  systemClock,
  type Clock,
  type SessionActivity,
  type SessionLiveness,
} from "../services/session-liveness.js";
import { toISOStringLocal, formatLocalTime } from "../utils/time.js";

const MCP_TIMEOUT_MS = 5_000;

/** Re-exported so the review router can type its shared registries. */
export type { ActiveSession };

/** High-risk threshold that triggers the agentic auto-lock. */
export const AUTO_LOCK_THRESHOLD = 75;
/** Risk score at or below which a locked session is auto-cleared. */
export const AUTO_CLEAR_THRESHOLD = 25;

/** Stable error code returned when telemetry targets an expired session. */
export const SESSION_EXPIRED_CODE = "SESSION_EXPIRED";
/** Stable error code returned when a terminal-state session is reactivated. */
export const SESSION_TERMINATED_CODE = "SESSION_TERMINATED";

/**
 * Maximum number of micro-events accepted in a single ingest batch.
 *
 * The console sends one event per request, so this is far above real usage. The
 * global request body limit bounds a batch by size, but a body of many tiny
 * events would otherwise still expand into an unbounded number of persistence
 * writes and in-memory event objects.
 */
export const MAX_EVENTS_PER_BATCH = 1_000;

// ─── Session state ─────────────────────────────────────────────────

export interface SessionState {
  sessionId: string;
  employeeId: string;
  auditId: string;
  events: MicroEvent[];
  currentCode: string;
  pasteCount: number;
  keystrokeDeltas: number[];
  tabSwitchCount: number;
  fullscreenExitCount: number;
  copyAttemptCount: number;
  lastRiskPayload: RiskAssessmentPayload | null;
  eventCount: number;
  status: string;
  /** SHA-256 of currentCode at the time of the last AI analysis. */
  lastAnalyzedCodeHash: string;
  /** Fingerprints of recent micro-events, used to suppress replays. */
  recentEventFingerprints: Set<string>;
  /** ISO timestamp set only on terminate (not on delete). */
  endedAt?: string;
  /**
   * Server-observed time of the last accepted telemetry batch or lifecycle
   * transition. Feeds the TTL expiry predicate; never client-supplied.
   */
  lastActivityAt?: string;
}

export interface GuardianRouterBundle {
  router: Hono;
  sessionStore: Map<string, SessionState>;
  activeSessions: Map<string, ActiveSession>;
}

export interface GuardianRouterOptions {
  /** Time source for TTL expiry. Defaults to the system clock. */
  clock?: Clock;
}

export function createGuardianRouter(
  config: AppConfig,
  options: GuardianRouterOptions = {},
): GuardianRouterBundle {
  const guardianRouter = new Hono();

  /** Time source for every liveness decision in this router. */
  const clock: Clock = options.clock ?? systemClock;
  /** Configured monitoring window, in seconds. */
  const ttlSeconds = config.security.sessionTTLSeconds;

  /** In-memory live session state, authoritative for sessions that ingested events. */
  const sessionStore = new Map<string, SessionState>();
  /** Deployment registry, so freshly deployed sessions appear before any events. */
  const activeSessions = new Map<string, ActiveSession>();

  const notifySlackWebhook = process.env["SLACK_WEBHOOK_URL"] ?? "";
  const sendgridKey = process.env["SENDGRID_API_KEY"] ?? "";
  const emailFrom = process.env["EMAIL_FROM"] ?? "";
  const emailTo = process.env["EMAIL_TO"] ?? "";

  // ═══════════════════════════════════════════════════════════════
  // POST /ingest
  // ═══════════════════════════════════════════════════════════════

  guardianRouter.post("/ingest", async (c) => {
    const requestId = randomUUID();
    console.log(`[guardian] [${requestId}] POST /ingest`);

    let body: IngestMicroEventRequest;
    try {
      body = await c.req.json<IngestMicroEventRequest>();
    } catch {
      return c.json(
        { success: false, error: "Invalid JSON body", correlationId: requestId },
        400,
      );
    }

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json(
        { success: false, error: "Request body must be a valid JSON object" },
        400,
      );
    }

    if (!Array.isArray(body.events) || body.events.length === 0) {
      return c.json(
        { success: false, error: "Field 'events' must be a non-empty array" },
        400,
      );
    }

    if (body.events.length > MAX_EVENTS_PER_BATCH) {
      return c.json(
        {
          success: false,
          error: `Field 'events' must contain at most ${MAX_EVENTS_PER_BATCH} entries (got ${body.events.length}).`,
          code: "BATCH_TOO_LARGE",
          maxEvents: MAX_EVENTS_PER_BATCH,
          correlationId: requestId,
        },
        400,
      );
    }

    const primaryEvent = body.events[0];
    const sessionId = primaryEvent?.sessionId;
    if (!sessionId) {
      return c.json(
        { success: false, error: "Each event must contain a sessionId" },
        400,
      );
    }

    const processedCount = body.events.length;
    let riskPayload: RiskAssessmentPayload | null = null;
    let alertTriggered = false;

    try {
      // 1. Resolve the durable session document, creating it when absent.
      const durableSession = await ensureMongoSession(sessionId, primaryEvent, requestId);

      // 2. Refuse telemetry for a session whose monitoring window has closed.
      //    Extending a monitoring window is an explicit operator act
      //    (`POST /sessions/:sessionId/reactivate`), never a side effect of
      //    continuing to emit events — otherwise the TTL would bound nothing.
      if (sessionLiveness(sessionId, durableSession) === "expired") {
        console.warn(
          `[guardian] [${requestId}] rejected ingest for expired session '${sessionId}'`,
        );
        return c.json(
          {
            success: false,
            error:
              `Session '${sessionId}' is expired: its most recent activity is older ` +
              `than SESSION_TTL_SECONDS (${ttlSeconds}s). Reactivate it with ` +
              `POST /api/v1/guardian/sessions/${sessionId}/reactivate, or deploy a new session.`,
            code: SESSION_EXPIRED_CODE,
            sessionId,
            liveness: "expired" satisfies SessionLiveness,
            correlationId: requestId,
          },
          409,
        );
      }

      // 3. Persist the raw telemetry.
      await callMcpTool(
        config,
        MCP_TOOL_NAMES.INGEST_MICRO_EVENTS,
        { events: body.events },
        { requestId, timeoutMs: MCP_TIMEOUT_MS },
      );

      // 4. Apply events to in-memory state.
      for (const event of body.events) {
        processEvent(event);
      }

      const session = sessionStore.get(sessionId);
      if (!session) {
        return c.json(
          { success: false, error: `Session ${sessionId} not found after processing` },
          404,
        );
      }

      // 5. Update durable aggregate counters.
      await callMcpTool(
        config,
        MCP_TOOL_NAMES.UPDATE_SESSION_COUNTS,
        {
          sessionId,
          counts: {
            eventCount: session.events.length,
            pasteCount: session.pasteCount,
            tabSwitchCount: session.tabSwitchCount,
            copyAttemptCount: session.copyAttemptCount,
            peakRiskScore: session.lastRiskPayload?.overallRiskScore ?? 0,
          },
        },
        { requestId, timeoutMs: MCP_TIMEOUT_MS },
      );

      // 6. Decide whether this batch warrants AI analysis.
      const hasLargePaste = body.events.some(
        (event) => event.eventType === "PASTE" && (event.payload.changeLength ?? 0) >= 100,
      );
      const shouldAnalyze =
        hasLargePaste ||
        session.pasteCount > config.security.maxPasteEventsPerSession ||
        session.tabSwitchCount > 3 ||
        session.fullscreenExitCount > 0 ||
        session.copyAttemptCount > 2 ||
        hasAnomalousKeystrokes(session.keystrokeDeltas, config);

      if (shouldAnalyze && session.currentCode.length > 50) {
        // ── Dedup layer 2: skip inference when the workspace is unchanged ──
        const codeHash = createHash("sha256")
          .update(session.currentCode, "utf-8")
          .digest("hex");

        if (codeHash === session.lastAnalyzedCodeHash) {
          const cached = session.lastRiskPayload;
          console.log(
            `[guardian] [${requestId}] code unchanged (hash=${codeHash.slice(0, 12)}) — reusing payload`,
          );
          return c.json(
            {
              success: true,
              processedCount,
              riskPayload: cached,
              alertTriggered: (cached?.overallRiskScore ?? 0) > 50,
              anomalyRiskIndex: cached?.overallRiskScore ?? 0,
            } satisfies IngestMicroEventResponse,
            200,
          );
        }
        session.lastAnalyzedCodeHash = codeHash;

        const keystrokeMetrics = computeKeystrokeMetrics(session.keystrokeDeltas);
        const pasteContents = collectPasteContents(session.events);

        try {
          const analysisStartMs = Date.now();
          riskPayload = await getAIProvider(config).analyzeRisk(
            session.currentCode,
            pasteContents,
            keystrokeMetrics,
            await getReferenceCompletions(),
          );
          console.log(
            `[guardian] [${requestId}] risk analysis complete in ` +
              `${Date.now() - analysisStartMs}ms — score=${riskPayload.overallRiskScore} ` +
              `flags=${riskPayload.flags.length}`,
          );

          // ── Dedup layer 4: blend the semantic score with behavioural counters ──
          const semanticScore = riskPayload.overallRiskScore;
          const pastePenalty = Math.min(session.pasteCount * 5, 30);
          const tabPenalty = Math.min(session.tabSwitchCount * 4, 16);
          const copyPenalty = Math.min(session.copyAttemptCount * 6, 18);
          const fullscreenPenalty = session.fullscreenExitCount > 0 ? 10 : 0;
          const keystrokePenalty = hasAnomalousKeystrokes(
            session.keystrokeDeltas,
            config,
          )
            ? 12
            : 0;

          const behaviouralBoost =
            pastePenalty + tabPenalty + copyPenalty + fullscreenPenalty + keystrokePenalty;

          const blendedScore = clampScore(
            semanticScore * 0.85 + behaviouralBoost * 0.15,
          );
          riskPayload.overallRiskScore = blendedScore;

          const boostFactor = semanticScore > 0 ? blendedScore / semanticScore : 1.0;
          riskPayload.dimensionScores.dataExfiltration = clampScore(
            riskPayload.dimensionScores.dataExfiltration * boostFactor + pastePenalty * 0.8,
          );
          riskPayload.dimensionScores.policyViolation = clampScore(
            riskPayload.dimensionScores.policyViolation * boostFactor +
              tabPenalty * 0.6 +
              copyPenalty * 0.5,
          );

          // ── Incident context enrichment ──
          riskPayload.sessionId = sessionId;
          riskPayload.employeeId = session.employeeId;
          riskPayload.auditId = session.auditId;
          riskPayload.generatedAt = toISOStringLocal();

          riskPayload.pasteSnippets = pasteContents;
          riskPayload.pasteLineCount = pasteContents.reduce(
            (sum, snippet) => sum + (snippet.match(/\n/g) ?? []).length + 1,
            0,
          );
          riskPayload.pasteCharCount = pasteContents.reduce(
            (sum, snippet) => sum + snippet.length,
            0,
          );
          riskPayload.codeSnapshot = session.currentCode;

          riskPayload.behavioralContext = {
            totalPasteEvents: session.pasteCount,
            totalFocusBreaches: session.tabSwitchCount + session.fullscreenExitCount,
            totalCopyAttempts: session.copyAttemptCount,
            totalDevToolsOpens: session.events.filter(
              (event) => event.eventType === "DEVELOPER_TOOLS_OPEN",
            ).length,
            totalFullscreenExits: session.fullscreenExitCount,
          };

          riskPayload.keystrokeMetrics = {
            averageInterKeyMs: keystrokeMetrics.avgDeltaMs,
            minInterKeyMs: keystrokeMetrics.minDeltaMs,
            burstKeystrokes: session.keystrokeDeltas.filter(
              (delta) => delta < config.security.minHumanKeystrokeMs,
            ).length,
          };

          riskPayload.incidentSummary = buildIncidentSummary(session, riskPayload, config);
          riskPayload.employeeDisplayName = `Operator ${session.employeeId}`;
          riskPayload.incidentTimeLabel = formatLocalTime(new Date());

          session.lastRiskPayload = riskPayload;
          sessionStore.set(sessionId, session);

          alertTriggered = riskPayload.overallRiskScore > 50;

          // ── Agentic auto-lock / auto-clear ──
          if (riskPayload.overallRiskScore >= AUTO_LOCK_THRESHOLD) {
            riskPayload.recommendedActions =
              await getAIProvider(config).recommendIncidentActions(riskPayload);
            session.lastRiskPayload = riskPayload;
            sessionStore.set(sessionId, session);

            await Promise.all([
              notifySlack(notifySlackWebhook, riskPayload),
              sendEmail(sendgridKey, emailFrom, emailTo, riskPayload),
            ]);

            await lockSession(sessionId, riskPayload, requestId);
          } else if (riskPayload.overallRiskScore < AUTO_CLEAR_THRESHOLD) {
            if (activeSessions.get(sessionId)?.status === "locked") {
              await unlockSession(sessionId, requestId);
            }
          }

          await callMcpTool(
            config,
            MCP_TOOL_NAMES.STORE_RISK_ASSESSMENT,
            { report: riskPayload },
            { requestId, timeoutMs: MCP_TIMEOUT_MS },
          );
        } catch (analysisError) {
          // Analysis failure is non-fatal: telemetry is already persisted.
          console.error(
            `[guardian] [${requestId}] AI analysis failed (non-fatal): ` +
              `${analysisError instanceof Error ? analysisError.message : String(analysisError)}`,
          );
        }
      }

      const response: IngestMicroEventResponse = {
        success: true,
        processedCount,
        riskPayload,
        alertTriggered,
        anomalyRiskIndex: riskPayload?.overallRiskScore ?? 0,
      };
      return c.json(response, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown guardian error";
      console.error(`[guardian] [${requestId}] FAILURE — ${message}`);
      return c.json(
        { success: false, error: "Telemetry ingestion failed.", correlationId: requestId },
        500,
      );
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /sessions/:sessionId
  // ═══════════════════════════════════════════════════════════════

  guardianRouter.get("/sessions/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId");
    const session = sessionStore.get(sessionId);
    const activeSession = activeSessions.get(sessionId);

    // Derived, never persisted. `status` stays the historical durable value —
    // an auto-locked session reads as `locked` with `liveness: "expired"`,
    // which says "this lock happened" without claiming it is still live.
    const liveness = sessionLiveness(sessionId);

    if (session) {
      return c.json({
        success: true,
        session: {
          sessionId: session.sessionId,
          employeeId: session.employeeId,
          auditId: session.auditId,
          matrixId: activeSession?.matrixId ?? session.auditId,
          eventCount: session.events.length,
          pasteCount: session.pasteCount,
          tabSwitchCount: session.tabSwitchCount,
          fullscreenExitCount: session.fullscreenExitCount,
          copyAttemptCount: session.copyAttemptCount,
          currentCodeLength: session.currentCode.length,
          currentCode: session.currentCode,
          lastRiskPayload: session.lastRiskPayload,
          riskIndex: session.lastRiskPayload?.overallRiskScore ?? 0,
          overallRiskScore: session.lastRiskPayload?.overallRiskScore ?? 0,
          peakRiskScore: session.lastRiskPayload?.overallRiskScore ?? 0,
          startedAt: activeSession?.deployedAt ?? "",
          deployedAt: activeSession?.deployedAt ?? "",
          status: activeSession?.status ?? session.status ?? "active",
          liveness,
          lastActivityAt: session.lastActivityAt ?? activeSession?.deployedAt ?? "",
          targetSystem: activeSession?.targetSystem ?? "",
        },
      });
    }

    if (activeSession) {
      return c.json({
        success: true,
        session: {
          sessionId: activeSession.sessionId,
          employeeId: activeSession.employeeId,
          auditId: activeSession.matrixId,
          matrixId: activeSession.matrixId,
          eventCount: 0,
          pasteCount: 0,
          tabSwitchCount: 0,
          fullscreenExitCount: 0,
          copyAttemptCount: 0,
          currentCodeLength: 0,
          currentCode: "",
          lastRiskPayload: null,
          riskIndex: activeSession.riskIndex,
          overallRiskScore: activeSession.riskIndex,
          peakRiskScore: activeSession.riskIndex,
          startedAt: activeSession.deployedAt,
          deployedAt: activeSession.deployedAt,
          status: activeSession.status,
          liveness,
          lastActivityAt: activeSession.deployedAt,
          targetSystem: activeSession.targetSystem,
        },
      });
    }

    return c.json({ success: false, error: "Session not found" }, 404);
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /deploy
  // ═══════════════════════════════════════════════════════════════

  guardianRouter.post("/deploy", async (c) => {
    const requestId = randomUUID();
    console.log(`[guardian] [${requestId}] POST /deploy`);

    let body: DeploySessionRequest;
    try {
      body = await c.req.json<DeploySessionRequest>();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body", correlationId: requestId }, 400);
    }

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json(
        { success: false, error: "Request body must be a valid JSON object" },
        400,
      );
    }

    const { employeeUid, sessionId, matrixId, targetSystem } = body;
    const employeeId = employeeUid;

    const missing: string[] = [];
    if (!employeeUid?.trim()) missing.push("employeeUid");
    if (!sessionId?.trim()) missing.push("sessionId");
    if (!matrixId?.trim()) missing.push("matrixId");
    if (!targetSystem?.trim()) missing.push("targetSystem");

    if (missing.length > 0) {
      return c.json(
        {
          success: false,
          error: `Missing required fields: ${missing.join(", ")}`,
          correlationId: requestId,
        },
        400,
      );
    }

    try {
      const created = await callMcpTool<{ success?: boolean; mongoDocumentId?: string }>(
        config,
        MCP_TOOL_NAMES.CREATE_SESSION,
        {
          sessionId,
          employeeId,
          auditId: matrixId,
          matrixId,
          targetSystem,
          status: "active",
        },
        { requestId, timeoutMs: MCP_TIMEOUT_MS },
      );

      const mongoDocumentId =
        created.ok && created.data?.success && created.data.mongoDocumentId
          ? created.data.mongoDocumentId
          : "local-only";

      const deployedAt = toISOStringLocal();
      activeSessions.set(sessionId, {
        sessionId,
        employeeId,
        matrixId,
        targetSystem,
        status: "active",
        deployedAt,
        riskIndex: 0,
        lastActivityAt: deployedAt,
      });

      console.log(
        `[guardian] [${requestId}] deployed session=${sessionId} mongoDoc=${mongoDocumentId} ` +
          `registrySize=${activeSessions.size}`,
      );

      const response: DeploySessionResponse = {
        success: true,
        sessionId,
        employeeId,
        deployedAt,
        mongoDocumentId,
        mcpCorrelationId: requestId,
      };
      return c.json(response, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown deploy error";
      console.error(`[guardian] [${requestId}] deploy failed — ${message}`);
      return c.json(
        { success: false, error: "Failed to deploy session.", correlationId: requestId },
        500,
      );
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /sessions
  // ═══════════════════════════════════════════════════════════════

  guardianRouter.get("/sessions", async (c) => {
    const requestId = randomUUID();
    const seenIds = new Set<string>();
    const allSessions: Array<Record<string, unknown>> = [];

    // This endpoint is the LIVE list. A session whose monitoring window has
    // closed is not live, whatever its durable status, so it is excluded here.
    // It stays fully visible through GET /api/v1/sessions and
    // GET /api/v1/sessions/:sessionId, which are the review surfaces.

    // Path A1 — live in-memory state (authoritative event counts).
    if (sessionStore.size > 0) {
      const entries = Array.from(sessionStore.entries()).sort((a, b) => {
        const aTime = a[1].events[0]?.timestamp ?? "";
        const bTime = b[1].events[0]?.timestamp ?? "";
        return new Date(bTime).getTime() - new Date(aTime).getTime();
      });

      for (const [sessionId, state] of entries) {
        if (sessionExpired(sessionId)) continue;
        seenIds.add(sessionId);
        const active = activeSessions.get(sessionId);
        const deployedAt =
          active?.deployedAt ?? state.events[0]?.timestamp ?? toISOStringLocal();
        allSessions.push({
          sessionId,
          employeeId: state.employeeId || active?.employeeId || "unknown",
          auditId: state.auditId || active?.matrixId || "",
          matrixId: state.auditId || active?.matrixId || "",
          targetSystem: active?.targetSystem ?? "",
          status: active?.status ?? state.status ?? "active",
          liveness: "active" satisfies SessionLiveness,
          deployedAt,
          startedAt: deployedAt,
          createdAt: deployedAt,
          riskIndex: state.lastRiskPayload?.overallRiskScore ?? 0,
          peakRiskScore: state.lastRiskPayload?.overallRiskScore ?? 0,
          eventCount: state.events.length,
          pasteCount: state.pasteCount,
          tabSwitchCount: state.tabSwitchCount,
          copyAttemptCount: state.copyAttemptCount,
          alertTriggered:
            (state.lastRiskPayload?.overallRiskScore ?? 0) >= AUTO_LOCK_THRESHOLD,
        });
      }
    }

    // Path A2 — deployed sessions with no events yet.
    for (const [sessionId, active] of activeSessions) {
      if (seenIds.has(sessionId)) continue;
      if (sessionExpired(sessionId)) continue;
      seenIds.add(sessionId);
      allSessions.push({
        sessionId,
        employeeId: active.employeeId || "unknown",
        auditId: active.matrixId,
        matrixId: active.matrixId,
        targetSystem: active.targetSystem,
        status: active.status,
        liveness: "active" satisfies SessionLiveness,
        deployedAt: active.deployedAt,
        startedAt: active.deployedAt,
        createdAt: active.deployedAt,
        riskIndex: active.riskIndex,
        peakRiskScore: active.riskIndex,
        eventCount: 0,
        pasteCount: 0,
        tabSwitchCount: 0,
        copyAttemptCount: 0,
        alertTriggered: false,
      });
    }

    // Path B — durable recovery from MongoDB when memory is empty.
    if (allSessions.length === 0) {
      const listed = await callMcpTool<{
        success: boolean;
        data?: Array<Record<string, unknown>>;
      }>(config, MCP_TOOL_NAMES.LIST_SESSIONS, {}, { requestId, timeoutMs: MCP_TIMEOUT_MS });

      const docs = listed.ok && Array.isArray(listed.data?.data) ? listed.data!.data! : [];

      for (const doc of docs) {
        const sessionId = String(doc["sessionId"] ?? "");
        if (!sessionId || seenIds.has(sessionId)) continue;

        // Restart recovery must honour expiry: a session that timed out while
        // the process was down is not resurrected as actively monitored.
        if (sessionExpired(sessionId, doc)) continue;

        seenIds.add(sessionId);

        const employeeId = String(doc["employeeId"] ?? "unknown");
        const matrixId = String(doc["matrixId"] ?? doc["auditId"] ?? "");
        const deployedAt = String(doc["deployedAt"] ?? doc["createdAt"] ?? toISOStringLocal());
        const riskScore = Number(
          doc["peakRiskScore"] ?? doc["overallRiskScore"] ?? doc["riskIndex"] ?? 0,
        );
        const status = normalizeStatus(String(doc["status"] ?? "active"));

        // A terminated session is listed for review but must never re-enter the
        // live registry, or a restart would resurrect it as actively monitored.
        if (!activeSessions.has(sessionId) && isMonitored(status)) {
          activeSessions.set(sessionId, {
            sessionId,
            employeeId,
            matrixId,
            targetSystem: String(doc["targetSystem"] ?? ""),
            status: status as ActiveSession["status"],
            deployedAt,
            riskIndex: riskScore,
            // The durable `updatedAt` is the only activity signal that survives
            // a restart, so recovery must carry it into the live registry.
            lastActivityAt: String(doc["updatedAt"] ?? deployedAt),
          });
        }

        allSessions.push({
          sessionId,
          employeeId,
          auditId: matrixId,
          matrixId,
          targetSystem: String(doc["targetSystem"] ?? ""),
          status,
          liveness: "active" satisfies SessionLiveness,
          deployedAt,
          startedAt: deployedAt,
          createdAt: deployedAt,
          riskIndex: riskScore,
          peakRiskScore: riskScore,
          eventCount: Number(doc["eventCount"] ?? 0),
          pasteCount: Number(doc["pasteCount"] ?? 0),
          tabSwitchCount: Number(doc["tabSwitchCount"] ?? 0),
          copyAttemptCount: Number(doc["copyAttemptCount"] ?? 0),
          alertTriggered: riskScore >= AUTO_LOCK_THRESHOLD,
        });
      }
    }

    allSessions.sort((a, b) => {
      const aTime = String(a["deployedAt"] ?? a["createdAt"] ?? "");
      const bTime = String(b["deployedAt"] ?? b["createdAt"] ?? "");
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    });

    return c.json({ success: true, data: allSessions });
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /sessions/:sessionId/reactivate  — explicit resume after expiry
  // ═══════════════════════════════════════════════════════════════

  /**
   * Reopens a session's monitoring window.
   *
   * The TTL bounds how long a session is monitored, so resuming one is an
   * explicit operator decision rather than a side effect of the next telemetry
   * batch arriving. Ingest refuses an expired session with `409 SESSION_EXPIRED`
   * and points here.
   *
   * Idempotent for a live session. A `terminated` session is refused: the
   * terminal state is not reversible, exactly as in the restart-recovery path.
   */
  guardianRouter.post("/sessions/:sessionId/reactivate", async (c) => {
    const sessionId = c.req.param("sessionId");
    const requestId = randomUUID();

    const state = sessionStore.get(sessionId);
    const active = activeSessions.get(sessionId);

    // Fall back to the durable record so a session that expired while the
    // process was down can still be reopened.
    let durable: Record<string, unknown> | null = null;
    if (!state && !active) {
      const review = await callMcpTool<{
        success: boolean;
        session?: Record<string, unknown> | null;
      }>(config, MCP_TOOL_NAMES.GET_SESSION_REVIEW, { sessionId }, {
        requestId,
        timeoutMs: MCP_TIMEOUT_MS,
      });
      if (review.ok && review.data?.success && review.data.session) {
        durable = review.data.session;
      }
    }

    if (!state && !active && !durable) {
      return c.json({ success: false, error: `Session '${sessionId}' not found` }, 404);
    }

    const previousStatus = String(
      active?.status ?? state?.status ?? durable?.["status"] ?? "active",
    );
    if (normalizeStatus(previousStatus) === "terminated") {
      return c.json(
        {
          success: false,
          error:
            `Session '${sessionId}' is terminated and cannot be reactivated. ` +
            "Deploy a new session instead.",
          code: SESSION_TERMINATED_CODE,
          sessionId,
          status: "terminated",
          correlationId: requestId,
        },
        409,
      );
    }

    const reactivatedAt = toISOStringLocal(new Date(clock.now()));

    // Durable status becomes `active` — the same transition the auto-clear path
    // already performs, and it grants no new authority: the caller holds the
    // operator key that can terminate or delete the session outright. The lock
    // decision itself is not erased; it stays in the persisted risk assessments
    // and the review timeline.
    await callMcpTool(
      config,
      MCP_TOOL_NAMES.SET_SESSION_STATUS,
      { sessionId, status: "active" },
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );

    if (state) {
      state.status = "active";
      touchSession(state);
      sessionStore.set(sessionId, state);
    }

    activeSessions.set(sessionId, {
      sessionId,
      employeeId: String(
        active?.employeeId ?? state?.employeeId ?? durable?.["employeeId"] ?? "unknown",
      ),
      matrixId: String(
        active?.matrixId ??
          state?.auditId ??
          durable?.["matrixId"] ??
          durable?.["auditId"] ??
          "",
      ),
      targetSystem: String(active?.targetSystem ?? durable?.["targetSystem"] ?? ""),
      status: "active",
      deployedAt: String(
        active?.deployedAt ??
          durable?.["deployedAt"] ??
          durable?.["createdAt"] ??
          reactivatedAt,
      ),
      riskIndex: active?.riskIndex ?? state?.lastRiskPayload?.overallRiskScore ?? 0,
      lastActivityAt: reactivatedAt,
    });

    console.log(
      `[guardian] [${requestId}] session '${sessionId}' reactivated ` +
        `(ttl=${ttlSeconds}s, previous status=${previousStatus})`,
    );

    return c.json({
      success: true,
      sessionId,
      status: "active",
      liveness: "active" satisfies SessionLiveness,
      reactivatedAt,
      previousStatus,
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /sessions/:sessionId/terminate  — stop monitoring, keep data
  // ═══════════════════════════════════════════════════════════════

  guardianRouter.post("/sessions/:sessionId/terminate", async (c) => {
    const sessionId = c.req.param("sessionId");
    const requestId = randomUUID();
    let found = false;

    if (activeSessions.has(sessionId)) {
      activeSessions.delete(sessionId);
      found = true;
    }

    const state = sessionStore.get(sessionId);
    if (state) {
      state.status = "terminated";
      state.endedAt = toISOStringLocal(new Date(clock.now()));
      touchSession(state);
      sessionStore.set(sessionId, state);
      found = true;
    }

    // Only count a durable update that actually matched a document.
    const result = await callMcpTool<{ updated?: boolean }>(
      config,
      MCP_TOOL_NAMES.SET_SESSION_STATUS,
      { sessionId, status: "terminated" },
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );
    if (result.ok && result.data?.updated === true) found = true;

    if (!found) {
      return c.json({ success: false, error: `Session '${sessionId}' not found` }, 404);
    }

    console.log(`[guardian] [${requestId}] session '${sessionId}' terminated (data preserved)`);
    return c.json({ success: true, sessionId, message: "Session terminated (data preserved)" });
  });

  // ═══════════════════════════════════════════════════════════════
  // DELETE /sessions/:sessionId  — permanent deletion
  // ═══════════════════════════════════════════════════════════════

  guardianRouter.delete("/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const requestId = randomUUID();
    let deleted = false;

    if (activeSessions.delete(sessionId)) deleted = true;
    if (sessionStore.delete(sessionId)) deleted = true;

    // Only count a durable deletion that actually removed a document.
    const result = await callMcpTool<{ deleted?: boolean }>(
      config,
      MCP_TOOL_NAMES.DELETE_SESSION,
      { sessionId },
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );
    if (result.ok && result.data?.deleted === true) deleted = true;

    if (!deleted) {
      return c.json({ success: false, error: `Session '${sessionId}' not found` }, 404);
    }

    console.log(`[guardian] [${requestId}] session '${sessionId}' permanently deleted`);
    return c.json({ success: true, sessionId, message: "Session permanently deleted" });
  });

  // ═══════════════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════════════

  async function ensureMongoSession(
    sessionId: string,
    primaryEvent: MicroEvent,
    requestId: string,
  ): Promise<Record<string, unknown> | null> {
    const existing = await callMcpTool<{
      success: boolean;
      session?: Record<string, unknown> | null;
    }>(config, MCP_TOOL_NAMES.GET_SESSION_REVIEW, { sessionId }, {
      requestId,
      timeoutMs: MCP_TIMEOUT_MS,
    });

    if (existing.ok && existing.data?.success && existing.data.session) {
      return existing.data.session;
    }

    const created = await callMcpTool<{ success?: boolean }>(
      config,
      MCP_TOOL_NAMES.CREATE_SESSION,
      {
        sessionId,
        employeeId: primaryEvent.employeeId || "unknown",
        auditId: primaryEvent.auditId || "unknown",
        matrixId: primaryEvent.auditId || "unknown",
        targetSystem: "",
        status: "active",
      },
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );

    if (!created.ok || !created.data?.success) {
      console.warn(`[guardian] [${requestId}] session create failed (non-fatal)`);
      return null;
    }

    // Report the creation instant so the expiry predicate has a trustworthy
    // timestamp for a session that exists durably but has no telemetry yet.
    return {
      sessionId,
      status: "active",
      createdAt: toISOStringLocal(new Date(clock.now())),
    };
  }

  /** Reads a string field from an untyped durable document. */
  function readDurableString(
    source: Record<string, unknown> | null,
    key: string,
  ): string | null {
    const value = source?.[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  /**
   * The activity view of a session, assembled from every source that can carry
   * a trustworthy "last busy" timestamp. The predicate takes the most recent
   * usable one, so a stale durable `updatedAt` cannot expire a session that is
   * still ingesting, and an in-memory timestamp cannot outlive a restart.
   *
   * Only server-generated timestamps appear here. See
   * `../services/session-liveness.ts` for why the client-supplied telemetry
   * timestamp is deliberately excluded.
   */
  function sessionActivity(
    sessionId: string,
    durable: Record<string, unknown> | null,
  ): SessionActivity {
    const state = sessionStore.get(sessionId);
    const active = activeSessions.get(sessionId);

    return {
      lastActivityAt:
        state?.lastActivityAt ?? active?.lastActivityAt ?? active?.deployedAt ?? null,
      persistedUpdatedAt:
        readDurableString(durable, "updatedAt") ??
        readDurableString(durable, "deployedAt") ??
        readDurableString(durable, "createdAt"),
    };
  }

  /**
   * Derived liveness for one session. `durable` is the session document when
   * the caller already holds it, so the common paths do not pay for a second
   * MCP round trip.
   */
  function sessionLiveness(
    sessionId: string,
    durable: Record<string, unknown> | null = null,
  ): SessionLiveness {
    return resolveLiveness(sessionActivity(sessionId, durable), ttlSeconds, clock);
  }

  /** True when the session's monitoring window has closed. */
  function sessionExpired(
    sessionId: string,
    durable: Record<string, unknown> | null = null,
  ): boolean {
    return isExpired(sessionActivity(sessionId, durable), ttlSeconds, clock);
  }

  /**
   * Records the server-observed activity instant for a live session.
   *
   * Called only after a batch survives deduplication, so a replayed batch
   * cannot hold a session open past its TTL.
   */
  function touchSession(session: SessionState): void {
    session.lastActivityAt = toISOStringLocal(new Date(clock.now()));
  }

  /** Dedup layer 3: fingerprint ring suppresses replayed micro-event batches. */
  function processEvent(event: MicroEvent): void {
    const existing = sessionStore.get(event.sessionId);

    if (!existing) {
      const created: SessionState = {
        sessionId: event.sessionId,
        employeeId: event.employeeId,
        auditId: event.auditId,
        events: [],
        currentCode: "",
        pasteCount: 0,
        keystrokeDeltas: [],
        tabSwitchCount: 0,
        fullscreenExitCount: 0,
        copyAttemptCount: 0,
        lastRiskPayload: null,
        eventCount: 0,
        status: "active",
        lastAnalyzedCodeHash: "",
        recentEventFingerprints: new Set(),
      };
      sessionStore.set(event.sessionId, created);
      applyEventToSession(created, event);
      created.recentEventFingerprints.add(computeEventFingerprint(event));
      touchSession(created);
      return;
    }

    const fingerprint = computeEventFingerprint(event);
    // A suppressed replay is not activity: a replayed batch must not be able to
    // hold a session open past its TTL.
    if (existing.recentEventFingerprints.has(fingerprint)) return;

    applyEventToSession(existing, event);
    existing.recentEventFingerprints.add(fingerprint);

    if (existing.recentEventFingerprints.size > 128) {
      const entries = [...existing.recentEventFingerprints];
      existing.recentEventFingerprints = new Set(entries.slice(-128));
    }

    touchSession(existing);
    sessionStore.set(event.sessionId, existing);
  }

  async function lockSession(
    sessionId: string,
    riskPayload: RiskAssessmentPayload,
    requestId: string,
  ): Promise<void> {
    const activityAt = toISOStringLocal(new Date(clock.now()));
    const active = activeSessions.get(sessionId);
    if (active) {
      active.status = "locked";
      active.lastActivityAt = activityAt;
      activeSessions.set(sessionId, active);
    }
    const state = sessionStore.get(sessionId);
    if (state) {
      state.status = "locked";
      touchSession(state);
      sessionStore.set(sessionId, state);
    }

    await callMcpTool(
      config,
      MCP_TOOL_NAMES.SET_SESSION_STATUS,
      { sessionId, status: "locked", reason: riskPayload.incidentSummary },
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );

    console.log(
      `[guardian] [${requestId}] session '${sessionId}' AUTO-LOCKED at risk ${riskPayload.overallRiskScore}`,
    );
  }

  async function unlockSession(sessionId: string, requestId: string): Promise<void> {
    const activityAt = toISOStringLocal(new Date(clock.now()));
    const active = activeSessions.get(sessionId);
    if (active) {
      active.status = "active";
      active.lastActivityAt = activityAt;
      activeSessions.set(sessionId, active);
    }
    const state = sessionStore.get(sessionId);
    if (state) {
      state.status = "active";
      touchSession(state);
      sessionStore.set(sessionId, state);
    }

    await callMcpTool(
      config,
      MCP_TOOL_NAMES.SET_SESSION_STATUS,
      { sessionId, status: "active" },
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );

    console.log(`[guardian] [${requestId}] session '${sessionId}' auto-cleared`);
  }

  return { router: guardianRouter, sessionStore, activeSessions };
}

// ═══════════════════════════════════════════════════════════════════
// Pure helpers (exported for tests)
// ═══════════════════════════════════════════════════════════════════

/** Compute a short dedup fingerprint for a micro-event. */
export function computeEventFingerprint(event: MicroEvent): string {
  const slim: Record<string, unknown> = {
    t: event.eventType,
    p: String(
      event.payload?.pasteContent ?? event.payload?.newText ?? event.payload?.diffPatch ?? "",
    ).slice(0, 512),
  };
  if (event.payload?.changeLength !== undefined) slim["cl"] = event.payload.changeLength;
  if (event.payload?.deltaMs !== undefined) {
    slim["dm"] = Math.round(event.payload.deltaMs / 10) * 10; // bucket to 10ms
  }
  return JSON.stringify(slim);
}

/** Mutates session state in place for a single micro-event. */
export function applyEventToSession(session: SessionState, event: MicroEvent): void {
  session.events.push(event);

  switch (event.eventType) {
    case "KEYSTROKE":
      if (event.payload.deltaMs !== undefined) {
        session.keystrokeDeltas.push(event.payload.deltaMs);
      }
      break;
    case "PASTE_TRIGGER":
      session.pasteCount++;
      if (event.payload.pasteContent) session.currentCode += event.payload.pasteContent;
      break;
    case "CODE_DELTA":
      if (event.payload.diffPatch) {
        session.currentCode = applyDiffPatch(session.currentCode, event.payload.diffPatch);
      }
      break;
    case "TAB_SWITCH":
      session.tabSwitchCount++;
      break;
    case "WINDOW_BLUR":
    case "FULLSCREEN_EXIT":
      session.fullscreenExitCount++;
      break;
    case "COPY_ATTEMPT":
      session.copyAttemptCount++;
      break;
    case "SUBMIT":
      if (event.payload.pasteContent) session.currentCode = event.payload.pasteContent;
      break;
    case "EDIT":
      if (event.payload.newText !== undefined) session.currentCode = event.payload.newText;
      break;
    case "PASTE":
      session.pasteCount++;
      if (event.payload.newText !== undefined) session.currentCode = event.payload.newText;
      if (event.payload.changeLength !== undefined) {
        session.keystrokeDeltas.push(event.payload.changeLength);
      }
      break;
    default:
      break;
  }
}

export function hasAnomalousKeystrokes(
  deltas: number[],
  config: Pick<AppConfig, "security">,
): boolean {
  if (deltas.length < 10) return false;
  const fastCount = deltas.filter(
    (delta) => delta < config.security.minHumanKeystrokeMs,
  ).length;
  return fastCount / deltas.length > 0.3;
}

/**
 * Clamps a computed risk score into the 0-100 range the contract documents.
 *
 * The parsers already clamp what the model supplies, so this is a second line of
 * defence on the composed value. The behavioural blend multiplies by a factor
 * derived from the semantic score, and a non-finite result must not be able to
 * turn a score into `NaN`: `NaN >= AUTO_LOCK_THRESHOLD` is false, so a NaN score
 * would silently disable the auto-lock rather than fail loudly.
 */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), 100);
}

export function computeKeystrokeMetrics(deltas: number[]): {
  avgDeltaMs: number;
  maxDeltaMs: number;
  minDeltaMs: number;
} {
  if (deltas.length === 0) return { avgDeltaMs: 0, maxDeltaMs: 0, minDeltaMs: 0 };
  return {
    avgDeltaMs: deltas.reduce((a, b) => a + b, 0) / deltas.length,
    maxDeltaMs: Math.max(...deltas),
    minDeltaMs: Math.min(...deltas),
  };
}

export function applyDiffPatch(current: string, diffPatch: string): string {
  if (diffPatch.startsWith("@@") || diffPatch.startsWith("---")) {
    const newLines = diffPatch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));
    return newLines.length > 0 ? newLines.join("\n") : current;
  }
  return current + diffPatch;
}

export function collectPasteContents(events: MicroEvent[]): string[] {
  return events
    .filter(
      (event) =>
        (event.eventType === "PASTE_TRIGGER" && event.payload.pasteContent) ||
        (event.eventType === "PASTE" && event.payload.newText),
    )
    .map((event) => event.payload.pasteContent ?? event.payload.newText ?? "");
}

/**
 * Every status a session document may legitimately carry.
 *
 * This is the union of the review vocabulary and the MCP adapter's writable
 * set, and it deliberately includes `terminated`: a session recovered from
 * MongoDB after a restart must not be reported as live again.
 */
export const PERSISTED_SESSION_STATUSES = [
  "active",
  "flagged",
  "investigating",
  "cleared",
  "locked",
  "terminated",
] as const;

export type PersistedSessionStatus = (typeof PERSISTED_SESSION_STATUSES)[number];

/** Maps an arbitrary stored value onto the known status vocabulary. */
export function normalizeStatus(raw: string): PersistedSessionStatus {
  return (PERSISTED_SESSION_STATUSES as readonly string[]).includes(raw)
    ? (raw as PersistedSessionStatus)
    : "active";
}

/** A terminated session is preserved for review but is no longer monitored. */
export function isMonitored(status: PersistedSessionStatus): boolean {
  return status !== "terminated";
}

function buildIncidentSummary(
  session: SessionState,
  payload: RiskAssessmentPayload,
  config: AppConfig,
): string {
  const parts: string[] = [];

  if (payload.pasteSnippets && payload.pasteSnippets.length > 0) {
    parts.push(
      `${payload.pasteSnippets.length} paste event${payload.pasteSnippets.length > 1 ? "s" : ""} ` +
        `(${payload.pasteLineCount} lines)`,
    );
  }
  if (session.tabSwitchCount > 0) {
    parts.push(
      `${session.tabSwitchCount} tab switch${session.tabSwitchCount > 1 ? "es" : ""}`,
    );
  }
  if (session.copyAttemptCount > 0) {
    parts.push(
      `${session.copyAttemptCount} copy attempt${session.copyAttemptCount > 1 ? "s" : ""}`,
    );
  }
  if (session.fullscreenExitCount > 0) parts.push("fullscreen exit detected");
  if (hasAnomalousKeystrokes(session.keystrokeDeltas, config)) {
    parts.push("anomalous keystroke rhythm");
  }

  return parts.length > 0
    ? parts.join(" . ")
    : `Risk score: ${payload.overallRiskScore.toFixed(0)}%`;
}

/**
 * Reference completions for similarity comparison.
 * The historical implementation queried a cache of known model outputs; that
 * cache was never populated, so this returns an empty set. The mechanism is
 * retained because the risk-analysis contract consumes it.
 */
async function getReferenceCompletions(): Promise<string[]> {
  return [];
}

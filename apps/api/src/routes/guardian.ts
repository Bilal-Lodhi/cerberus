/**
 * Route group: /api/v1/guardian
 *
 * Real-time insider-threat and data-exfiltration monitoring.
 *
 *   POST   /ingest                              batch telemetry ingestion
 *   POST   /deploy                              create a monitored session
 *   GET    /sessions                            list sessions (union of live + durable)
 *   GET    /sessions/:sessionId                 live session detail
 *   POST   /sessions/:sessionId/terminate       stop monitoring, preserve data
 *   DELETE /sessions/:sessionId                 delete session and all derived data
 *
 * Persistence flows through the MCP MongoDB sidecar. Every MCP call is
 * timeout-isolated so a slow database degrades the response rather than
 * stalling the ingestion loop.
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
import { toISOStringLocal, formatLocalTime } from "../utils/time.js";

const MCP_TIMEOUT_MS = 5_000;

/** Re-exported so the review router can type its shared registries. */
export type { ActiveSession };

/** High-risk threshold that triggers the agentic auto-lock. */
export const AUTO_LOCK_THRESHOLD = 75;
/** Risk score at or below which a locked session is auto-cleared. */
export const AUTO_CLEAR_THRESHOLD = 25;

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
}

export interface GuardianRouterBundle {
  router: Hono;
  sessionStore: Map<string, SessionState>;
  activeSessions: Map<string, ActiveSession>;
}

export function createGuardianRouter(config: AppConfig): GuardianRouterBundle {
  const guardianRouter = new Hono();

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
      // 1. Ensure the session document exists.
      await ensureMongoSession(sessionId, primaryEvent, requestId);

      // 2. Persist the raw telemetry.
      await callMcpTool(
        config,
        MCP_TOOL_NAMES.INGEST_MICRO_EVENTS,
        { events: body.events },
        { requestId, timeoutMs: MCP_TIMEOUT_MS },
      );

      // 3. Apply events to in-memory state.
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

      // 4. Update durable aggregate counters.
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

      // 5. Decide whether this batch warrants AI analysis.
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

          const blendedScore = Math.min(
            Math.round(semanticScore * 0.85 + behaviouralBoost * 0.15),
            100,
          );
          riskPayload.overallRiskScore = blendedScore;

          const boostFactor = semanticScore > 0 ? blendedScore / semanticScore : 1.0;
          riskPayload.dimensionScores.dataExfiltration = Math.min(
            Math.round(
              riskPayload.dimensionScores.dataExfiltration * boostFactor + pastePenalty * 0.8,
            ),
            100,
          );
          riskPayload.dimensionScores.policyViolation = Math.min(
            Math.round(
              riskPayload.dimensionScores.policyViolation * boostFactor +
                tabPenalty * 0.6 +
                copyPenalty * 0.5,
            ),
            100,
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

    // Path A1 — live in-memory state (authoritative event counts).
    if (sessionStore.size > 0) {
      const entries = Array.from(sessionStore.entries()).sort((a, b) => {
        const aTime = a[1].events[0]?.timestamp ?? "";
        const bTime = b[1].events[0]?.timestamp ?? "";
        return new Date(bTime).getTime() - new Date(aTime).getTime();
      });

      for (const [sessionId, state] of entries) {
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
      seenIds.add(sessionId);
      allSessions.push({
        sessionId,
        employeeId: active.employeeId || "unknown",
        auditId: active.matrixId,
        matrixId: active.matrixId,
        targetSystem: active.targetSystem,
        status: active.status,
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
          });
        }

        allSessions.push({
          sessionId,
          employeeId,
          auditId: matrixId,
          matrixId,
          targetSystem: String(doc["targetSystem"] ?? ""),
          status,
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
      state.endedAt = toISOStringLocal();
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
  ): Promise<void> {
    const existing = await callMcpTool<{ success: boolean; session?: unknown }>(
      config,
      MCP_TOOL_NAMES.GET_SESSION_REVIEW,
      { sessionId },
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );

    if (existing.ok && existing.data?.success && existing.data.session) return;

    const created = await callMcpTool(
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

    if (!created.ok) {
      console.warn(`[guardian] [${requestId}] session create failed (non-fatal)`);
    }
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
      return;
    }

    const fingerprint = computeEventFingerprint(event);
    if (existing.recentEventFingerprints.has(fingerprint)) return;

    applyEventToSession(existing, event);
    existing.recentEventFingerprints.add(fingerprint);

    if (existing.recentEventFingerprints.size > 128) {
      const entries = [...existing.recentEventFingerprints];
      existing.recentEventFingerprints = new Set(entries.slice(-128));
    }

    sessionStore.set(event.sessionId, existing);
  }

  async function lockSession(
    sessionId: string,
    riskPayload: RiskAssessmentPayload,
    requestId: string,
  ): Promise<void> {
    const active = activeSessions.get(sessionId);
    if (active) {
      active.status = "locked";
      activeSessions.set(sessionId, active);
    }
    const state = sessionStore.get(sessionId);
    if (state) {
      state.status = "locked";
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
    const active = activeSessions.get(sessionId);
    if (active) {
      active.status = "active";
      activeSessions.set(sessionId, active);
    }
    const state = sessionStore.get(sessionId);
    if (state) {
      state.status = "active";
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

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
 *   1. code-hash equality — skip re-analysis when the workspace is unchanged
 *   2. micro-event fingerprint ring (last 128) — suppress replayed batches
 *   3. behavioural counter blend — repeated violations amplify the score
 *
 * A fourth layer was previously described here as "identical risk-assessment id
 * from the AI provider". It was never implemented: nothing in the ingest path
 * compares `riskAssessmentId`, and `risk_assessments` has no unique index on it,
 * so a retry after a restart can write a second assessment row for one incident.
 * The claim is removed rather than left standing, and the durable idempotency it
 * described is tracked as open work in
 * `docs/development/failure-semantics.md` §3.9.
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
import {
  acceptsTelemetry,
  createSessionTransitions,
  type SessionTransitionCache,
  type SessionTransitionResult,
} from "../services/session-transition.js";
import {
  normalizeStatus,
  isMonitored,
  SESSION_TRANSITION_CODES,
} from "../services/session-status.js";
import {
  findSimilarityMatches,
  type ReferenceDocument,
} from "../services/text-similarity.js";
import { toISOStringLocal, formatLocalTime } from "../utils/time.js";

const MCP_TIMEOUT_MS = 5_000;

/**
 * Upper bound on how many reference documents one analysis loads.
 *
 * Matches the MCP adapter's own ceiling. The corpus is read in full per
 * analysis, so this is what bounds the comparison work rather than the
 * operator's corpus size.
 */
const MAX_CORPUS_DOCUMENTS = 200;

/** Re-exported so the review router can type its shared registries. */
export type { ActiveSession };

/** High-risk threshold that triggers the agentic auto-lock. */
export const AUTO_LOCK_THRESHOLD = 75;
/** Risk score at or below which a locked session is auto-cleared. */
export const AUTO_CLEAR_THRESHOLD = 25;

/** Stable error code returned when telemetry targets an expired session. */
export const SESSION_EXPIRED_CODE = "SESSION_EXPIRED";
/**
 * Stable error code returned when an action is refused because the session is
 * terminal.
 *
 * An alias of the transition boundary's own code rather than a second literal, so the
 * value has one definition. It is returned by `reactivate` and by ingest, which is
 * deliberate: one meaning — the session has ended — rather than a code per action.
 */
export const SESSION_TERMINATED_CODE = SESSION_TRANSITION_CODES.SESSION_TERMINAL;

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
  /**
   * Total events accepted for this session, **including events accepted before
   * this process started**.
   *
   * Hydrated from the durable document and incremented once per accepted event,
   * so it is the session's lifetime total rather than a post-restart count. This
   * is what the durable `eventCount` is written from; `events.length` is only
   * what this process has seen.
   */
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

  /**
   * The cache surface the transition boundary repairs.
   *
   * `apply` seeds a missing `activeSessions` entry from the durable document, which is
   * what reactivation needs after a restart: the process holds nothing for the session,
   * and the registry entry has to be rebuilt from the sources that survived — the
   * durable `employeeId`, `matrixId`/`auditId`, `targetSystem`, `deployedAt` and
   * `peakRiskScore`. Before the boundary existed this rebuild lived inside the
   * reactivate route, so it was one of five paths that each did it differently.
   */
  const transitionCache: SessionTransitionCache = {
    read(sessionId) {
      const active = activeSessions.get(sessionId);
      if (active) return normalizeStatus(active.status);
      const state = sessionStore.get(sessionId);
      return state ? normalizeStatus(state.status) : null;
    },

    apply(sessionId, status, at, durable) {
      const state = sessionStore.get(sessionId);
      if (state) {
        state.status = status;
        state.lastActivityAt = at;
        sessionStore.set(sessionId, state);
      }

      const active = activeSessions.get(sessionId);
      if (active) {
        active.status = status as ActiveSession["status"];
        active.lastActivityAt = at;
        activeSessions.set(sessionId, active);
        return;
      }

      // No registry entry: rebuild one, but only for a status that is still
      // monitored. A terminated session must never re-enter the live registry, or a
      // restart would resurrect it as actively monitored.
      if (!isMonitored(status)) return;

      const matrixId = String(durable["matrixId"] ?? durable["auditId"] ?? "");
      activeSessions.set(sessionId, {
        sessionId,
        employeeId: String(durable["employeeId"] ?? state?.employeeId ?? "unknown"),
        matrixId,
        targetSystem: String(durable["targetSystem"] ?? ""),
        status: status as ActiveSession["status"],
        deployedAt: String(
          durable["deployedAt"] ?? durable["createdAt"] ?? at,
        ),
        riskIndex: Number(
          durable["peakRiskScore"] ?? durable["overallRiskScore"] ?? durable["riskIndex"] ?? 0,
        ),
        lastActivityAt: at,
      });
    },

    evict(sessionId) {
      // Only the live registry: `sessionStore` keeps the session so its counters and
      // reconstructed state remain readable for review.
      activeSessions.delete(sessionId);
    },
  };

  /** The one place a session lifecycle status changes. */
  const transitions = createSessionTransitions({ config, clock, cache: transitionCache });

  /**
   * Renders a refused transition as an HTTP response.
   *
   * Every refusal already carries a stable code, the right status and a
   * client-facing message, so a route does not re-derive any of them.
   */
  function refusalResponse(refusal: Extract<SessionTransitionResult, { ok: false }>) {
    return {
      body: {
        success: false as const,
        error: refusal.message,
        code: refusal.code,
        sessionId: refusal.sessionId,
        ...(refusal.previousStatus !== undefined
          ? { status: refusal.previousStatus }
          : {}),
      },
      status: refusal.httpStatus as 404 | 409 | 503,
    };
  }

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

    // `MicroEvent.eventId` is required by the contract and is the durable
    // idempotency key, so an event without one cannot be deduplicated. Rejecting
    // it is validating the declared shape rather than tightening it.
    const malformed = body.events.find(
      (event) =>
        event === null ||
        typeof event !== "object" ||
        typeof event.eventId !== "string" ||
        event.eventId.trim().length === 0,
    );
    if (malformed !== undefined) {
      return c.json(
        {
          success: false,
          error: "Each event must contain a non-empty 'eventId'",
          code: "MISSING_EVENT_ID",
          correlationId: requestId,
        },
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

      // 2b. Refuse telemetry for a session that has been terminated.
      //
      //     `terminated` is the one irreversible lifecycle state, and this check is
      //     what makes it terminal. Without it, a terminated session that had not yet
      //     exceeded its TTL accepted telemetry, advanced its durable counters, and —
      //     on a high-risk batch — was moved to `locked` by the auto-lock path, which
      //     had no precondition either. Observed before the fix: `terminated` →
      //     ingest `200` → durable status `locked`, with two further `micro_events`
      //     stored. `reactivate` already refused exactly that transition, so the two
      //     paths disagreed about whether `terminated` was reversible.
      //
      //     The status is read from the document this request already fetched, so the
      //     check costs nothing extra. `acceptsTelemetry` is the boundary's rule, not
      //     a second copy of it.
      if (
        durableSession &&
        !acceptsTelemetry(normalizeStatus(String(durableSession["status"] ?? "active")))
      ) {
        console.warn(
          `[guardian] [${requestId}] rejected ingest for terminated session '${sessionId}'`,
        );
        return c.json(
          {
            success: false,
            error:
              `Session '${sessionId}' is terminated and no longer accepts telemetry. ` +
              "Deploy a new session to resume monitoring.",
            code: SESSION_TRANSITION_CODES.SESSION_TERMINAL,
            sessionId,
            status: "terminated",
            correlationId: requestId,
          },
          409,
        );
      }

      // 3. Persist the raw telemetry. The store reports which events were newly
      //    inserted, and that report is the durable idempotency signal.
      const persisted = await callMcpTool<{
        success?: boolean;
        acceptedEventIds?: string[];
        duplicateEventIds?: string[];
      }>(
        config,
        MCP_TOOL_NAMES.INGEST_MICRO_EVENTS,
        { events: body.events },
        { requestId, timeoutMs: MCP_TIMEOUT_MS },
      );

      const acceptedIds = persisted.ok ? persisted.data?.acceptedEventIds : undefined;
      const duplicateIds = persisted.ok ? persisted.data?.duplicateEventIds : undefined;
      const acceptedSet = Array.isArray(acceptedIds) ? new Set(acceptedIds) : null;

      if (duplicateIds && duplicateIds.length > 0) {
        console.log(
          `[guardian] [${requestId}] ${duplicateIds.length}/${processedCount} event(s) ` +
            `already stored — not re-applied`,
        );
      }

      // 4. Apply events to in-memory state, hydrating from the durable document
      //    first when this process has not seen the session — otherwise the
      //    counters below would start at zero and be written back over the
      //    durable totals.
      //
      //    Only events the store reports as newly inserted are applied. The
      //    in-process fingerprint ring is now a cache in front of a durable
      //    guarantee, not the guarantee itself: a retry after a restart used to
      //    re-inflate the counters that were just hydrated.
      //
      //    When persistence is unavailable there is no report. Every event is
      //    then applied in memory, because dropping telemetry is worse than a
      //    possible over-count in a session whose events were never stored.
      hydrateSessionFromDurable(sessionId, primaryEvent, durableSession);
      for (const event of body.events) {
        if (acceptedSet && !acceptedSet.has(event.eventId)) continue;
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
            // The hydrated lifetime total, not `events.length` — which is only
            // what this process has seen since it started.
            eventCount: session.eventCount,
            pasteCount: session.pasteCount,
            tabSwitchCount: session.tabSwitchCount,
            // Previously omitted, so MongoDB never learned this counter and a
            // restart reset it to 0 — which silently disabled the fullscreen-exit
            // analysis trigger and its score penalty.
            fullscreenExitCount: session.fullscreenExitCount,
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
        const referenceCorpus = await loadReferenceCorpus(requestId);

        try {
          const analysisStartMs = Date.now();
          riskPayload = await getAIProvider(config).analyzeRisk(
            session.currentCode,
            pasteContents,
            keystrokeMetrics,
            referenceCorpus.map((reference) => reference.content),
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

          // ── Exfiltration similarity is computed locally, deterministically ──
          //
          // The report is replaced, not merged: a similarity claim is evidence,
          // and only the local comparison is reproducible from the corpus and the
          // threshold. The model's version is discarded because it cannot be
          // re-derived, audited, or gated by `DATA_LEAKAGE_SIMILARITY_THRESHOLD`
          // — which the model never sees.
          const similarity = findSimilarityMatches(
            pasteContents,
            referenceCorpus,
            config.security.dataLeakageSimilarityThreshold,
          );
          riskPayload.exfiltrationReport = {
            overallSimilarity: similarity.overallSimilarity,
            matchedSnippets: similarity.matches.map((match) => ({
              sourceSnippet: match.sourceSnippet,
              employeeSnippet: match.employeeSnippet,
              similarityScore: match.similarityScore,
              sourceLabel: match.sourceLabel,
            })),
            // Always 0: Cerberus does not attempt to determine whether content
            // was machine-generated, and reporting a guess here would present an
            // unfounded number as a measurement.
            aiCompletionLikelihood: 0,
          };

          if (similarity.matches.length > 0) {
            console.log(
              `[guardian] [${requestId}] ${similarity.matches.length} similarity ` +
                `match(es) at or above ${config.security.dataLeakageSimilarityThreshold} ` +
                `(best=${similarity.overallSimilarity.toFixed(3)})`,
            );
          }

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
        // Additive: `processedCount` keeps its meaning (the batch size), and these
        // say how much of it was new. A caller retrying after a network ambiguity
        // can see that its events were already stored.
        acceptedCount: acceptedIds?.length ?? processedCount,
        duplicateCount: duplicateIds?.length ?? 0,
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
          // The hydrated lifetime total, not just what this process has seen.
          eventCount: Math.max(session.events.length, session.eventCount),
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
    //
    // A *terminated* session is not live either, and it is excluded for the same
    // reason. That exclusion was missing from the in-memory path: the TTL predicate
    // was the only filter, so a session an operator had just terminated stayed in the
    // live list — with `status: "terminated"` and `liveness: "active"` — until its TTL
    // elapsed or the process restarted. The durable-recovery path below already
    // guarded on `isMonitored`, so the two paths disagreed about the same session.

    // Path A1 — live in-memory state (authoritative event counts).
    if (sessionStore.size > 0) {
      const entries = Array.from(sessionStore.entries()).sort((a, b) => {
        const aTime = a[1].events[0]?.timestamp ?? "";
        const bTime = b[1].events[0]?.timestamp ?? "";
        return new Date(bTime).getTime() - new Date(aTime).getTime();
      });

      for (const [sessionId, state] of entries) {
        if (sessionExpired(sessionId)) continue;

        // The cache, when it holds the session, is what the transition boundary last
        // wrote from the durable outcome. When it does not, `sessionStore` is the only
        // in-memory source and its status came from the same place.
        const effectiveStatus = normalizeStatus(
          activeSessions.get(sessionId)?.status ?? state.status,
        );
        if (!isMonitored(effectiveStatus)) continue;

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
          eventCount: Math.max(state.events.length, state.eventCount),
          pasteCount: state.pasteCount,
          tabSwitchCount: state.tabSwitchCount,
          fullscreenExitCount: state.fullscreenExitCount,
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
      // The boundary evicts a terminated session from this registry, so this should
      // never fire. It is asserted anyway: the live list must not depend on every
      // writer remembering to evict.
      if (!isMonitored(normalizeStatus(active.status))) continue;
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
        fullscreenExitCount: 0,
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

        const status = normalizeStatus(String(doc["status"] ?? "active"));

        // A terminated session is not live, so it is not listed here at all. It stays
        // fully visible through `GET /api/v1/sessions` and
        // `GET /api/v1/sessions/:sessionId`, which are the review surfaces.
        //
        // This check was previously applied only to the registry write below, not to
        // the list entry, so a terminated session recovered from MongoDB **was**
        // returned by the live list — with `liveness: "active"`. The in-memory paths
        // had the same gap in the other direction, and the three of them disagreed.
        if (!isMonitored(status)) continue;

        seenIds.add(sessionId);

        const employeeId = String(doc["employeeId"] ?? "unknown");
        const matrixId = String(doc["matrixId"] ?? doc["auditId"] ?? "");
        const deployedAt = String(doc["deployedAt"] ?? doc["createdAt"] ?? toISOStringLocal());
        const riskScore = Number(
          doc["peakRiskScore"] ?? doc["overallRiskScore"] ?? doc["riskIndex"] ?? 0,
        );

        // Rebuild the live registry from the durable document. A terminated session
        // cannot reach here, because it was skipped above.
        if (!activeSessions.has(sessionId)) {
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
          fullscreenExitCount: Number(doc["fullscreenExitCount"] ?? 0),
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
   * Idempotent for a live session. A `terminated` session is refused with
   * `409 SESSION_TERMINATED`: the terminal state is not reversible, exactly as in the
   * restart-recovery path.
   *
   * The durable status is read and written by the transition boundary, so this route
   * no longer rebuilds the live-registry entry itself — that rebuild is one of the
   * things the boundary's cache adapter owns, and doing it in two places is how the
   * five paths drifted apart in the first place.
   */
  guardianRouter.post("/sessions/:sessionId/reactivate", async (c) => {
    const sessionId = c.req.param("sessionId");
    const requestId = randomUUID();

    const result = await transitions.reactivate(sessionId, requestId);
    if (!result.ok) {
      const { body, status } = refusalResponse(result);
      return c.json({ ...body, correlationId: requestId }, status);
    }

    const reactivatedAt = toISOStringLocal(new Date(clock.now()));

    console.log(
      `[guardian] [${requestId}] session '${sessionId}' reactivated ` +
        `(ttl=${ttlSeconds}s, previous status=${result.previousStatus}, ` +
        `applied=${result.applied})`,
    );

    return c.json({
      success: true,
      sessionId,
      status: result.status,
      liveness: "active" satisfies SessionLiveness,
      reactivatedAt,
      previousStatus: result.previousStatus,
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /sessions/:sessionId/terminate  — stop monitoring, keep data
  // ═══════════════════════════════════════════════════════════════

  /**
   * Stops monitoring and preserves every document.
   *
   * The durable write happens **before** either cache is touched, and its result
   * decides the response. Previously the cache was mutated first and the durable
   * result was used only to compute `found`, so a failed write returned
   * `200 success: true` while MongoDB still said `active` — and a restart resurrected
   * a session the operator had terminated.
   */
  guardianRouter.post("/sessions/:sessionId/terminate", async (c) => {
    const sessionId = c.req.param("sessionId");
    const requestId = randomUUID();

    const result = await transitions.terminate(sessionId, requestId);
    if (!result.ok) {
      const { body, status } = refusalResponse(result);
      return c.json(body, status);
    }

    // `endedAt` is display state derived from the transition instant; it is not part
    // of the durable status, and `status: "terminated"` is the durable signal.
    const state = sessionStore.get(sessionId);
    if (state) {
      state.endedAt = toISOStringLocal(new Date(clock.now()));
    }

    console.log(
      `[guardian] [${requestId}] session '${sessionId}' terminated (data preserved, ` +
        `applied=${result.applied})`,
    );
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
    // Only the session document is used here, so neither the events nor the
    // assessments are asked for. By default this call would carry up to 500
    // micro-events plus every risk assessment on **every ingest request** and discard
    // all of it — a read cost proportional to the session's history, paid per event.
    //
    // `eventsLimit: 0` skips the query rather than passing 0 down, because MongoDB's
    // `.limit(0)` means "no limit". See `get_session_review` in the MCP tool registry.
    const existing = await callMcpTool<{
      success: boolean;
      session?: Record<string, unknown> | null;
    }>(
      config,
      MCP_TOOL_NAMES.GET_SESSION_REVIEW,
      { sessionId, eventsLimit: 0, includeAssessments: false },
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );

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
    return isExpired(sessionActivity(sessionId, durable), ttlSeconds, clock);  }

  /**
   * Records the server-observed activity instant for a live session.
   *
   * Called only after a batch survives deduplication, so a replayed batch
   * cannot hold a session open past its TTL.
   */
  function touchSession(session: SessionState): void {
    session.lastActivityAt = toISOStringLocal(new Date(clock.now()));
  }

  /** Reads a finite, non-negative counter from an untyped durable document. */
  function readDurableCounter(
    durable: Record<string, unknown> | null,
    key: string,
  ): number {
    const value = durable?.[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  }

  /**
   * Seeds in-memory session state from its durable document.
   *
   * A restart empties `sessionStore`, so without this the first batch after a
   * restart is applied to counters starting at zero — and then written back,
   * replacing the durable totals with the post-restart ones. Counters must be
   * *hydrated* before any event is applied, not merely initialised. The storage
   * layer also applies counters with `$max`, so a missed hydration cannot lose a
   * total either; together, neither the caller nor the database is a single point
   * of failure for this.
   *
   * Only counters and identity are seeded. The event array, the reconstructed
   * workspace and the risk payload are deliberately left empty: they are
   * reconstructed on read from where they actually live (`micro_events` and
   * `risk_assessments`), so copying them here would create a second, staler copy.
   */
  function hydrateSessionFromDurable(
    sessionId: string,
    primaryEvent: MicroEvent,
    durable: Record<string, unknown> | null,
  ): void {
    if (sessionStore.has(sessionId) || !durable) return;

    const eventCount = readDurableCounter(durable, "eventCount");
    const pasteCount = readDurableCounter(durable, "pasteCount");

    sessionStore.set(sessionId, {
      sessionId,
      employeeId:
        primaryEvent.employeeId || readDurableString(durable, "employeeId") || "unknown",
      auditId: primaryEvent.auditId || readDurableString(durable, "auditId") || "unknown",
      events: [],
      currentCode: "",
      pasteCount,
      keystrokeDeltas: [],
      tabSwitchCount: readDurableCounter(durable, "tabSwitchCount"),
      fullscreenExitCount: readDurableCounter(durable, "fullscreenExitCount"),
      copyAttemptCount: readDurableCounter(durable, "copyAttemptCount"),
      lastRiskPayload: null,
      eventCount,
      status: normalizeStatus(String(durable["status"] ?? "active")),
      lastAnalyzedCodeHash: "",
      recentEventFingerprints: new Set(),
      lastActivityAt: readDurableString(durable, "updatedAt") ?? undefined,
    });

    console.log(
      `[guardian] hydrated session '${sessionId}' from durable state — ` +
        `eventCount=${eventCount} pasteCount=${pasteCount}`,
    );
  }

  /**
   * Loads the operator-managed reference corpus for similarity comparison.
   *
   * The corpus is read in full on every analysis: one bounded MCP call against a
   * local database, alongside the two or three the analysis path already makes.
   * A cache would be cheaper, but its staleness would be invisible to the
   * operator who just edited the corpus.
   *
   * A failure returns an empty corpus rather than failing the analysis.
   * Similarity matching is one signal among several, and losing it must not lose
   * the telemetry or the risk score. The failure is logged.
   */
  async function loadReferenceCorpus(
    requestId: string,
  ): Promise<ReferenceDocument[]> {
    const listed = await callMcpTool<{
      success: boolean;
      data?: Array<Record<string, unknown>>;
    }>(
      config,
      MCP_TOOL_NAMES.LIST_REFERENCE_DOCUMENTS,
      { limit: MAX_CORPUS_DOCUMENTS },
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );

    if (!listed.ok || !listed.data?.success) {
      console.warn(
        `[guardian] [${requestId}] reference corpus unavailable — similarity matching skipped`,
      );
      return [];
    }

    const documents = Array.isArray(listed.data.data) ? listed.data.data : [];
    return documents
      .filter(
        (document): document is Record<string, unknown> =>
          typeof document === "object" && document !== null,
      )
      .map((document) => ({
        referenceId: String(document["referenceId"] ?? ""),
        label: String(document["label"] ?? "unknown"),
        content: typeof document["content"] === "string" ? document["content"] : "",
      }))
      .filter(
        (document) => document.referenceId.length > 0 && document.content.length > 0,
      );
  }

  /**
   * Dedup layer 3: the content fingerprint ring suppresses replayed
   * content-bearing events.
   *
   * Scoped to content-bearing types (see {@link isContentBearingEvent}): a signal
   * event is deduplicated by `eventId` alone, at the storage layer, because two
   * signals with identical payloads are two events.
   *
   * This ring is a best-effort *cache* in front of that durable guarantee. It does
   * not survive a restart, and it is not a security control — the monitored client
   * supplies `eventId`, so it can defeat either layer by sending a fresh one.
   */
  function processEvent(event: MicroEvent): void {
    const existing = sessionStore.get(event.sessionId);
    const contentBearing = isContentBearingEvent(event.eventType);
    const fingerprint = contentBearing ? computeEventFingerprint(event) : "";

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
      if (contentBearing) created.recentEventFingerprints.add(fingerprint);
      created.eventCount++;
      touchSession(created);
      return;
    }

    // A suppressed replay is not activity: a replayed batch must not be able to
    // hold a session open past its TTL.
    if (contentBearing && existing.recentEventFingerprints.has(fingerprint)) return;

    applyEventToSession(existing, event);
    if (contentBearing) existing.recentEventFingerprints.add(fingerprint);
    // Counted only on accept, so a suppressed replay does not inflate the
    // lifetime total either.
    existing.eventCount++;

    if (existing.recentEventFingerprints.size > 128) {
      const entries = [...existing.recentEventFingerprints];
      existing.recentEventFingerprints = new Set(entries.slice(-128));
    }

    touchSession(existing);
    sessionStore.set(event.sessionId, existing);
  }

  /**
   * Auto-locks a session on a high blended score.
   *
   * Delegates to the transition boundary, which reads the durable status, refuses the
   * transition for a `terminated` session, writes the status with a predicate on the
   * status it read, and repairs the caches from the durable outcome. The previous
   * implementation wrote the caches **first** and did not inspect the durable result,
   * so a failed write left the API reporting `locked` while MongoDB said `active` —
   * invisible until a restart, at which point the lock disappeared.
   */
  async function lockSession(
    sessionId: string,
    riskPayload: RiskAssessmentPayload,
    requestId: string,
  ): Promise<void> {
    const result = await transitions.autoLock(sessionId, requestId);

    if (!result.ok) {
      // A refusal is not fatal to the batch: the telemetry is already durable and the
      // assessment is still stored. It is logged because it means the session is not
      // in the state the score suggests it should be.
      console.warn(
        `[guardian] [${requestId}] auto-lock refused for session '${sessionId}': ` +
          `${result.code} (status=${result.previousStatus ?? "unknown"})`,
      );
      return;
    }

    console.log(
      `[guardian] [${requestId}] session '${sessionId}' AUTO-LOCKED at risk ` +
        `${riskPayload.overallRiskScore} (applied=${result.applied})`,
    );
  }

  /** Auto-clears a locked session once its score falls below the clear threshold. */
  async function unlockSession(sessionId: string, requestId: string): Promise<void> {
    const result = await transitions.autoClear(sessionId, requestId);

    if (!result.ok) {
      console.warn(
        `[guardian] [${requestId}] auto-clear refused for session '${sessionId}': ` +
          `${result.code} (status=${result.previousStatus ?? "unknown"})`,
      );
      return;
    }

    console.log(
      `[guardian] [${requestId}] session '${sessionId}' auto-cleared ` +
        `(applied=${result.applied})`,
    );
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

/**
 * Event types whose payload is content that can legitimately repeat, and whose
 * repeat is more likely a replay than a second real event.
 *
 * Everything else is a *signal*: a keystroke, a focus change, a copy attempt.
 * Two signals with identical payloads are two events, not one — two keystrokes
 * with the same inter-key delay are two keystrokes. Deduplicating those by
 * content silently loses telemetry, which is why content dedup is scoped to the
 * types below and every other type is deduplicated by `eventId` alone.
 */
const CONTENT_BEARING_EVENT_TYPES: ReadonlySet<string> = new Set([
  "PASTE",
  "PASTE_TRIGGER",
  "EDIT",
  "CODE_DELTA",
  "SUBMIT",
]);

/** True when content dedup applies to this event type. */
export function isContentBearingEvent(eventType: string): boolean {
  return CONTENT_BEARING_EVENT_TYPES.has(eventType);
}

/**
 * How many recent events a live session keeps in memory.
 *
 * The durable record is the `micro_events` collection; memory holds a **recent
 * window** for analysis. Before this, `session.events` grew for the session's whole
 * lifetime — `MAX_EVENTS_PER_BATCH` bounds one request, not a session — so a long
 * session grew without limit and every consumer that scanned the array became slower
 * as it did. Measured: ingest cost grew linearly with the events held, from 0.44 ms
 * against an empty session to 11.53 ms against one holding 5 000
 * (`docs/development/performance-baseline.md`).
 *
 * 1 000 events is well over the horizon any current check needs: the analysis
 * triggers are all counter-based or look at the most recent paste.
 */
export const MAX_IN_MEMORY_EVENTS = 1_000;

/**
 * How many recent keystroke deltas feed the typing-rhythm checks.
 *
 * The rhythm signal is about how someone is typing **now**. A burst of machine-fast
 * input an hour ago should not keep flagging a session that has been typing normally
 * since, and scanning the whole history to decide was also what made ingest cost grow
 * with session length. 500 keystrokes is well over a minute of ordinary typing.
 */
export const MAX_KEYSTROKE_DELTAS = 500;

/**
 * Trims an array to its most recent `limit` entries, in place.
 *
 * **Amortised O(1)**, not O(n) per push: the array is allowed to grow to `2 * limit`
 * before being trimmed back to `limit`. Trimming on every push would make each push
 * O(limit), which is a constant but a wasteful one, and would reintroduce a per-event
 * cost proportional to the window size — the same shape of problem this exists to
 * remove.
 *
 * Mutates in place so the array identity is stable for any caller holding a
 * reference.
 */
export function trimToWindow<T>(items: T[], limit: number): void {
  if (items.length <= limit * 2) return;
  items.splice(0, items.length - limit);
}

/** Mutates session state in place for a single micro-event. */
export function applyEventToSession(session: SessionState, event: MicroEvent): void {
  session.events.push(event);
  trimToWindow(session.events, MAX_IN_MEMORY_EVENTS);

  switch (event.eventType) {
    case "KEYSTROKE":
      if (event.payload.deltaMs !== undefined) {
        session.keystrokeDeltas.push(event.payload.deltaMs);
        trimToWindow(session.keystrokeDeltas, MAX_KEYSTROKE_DELTAS);
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
        trimToWindow(session.keystrokeDeltas, MAX_KEYSTROKE_DELTAS);
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

  // A loop, not `Math.max(...deltas)`: spreading a large array passes one argument
  // per element and throws `RangeError: Maximum call stack size exceeded` somewhere
  // around 100 000 entries. The window above keeps arrays far below that, but a
  // limit that depends on a different module's constant is not a limit.
  let max = -Infinity;
  let min = Infinity;
  let sum = 0;

  for (const delta of deltas) {
    if (delta > max) max = delta;
    if (delta < min) min = delta;
    sum += delta;
  }

  return { avgDeltaMs: sum / deltas.length, maxDeltaMs: max, minDeltaMs: min };
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
 * Re-exported from `../services/session-status.js`, which owns the vocabulary so the
 * transition boundary can import it without importing a route module. Kept exported
 * here because existing importers and tests resolve it from this module.
 */
export {
  PERSISTED_SESSION_STATUSES,
  type PersistedSessionStatus,
  normalizeStatus,
  isMonitored,
} from "../services/session-status.js";

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
 * Loads the operator-managed reference corpus for similarity comparison.
 *
 * The corpus is read in full on every analysis. That is one bounded MCP call
 * against a local database, alongside the two or three the analysis path already
 * makes, and it avoids a cache whose staleness would be invisible to the
 * operator who just edited the corpus.
 *
 * A failure returns an empty corpus rather than failing the analysis: similarity
 * matching is one signal among several, and losing it must not lose the
 * telemetry or the risk score. The failure is logged.
 */

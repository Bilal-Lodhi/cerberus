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
 *   1. durable assessment identity — `risk_assessments` carries a unique index on
 *      `riskAssessmentId`, so re-analysing one incident stores one row
 *   2. code-hash equality — skip re-analysis when the workspace is unchanged
 *   3. micro-event fingerprint ring (last 128) — suppress replayed batches
 *   4. behavioural counter blend — repeated violations amplify the score
 *
 * Layer 1 was described here before it existed: nothing compared `riskAssessmentId`
 * and there was no unique index on it, so a retry after a restart wrote a second
 * assessment row for one incident. The claim was removed when that was found, and is
 * restored now that the durable identity is real — migration 0002 removes any
 * pre-existing duplicates and `MongoStore.storeRiskAssessment` is idempotent on the
 * id. Layers 2, 3 and 4 are unchanged.
 */

import { Hono } from "hono";
import { createHash } from "node:crypto";
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
  SESSION_DELETION_CODES,
  SESSION_TRANSITION_CODES,
  type DurableSessionStatus,
} from "../services/session-status.js";
import {
  readDurableCounter,
  readDurableSessionView,
  readDurableString,
  readFocusLossCount,
  type DurableSessionView,
} from "../services/session-read-model.js";
import {
  reconcileLiveDetail,
  reconcileLiveList,
  type LocalLiveDetail,
  type LocalLiveSession,
} from "../services/session-reconciliation.js";
import {
  findSimilarityMatches,
  type ReferenceDocument,
} from "../services/text-similarity.js";
import { toISOStringLocal, formatLocalTime } from "../utils/time.js";
import { LOG_EVENTS, logger } from "../observability/logger.js";
import { currentRequestId } from "../observability/request-context.js";

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
  focusLossCount: number;
  copyAttemptCount: number;
  lastRiskPayload: RiskAssessmentPayload | null;
  /**
   * Whether {@link lastRiskPayload} is durable — that is, whether the write that
   * produced it succeeded.
   *
   * In-memory only, and deliberately so: it exists to stop the code-hash dedup branch
   * from reporting a stored assessment for one whose write failed. It is not a durable
   * field and losing it on restart costs nothing, because after a restart the payload
   * is empty too.
   */
  lastRiskPayloadStored?: boolean;
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
  /**
   * Writes a status onto whichever cached entries already exist.
   *
   * One writer for both the transition boundary's repair and the read path's reconciliation,
   * so the two cannot drift about *how* a cached status is written. They differ in one
   * argument, and the difference is load-bearing:
   *
   *   - `at` — the activity instant to stamp, or `null` to leave the cached one alone. A
   *     transition has an instant (the session was just acted on). A read does **not**: a
   *     status repair that also moved `lastActivityAt` forward would extend a session's
   *     monitoring window as a side effect of looking at it, which is the bypass the TTL
   *     exists to prevent.
   *   - `seed` — whether to rebuild a missing registry entry from the durable document.
   *     Reactivation needs that after a restart, when the process holds nothing. A read does
   *     not: a durable-only session is served from the document on every read, and copying it
   *     into this process's registry would grow memory with sessions the process does not
   *     otherwise hold.
   */
  function writeCachedStatus(
    sessionId: string,
    status: DurableSessionStatus,
    at: string | null,
    durable: Record<string, unknown>,
    seed: boolean,
  ): void {
    const state = sessionStore.get(sessionId);
    if (state) {
      state.status = status;
      if (at !== null) state.lastActivityAt = at;
      sessionStore.set(sessionId, state);
    }

    const active = activeSessions.get(sessionId);
    if (active) {
      if (!isMonitored(status)) {
        // A session that is no longer monitored must not stay in the live registry, or the
        // next read has to filter it out again. `evict` does this too; doing it here means
        // the registry cannot hold a terminal status even for the instant between them.
        activeSessions.delete(sessionId);
        return;
      }
      active.status = status as ActiveSession["status"];
      if (at !== null) active.lastActivityAt = at;
      activeSessions.set(sessionId, active);
      return;
    }

    // No registry entry. Only a caller that asked to seed gets one, and never for a status
    // that is not monitored: a terminated session must never re-enter the live registry, or
    // a restart would resurrect it as actively monitored.
    if (!seed || !isMonitored(status)) return;

    const matrixId = String(durable["matrixId"] ?? durable["auditId"] ?? "");
    activeSessions.set(sessionId, {
      sessionId,
      employeeId: String(durable["employeeId"] ?? state?.employeeId ?? "unknown"),
      matrixId,
      targetSystem: String(durable["targetSystem"] ?? ""),
      status: status as ActiveSession["status"],
      deployedAt: String(durable["deployedAt"] ?? durable["createdAt"] ?? at ?? ""),
      riskIndex: Number(
        durable["peakRiskScore"] ?? durable["overallRiskScore"] ?? durable["riskIndex"] ?? 0,
      ),
      ...(at !== null ? { lastActivityAt: at } : {}),
    });
  }

  const transitionCache: SessionTransitionCache = {
    read(sessionId) {
      const active = activeSessions.get(sessionId);
      if (active) return normalizeStatus(active.status);
      const state = sessionStore.get(sessionId);
      return state ? normalizeStatus(state.status) : null;
    },

    apply(sessionId, status, at, durable) {
      writeCachedStatus(sessionId, status, at, durable, true);
    },

    evict(sessionId) {
      // Only the live registry: `sessionStore` keeps the session so its counters and
      // reconstructed state remain readable for review.
      activeSessions.delete(sessionId);
    },

    reconcileStatus(sessionId, status, durable) {
      // `at: null` — a read must not move the activity instant. `seed: false` — a
      // durable-only session stays in the document.
      writeCachedStatus(sessionId, status, null, durable, false);
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
    const requestId = currentRequestId();

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
        {
          success: false,
          error: "Request body must be a valid JSON object",
          correlationId: currentRequestId(),
        },
        400,
      );
    }

    if (!Array.isArray(body.events) || body.events.length === 0) {
      return c.json(
        {
          success: false,
          error: "Field 'events' must be a non-empty array",
          correlationId: currentRequestId(),
        },
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
        {
          success: false,
          error: "Each event must contain a sessionId",
          correlationId: currentRequestId(),
        },
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
    /**
     * Whether the store answered for the events write.
     *
     * `callMcpTool` never throws, so a failed `ingest_micro_events` produces no
     * accepted-set report. That absence is the signal: with no report, the counts
     * cannot be stated, and the response says so instead of reporting the batch size
     * as accepted.
     */
    let telemetryPersisted = false;
    /** Whether the assessment in this response is durable. Undefined when none ran. */
    let assessmentPersisted: boolean | undefined;

    try {
      // 1. Resolve the durable session document, creating it when absent.
      const durableSession = await ensureMongoSession(sessionId, primaryEvent, requestId);

      // 2. Refuse telemetry for a session whose monitoring window has closed.
      //    Extending a monitoring window is an explicit operator act
      //    (`POST /sessions/:sessionId/reactivate`), never a side effect of
      //    continuing to emit events — otherwise the TTL would bound nothing.
      if (sessionLiveness(sessionId, durableSession) === "expired") {
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

      // The store answered *and* reported an accepted set. Both are required: a
      // success envelope without the report would leave the counts unstated, and
      // `acceptedSet` is what decides which events are applied below.
      telemetryPersisted = persisted.ok && Array.isArray(acceptedIds);

      if (duplicateIds && duplicateIds.length > 0) {
        logger.debug(LOG_EVENTS.GUARDIAN_INGEST_DUPLICATES, {
          sessionId,
          duplicateCount: duplicateIds.length,
          processedCount,
        });
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
          {
            success: false,
            error: `Session ${sessionId} not found after processing`,
            code: SESSION_TRANSITION_CODES.SESSION_NOT_FOUND,
            correlationId: currentRequestId(),
          },
          404,
        );
      }

      // 5. Update durable aggregate counters.
      await writeDurableCounters(session, requestId);

      // 6. Decide whether this batch warrants AI analysis.
      const hasLargePaste = body.events.some(
        (event) => event.eventType === "PASTE" && (event.payload.changeLength ?? 0) >= 100,
      );
      const shouldAnalyze =
        hasLargePaste ||
        session.pasteCount > config.security.maxPasteEventsPerSession ||
        session.tabSwitchCount > 3 ||
        session.focusLossCount > 0 ||
        session.copyAttemptCount > 2 ||
        hasAnomalousKeystrokes(session.keystrokeDeltas, config);

      if (shouldAnalyze && session.currentCode.length > 50) {
        // ── Dedup layer 2: skip inference when the workspace is unchanged ──
        const codeHash = createHash("sha256")
          .update(session.currentCode, "utf-8")
          .digest("hex");

        if (codeHash === session.lastAnalyzedCodeHash) {
          const cached = session.lastRiskPayload;
          logger.debug(LOG_EVENTS.GUARDIAN_INGEST_CODE_UNCHANGED, {
            sessionId,
            codeHashPrefix: codeHash.slice(0, 12),
          });
          return c.json(
            {
              success: true,
              processedCount,
              // Same report shape as the main path, so a caller does not have to know
              // which branch answered.
              ...(telemetryPersisted
                ? {
                    acceptedCount: acceptedIds?.length ?? 0,
                    duplicateCount: duplicateIds?.length ?? 0,
                  }
                : {}),
              telemetryPersisted,
              // The reused payload is durable only if the write that produced it
              // succeeded. This is what `lastRiskPayloadStored` is for: without it,
              // this branch would claim a stored assessment for one whose write failed.
              assessmentPersisted: session.lastRiskPayloadStored === true,
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
          // The score, the flag count and the latency: what an operator needs to
          // correlate a paid attempt with its cost and outcome. Never the prompt,
          // the workspace or the paste content.
          logger.info(LOG_EVENTS.GUARDIAN_ANALYSIS_COMPLETE, {
            sessionId,
            latencyMs: Date.now() - analysisStartMs,
            riskScore: riskPayload.overallRiskScore,
            flagCount: riskPayload.flags.length,
            referenceDocumentCount: referenceCorpus.length,
            dependency: "provider",
          });

          // ── Dedup layer 4: blend the semantic score with behavioural counters ──
          const semanticScore = riskPayload.overallRiskScore;
          const pastePenalty = Math.min(session.pasteCount * 5, 30);
          const tabPenalty = Math.min(session.tabSwitchCount * 4, 16);
          const copyPenalty = Math.min(session.copyAttemptCount * 6, 18);
          const focusLossPenalty = session.focusLossCount > 0 ? 10 : 0;
          const keystrokePenalty = hasAnomalousKeystrokes(
            session.keystrokeDeltas,
            config,
          )
            ? 12
            : 0;

          const behaviouralBoost =
            pastePenalty + tabPenalty + copyPenalty + focusLossPenalty + keystrokePenalty;

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
            logger.info(LOG_EVENTS.GUARDIAN_SIMILARITY_MATCHES, {
              sessionId,
              matchCount: similarity.matches.length,
              bestSimilarity: Number(similarity.overallSimilarity.toFixed(3)),
              threshold: config.security.dataLeakageSimilarityThreshold,
            });
          }

          riskPayload.behavioralContext = {
            totalPasteEvents: session.pasteCount,
            totalFocusBreaches: session.tabSwitchCount + session.focusLossCount,
            totalCopyAttempts: session.copyAttemptCount,
            totalDevToolsOpens: session.events.filter(
              (event) => event.eventType === "DEVELOPER_TOOLS_OPEN",
            ).length,
            totalFocusLosses: session.focusLossCount,
            // Deprecated alias for 	otalFocusLosses, kept because this payload is persisted and
            // read back by review surfaces that may predate the rename. Same value.
            totalFullscreenExits: session.focusLossCount,
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

          alertTriggered = riskPayload.overallRiskScore > 50;

          // ── Paid recommendation, when the score warrants one ──
          //
          // This is the second paid call, and its result is part of the payload that
          // gets persisted, so it must run *before* the assessment write rather than
          // after it.
          const shouldLock = riskPayload.overallRiskScore >= AUTO_LOCK_THRESHOLD;
          const shouldClear = riskPayload.overallRiskScore < AUTO_CLEAR_THRESHOLD;

          if (shouldLock) {
            riskPayload.recommendedActions =
              await getAIProvider(config).recommendIncidentActions(riskPayload);
          }

          session.lastRiskPayload = riskPayload;
          sessionStore.set(sessionId, session);

          // ── 1. Persist the durable evidence ──────────────────────────────
          //
          // The assessment is the only durable artefact of the paid path, so it is
          // written **first**. The order used to be: notification → status → assessment,
          // which meant a process death in that window left a durably `locked` session
          // with a delivered alert and **no recorded justification** — a lock whose
          // evidence was never written.
          const stored = await callMcpTool(
            config,
            MCP_TOOL_NAMES.STORE_RISK_ASSESSMENT,
            { report: riskPayload },
            { requestId, timeoutMs: MCP_TIMEOUT_MS },
          );

          // `lastRiskPayloadStored` is what makes the code-hash dedup branch below
          // truthful: it returns the cached payload, and this flag says whether that
          // payload is durable. Without it, the branch could report a stored assessment
          // for one whose write had failed.
          session.lastRiskPayloadStored = stored.ok;
          assessmentPersisted = stored.ok;

          if (stored.ok) {
            // ── The durable peak, written now that there is evidence for it ──
            //
            // The counters write at step 5 runs **before** the analysis, so the
            // `peakRiskScore` it wrote was the previous batch's. Two consequences were
            // observable: the durable peak lagged by one batch, and for a session whose
            // last batch produced the highest score it never recorded that score at all.
            // The review surfaces and the live list's restart recovery both read this
            // field, so the lag showed up as the surfaces disagreeing about the same
            // session — and as `alertTriggered: false` after a restart for a session that
            // scored 98.
            //
            // Written only when the assessment is durable, so the durable peak never
            // exceeds the durable evidence for it.
            await writeDurableCounters(session, requestId);
          }

          if (!stored.ok) {
            // No durable evidence means no status change and no alert. Locking a
            // session whose justification was never recorded is the failure this
            // ordering exists to prevent, and a notification would describe an
            // incident with no review record. The telemetry is already durable, so the
            // next batch with a changed workspace retries the whole path.
            logger.error(LOG_EVENTS.GUARDIAN_ASSESSMENT_NOT_PERSISTED, {
              sessionId,
              dependency: "mcp",
              classification: "write-failed",
              reason: stored.error ?? "unknown",
            });
          } else {
            // ── 2. The status transition, on durable evidence ──────────────
            if (shouldLock) {
              await lockSession(sessionId, riskPayload, requestId);
            } else if (shouldClear) {
              // The boundary reads the durable status, so this no longer depends on
              // the cache having an entry for the session.
              await unlockSession(sessionId, requestId);
            }

            // ── 3. Optional side effects last ──────────────────────────────
            //
            // Both are best-effort and swallow their own failures, so a notification
            // outage cannot affect the durable state that now exists. They run after
            // the lock so an alert describes a state that is already recorded.
            if (shouldLock) {
              await Promise.all([
                notifySlack(notifySlackWebhook, riskPayload),
                sendEmail(sendgridKey, emailFrom, emailTo, riskPayload),
              ]);
            }
          }
        } catch (analysisError) {
          // Analysis failure is non-fatal: telemetry is already persisted. The event
          // name says *analysis* because that is what this catch covers — a persistence
          // failure inside it is reported by the branch above, with its own name.
          logger.failure(LOG_EVENTS.GUARDIAN_ANALYSIS_FAILURE, analysisError, {
            sessionId,
            dependency: "provider",
          });
        }
      }

      const response: IngestMicroEventResponse = {
        success: true,
        processedCount,
        // `processedCount` always keeps its meaning: the batch size. The two counts
        // below are reported **only when the store answered**, because a number we
        // know is unverified is worse than no number. Before this, a failed
        // `ingest_micro_events` produced `acceptedCount: <batch size>` and
        // `duplicateCount: 0` — indistinguishable from a fully successful ingest.
        ...(telemetryPersisted
          ? {
              acceptedCount: acceptedIds?.length ?? 0,
              duplicateCount: duplicateIds?.length ?? 0,
            }
          : {}),
        telemetryPersisted,
        // Whether the payload in this response is durable. Absent when no analysis
        // ran, because then the question does not apply.
        ...(assessmentPersisted !== undefined ? { assessmentPersisted } : {}),
        riskPayload,
        alertTriggered,
        anomalyRiskIndex: riskPayload?.overallRiskScore ?? 0,
      };
      return c.json(response, 200);
    } catch (error) {
      logger.failure(LOG_EVENTS.GUARDIAN_INGEST_FAILURE, error, { sessionId });
      return c.json(
        { success: false, error: "Telemetry ingestion failed.", correlationId: requestId },
        500,
      );
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /sessions/:sessionId
  // ═══════════════════════════════════════════════════════════════

  /**
   * Session detail, with a durable fallback.
   *
   * ── Why this route needed one ─────────────────────────────────────────
   *
   * This route read the two in-memory maps only. Immediately after a restart it
   * therefore answered `404` for a session that exists durably, and it kept doing so
   * until `GET /api/v1/guardian/sessions` was called — because that was the only path
   * that rebuilt the registry from MongoDB. One session was `404` on this surface and
   * `200` on the review surface, from the same process, at the same instant. Recorded
   * as open item D4 in `docs/development/state-transition-model.md`.
   *
   * ── The read model, in priority order ─────────────────────────────────
   *
   *   1. **`sessionStore`** — this process ingested events for the session, so it holds
   *      the authoritative hydrated counters *and* the reconstructed workspace. Served
   *      with no persistence call, so the hot path pays nothing for this fix.
   *   2. **The durable document** — the authority for every durable field. Also
   *      consulted when the registry holds the session but `sessionStore` does not, which
   *      is what makes this route agree with the live list about counters: the registry
   *      entry carries no counters at all, so a session deployed before a restart used to
   *      report `eventCount: 0` here while the live list reported the durable total.
   *   3. **The registry alone** — a session deployed by this process whose durable
   *      document does not exist (`mongoDocumentId: "local-only"`) or cannot be read. A
   *      legitimate source for registry-owned facts, and the only one that can answer.
   *
   * ── What a durable answer does and does not claim ─────────────────────
   *
   * The response carries `source` — `"memory"` or `"durable"` — and
   * `ephemeralStateAvailable`, which is `true` only when this process holds the
   * ephemeral state: the reconstructed workspace and the latest risk payload. A durable
   * answer reports those as empty and `null` rather than inventing them, and the two
   * flags say so. The numeric risk scores **are** durable and are reported.
   */
  /**
   * This process's view of one session's detail, as the reconciler's input.
   *
   * `null` when this process holds nothing for the session. The two maps contribute
   * different things: `sessionStore` holds the counters, the reconstructed workspace and the
   * latest payload; the registry holds identity, the deployment instant and the status the
   * transition boundary last wrote.
   */
  function localLiveDetail(
    sessionId: string,
    session: SessionState | undefined,
    active: ActiveSession | undefined,
  ): LocalLiveDetail | null {
    if (!session && !active) return null;

    return {
      sessionId,
      employeeId: session?.employeeId || active?.employeeId || "unknown",
      matrixId: session?.auditId || active?.matrixId || "",
      targetSystem: active?.targetSystem ?? "",
      // The registry, when it holds the session, is what the transition boundary last wrote
      // from the durable outcome.
      status: active?.status ?? session?.status ?? "active",
      deployedAt: active?.deployedAt ?? session?.events[0]?.timestamp ?? toISOStringLocal(),
      lastActivityAt:
        session?.lastActivityAt ?? active?.lastActivityAt ?? active?.deployedAt,
      // The score this process holds. The reconciler takes the larger of this and the durable
      // peak, so a payload this process has produced but not yet persisted is not discarded.
      riskIndex: session?.lastRiskPayload?.overallRiskScore ?? active?.riskIndex ?? 0,
      eventCount: session ? Math.max(session.events.length, session.eventCount) : 0,
      pasteCount: session?.pasteCount ?? 0,
      tabSwitchCount: session?.tabSwitchCount ?? 0,
      focusLossCount: session?.focusLossCount ?? 0,
      copyAttemptCount: session?.copyAttemptCount ?? 0,
      currentCode: session?.currentCode ?? "",
      lastRiskPayload: session?.lastRiskPayload ?? null,
      // The reconstructed workspace and the latest payload exist only in the process that
      // ingested the events. A registry-only session has neither.
      ephemeralStateAvailable: session !== undefined,
    };
  }

  guardianRouter.get("/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const requestId = currentRequestId();
    const session = sessionStore.get(sessionId);
    const activeSession = activeSessions.get(sessionId);

    // The durable document is read on **every** detail request, including when this process
    // holds the session. Gating that read on empty memory is what let a session another
    // process had terminated keep reading as `active` here while the review surfaces, which
    // read MongoDB, said `terminated` about the same session.
    //
    // One read, for the document only — `eventsLimit: 0, includeAssessments: false` — so the
    // detail costs one session document rather than a session's history.
    const durable = await readDurableSessionDocument(sessionId, requestId);

    // Durable wins for every durable-authoritative field; this process answers for the
    // workspace and the latest payload, and says so through `ephemeralStateAvailable`.
    const reconciliation = reconcileLiveDetail(
      localLiveDetail(sessionId, session, activeSession),
      durable,
      { ttlSeconds, nowMs: clock.now(), alertThreshold: AUTO_LOCK_THRESHOLD },
    );

    if (reconciliation) {
      // One-directional: a read may correct the cache, never the document.
      if (reconciliation.repair) {
        transitionCache.reconcileStatus(
          reconciliation.repair.sessionId,
          reconciliation.repair.status,
          reconciliation.repair.durable,
        );
      }

      if (durable.kind === "unavailable") {
        // This process's own record is served rather than refusing — answering is better
        // than a 503 for a session the process itself deployed or ingested — but the status
        // is labelled `process-local` rather than presented as durable truth.
        logger.warn(LOG_EVENTS.GUARDIAN_DETAIL_FALLBACK, {
          sessionId,
          source: reconciliation.session.source,
          dependency: "mcp",
          classification: "store-unavailable",
          claimed: "process-local status, labelled",
        });
      }

      return c.json({ success: true, session: reconciliation.session });
    }

    // Neither source holds the session, so which answer is right depends on **why**.
    if (durable.kind === "unavailable") {
      // Nothing can be claimed about whether the session exists, so nothing is. A `404` here
      // would assert something the process cannot verify — the wrong answer this route used
      // to give for an unreachable store.
      logger.error(LOG_EVENTS.GUARDIAN_DETAIL_FALLBACK, {
        sessionId,
        dependency: "mcp",
        classification: "store-unavailable",
        claimed: "nothing",
      });
      return c.json(
        {
          success: false,
          error:
            "The session could not be read because the persistence layer did not " +
            "answer. Its existence is unknown.",
          code: SESSION_TRANSITION_CODES.SESSION_STORE_UNAVAILABLE,
          sessionId,
          correlationId: requestId,
        },
        503,
      );
    }

    return c.json(
      {
        success: false,
        error: `Session '${sessionId}' not found`,
        // One condition, one code, across every surface that can report it.
        code: SESSION_TRANSITION_CODES.SESSION_NOT_FOUND,
        sessionId,
        correlationId: requestId,
      },
      404,
    );
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /deploy
  // ═══════════════════════════════════════════════════════════════

  guardianRouter.post("/deploy", async (c) => {
    const requestId = currentRequestId();

    let body: DeploySessionRequest;
    try {
      body = await c.req.json<DeploySessionRequest>();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body", correlationId: requestId }, 400);
    }

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json(
        {
          success: false,
          error: "Request body must be a valid JSON object",
          correlationId: currentRequestId(),
        },
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

      logger.info(LOG_EVENTS.GUARDIAN_DEPLOY_COMPLETE, {
        sessionId,
        durable: mongoDocumentId !== "local-only",
        registrySize: activeSessions.size,
      });

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
      logger.failure(LOG_EVENTS.GUARDIAN_DEPLOY_FAILURE, error, { sessionId });
      return c.json(
        { success: false, error: "Failed to deploy session.", correlationId: requestId },
        500,
      );
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /sessions
  // ═══════════════════════════════════════════════════════════════

  /**
   * This process's view of its live sessions, as rows the reconciler can merge.
   *
   * The two maps overlap: a session that has ingested telemetry is in `sessionStore`, a
   * session that was deployed is in `activeSessions`, and a session that was deployed *and*
   * has ingested is in both. `sessionStore` is the source for counters — it holds the
   * hydrated lifetime totals — and the registry is the source for identity, the deployment
   * instant and the status the transition boundary last wrote.
   *
   * Nothing is filtered here. Expiry and the `isMonitored` rule are applied **once**, by the
   * reconciler, over both sources, so the two cannot disagree about the same session. That
   * disagreement is what the three separate paths in this route used to produce.
   */
  function localLiveSessions(): LocalLiveSession[] {
    const rows = new Map<string, LocalLiveSession>();

    for (const [sessionId, state] of sessionStore) {
      const active = activeSessions.get(sessionId);
      rows.set(sessionId, {
        sessionId,
        employeeId: state.employeeId || active?.employeeId || "unknown",
        matrixId: state.auditId || active?.matrixId || "",
        targetSystem: active?.targetSystem ?? "",
        // The registry, when it holds the session, is what the transition boundary last
        // wrote from the durable outcome. When it does not, `sessionStore` is the only
        // in-memory source and its status came from the same place.
        status: active?.status ?? state.status ?? "active",
        deployedAt: active?.deployedAt ?? state.events[0]?.timestamp ?? toISOStringLocal(),
        lastActivityAt:
          state.lastActivityAt ?? active?.lastActivityAt ?? active?.deployedAt,
        // The reconstructed workspace and the latest payload are what this process can
        // answer, which is what `ephemeralStateAvailable` reports. The risk *score* is not
        // taken from here: the reconciler prefers the durable `peakRiskScore`, and takes the
        // larger of the two so a payload this process holds but has not yet persisted is not
        // discarded.
        riskIndex: state.lastRiskPayload?.overallRiskScore ?? 0,
        eventCount: Math.max(state.events.length, state.eventCount),
        pasteCount: state.pasteCount,
        tabSwitchCount: state.tabSwitchCount,
        focusLossCount: state.focusLossCount,
        copyAttemptCount: state.copyAttemptCount,
        ephemeralStateAvailable: true,
      });
    }

    for (const [sessionId, active] of activeSessions) {
      if (rows.has(sessionId)) continue;
      rows.set(sessionId, {
        sessionId,
        employeeId: active.employeeId || "unknown",
        matrixId: active.matrixId,
        targetSystem: active.targetSystem,
        status: active.status,
        deployedAt: active.deployedAt,
        lastActivityAt: active.lastActivityAt ?? active.deployedAt,
        riskIndex: active.riskIndex,
        eventCount: 0,
        pasteCount: 0,
        tabSwitchCount: 0,
        focusLossCount: 0,
        copyAttemptCount: 0,
        // The registry is this process's deployment record and holds no workspace and no
        // payload. Reporting zero counters here is truthful *for this process*; the
        // reconciler replaces them with the durable totals where a document exists.
        ephemeralStateAvailable: false,
      });
    }

    return Array.from(rows.values());
  }

  guardianRouter.get("/sessions", async (c) => {
    const requestId = currentRequestId();
    const nowMs = clock.now();

    // ── 1. This process's view, before reconciliation ────────────────
    const local = localLiveSessions();

    // ── 2. ONE durable query for the whole page — always ─────────────
    //
    // This used to run only when local memory was empty, and that single condition is what
    // made the live list process-local-authoritative: a session another process terminated
    // stayed "active" here until its TTL elapsed, a transition happened to run through this
    // process, or the process restarted — and a session another process deployed was missing
    // from the page entirely.
    //
    // It is one query for the whole page, not one per session, so the list cannot acquire an
    // N+1 as the session count grows. See `docs/development/live-read-consistency.md` §3.
    const listed = await callMcpTool<{
      success?: boolean;
      data?: Array<Record<string, unknown>>;
    }>(config, MCP_TOOL_NAMES.LIST_SESSIONS, {}, { requestId, timeoutMs: MCP_TIMEOUT_MS });

    // `null` is "the store did not answer", which is a different fact from "there are no
    // sessions". Collapsing the two is what made an unreachable store return an empty live
    // list with `success: true`.
    const durableDocuments =
      listed.ok && listed.data?.success && Array.isArray(listed.data.data)
        ? listed.data.data
        : null;

    // ── 3. Merge: durable wins where it answers ──────────────────────
    const reconciliation = reconcileLiveList(local, durableDocuments, {
      ttlSeconds,
      nowMs,
      alertThreshold: AUTO_LOCK_THRESHOLD,
    });

    // ── 4. Repair this process's cache toward the document ───────────
    //
    // One-directional on purpose: a read may correct the cache, never the document. A
    // `terminated` repair also evicts from the live registry, so the next read does not have
    // to rediscover the same divergence.
    for (const repair of reconciliation.repairs) {
      transitionCache.reconcileStatus(repair.sessionId, repair.status, repair.durable);
    }

    if (durableDocuments === null) {
      // The statuses in this response are this process's own. The response says so rather
      // than presenting them as durable truth, because refusing outright would take the live
      // dashboard down during a store blip — a worse failure than a labelled stale value.
      logger.warn(LOG_EVENTS.GUARDIAN_LIVE_LIST_UNRECONCILED, {
        requestId,
        dependency: "mcp",
        classification: "store-unavailable",
        localSessionCount: local.length,
        claimed: "process-local status, labelled",
      });
    } else if (reconciliation.dropped.length > 0 || reconciliation.repairs.length > 0) {
      logger.debug(LOG_EVENTS.GUARDIAN_LIVE_LIST_RECONCILED, {
        requestId,
        localSessionCount: local.length,
        listedSessionCount: reconciliation.sessions.length,
        droppedNotLive: reconciliation.dropped.length,
        addedFromDurable: reconciliation.addedFromDurable.length,
        statusCorrected: reconciliation.repairs.length,
      });
    }

    return c.json({
      success: true,
      data: reconciliation.sessions,
      // Additive. A client that needs durable truth can require this to be true; a client
      // that does not is unaffected.
      reconciled: reconciliation.reconciled,
    });
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
    const requestId = currentRequestId();

    const result = await transitions.reactivate(sessionId, requestId);
    if (!result.ok) {
      const { body, status } = refusalResponse(result);
      return c.json({ ...body, correlationId: requestId }, status);
    }

    const reactivatedAt = toISOStringLocal(new Date(clock.now()));

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
    const requestId = currentRequestId();

    // ── The order is the ownership rule ───────────────────────────────
    //
    // Read the workspace **while the session is still live** — "terminal content" means the
    // workspace as it was when monitoring stopped, so it must be read before monitoring stops.
    // But the **write** happens after the transition, and that is the whole point: the
    // transition is the atomic claim on the session, and the process whose claim applied is the
    // one that owns the field.
    //
    // Before this, the content was written first and unconditionally, so two processes
    // terminating the same session both wrote and the last writer won — with whichever process
    // happened to hold the *staler* reconstruction of the workspace. The field is one fact and
    // it had no single owner.
    //
    // Reading is best-effort and non-fatal: a failure must not stop an operator ending
    // monitoring. The review path still falls back to the newest assessment's `codeSnapshot`,
    // which is a *different* fact — the workspace when that assessment ran — but better than an
    // empty panel.
    const inMemoryCode = sessionStore.get(sessionId)?.currentCode;
    let workspace: string | null = null;
    try {
      workspace = await transitions.workspaceToPreserve(sessionId, inMemoryCode, requestId);
    } catch (error) {
      logger.failure(LOG_EVENTS.GUARDIAN_TERMINAL_CONTENT, error, {
        sessionId,
        preserved: false,
      });
    }

    // The claim. A concurrent terminate that loses this predicate reports `SESSION_CONFLICT`
    // and never reaches the content write below.
    const result = await transitions.terminate(sessionId, requestId);
    if (!result.ok) {
      const { body, status } = refusalResponse(result);
      return c.json({ ...body, correlationId: requestId }, status);
    }

    if (workspace) {
      try {
        // `applied` means this process moved the document to `terminated`, so it owns the
        // field: the write is gated on the status the transition produced. A terminate that
        // found the session **already** terminated did not claim it, so it may only repair —
        // `onlyIfAbsent` writes when the document holds no content, which is the case where the
        // winning process died between its transition and its write. It never overwrites a
        // workspace another process preserved.
        const preserved = await transitions.updateTerminalContent(
          sessionId,
          workspace,
          requestId,
          result.applied
            ? { expectedStatuses: ["terminated"] }
            : { expectedStatuses: ["terminated"], onlyIfAbsent: true },
        );

        if (!preserved.ok) {
          logger.warn(LOG_EVENTS.GUARDIAN_TERMINAL_CONTENT, {
            sessionId,
            preserved: false,
            errorCode: preserved.code,
          });
        } else if (!preserved.applied) {
          // Not a failure: either this process lost the claim and the field is already owned,
          // or the session holds content from the process that won. Logged at debug so the
          // distinction is visible without making a normal race look like an incident.
          logger.debug(LOG_EVENTS.GUARDIAN_TERMINAL_CONTENT, {
            sessionId,
            preserved: false,
            reason: "not-the-owner",
          });
        }
      } catch (error) {
        logger.failure(LOG_EVENTS.GUARDIAN_TERMINAL_CONTENT, error, {
          sessionId,
          preserved: false,
        });
      }
    }

    // `endedAt` is display state derived from the transition instant; it is not part
    // of the durable status, and `status: "terminated"` is the durable signal.
    const state = sessionStore.get(sessionId);
    if (state) {
      state.endedAt = toISOStringLocal(new Date(clock.now()));
    }

    return c.json({ success: true, sessionId, message: "Session terminated (data preserved)" });
  });

  // ═══════════════════════════════════════════════════════════════
  // DELETE /sessions/:sessionId  — permanent deletion
  // ═══════════════════════════════════════════════════════════════

  /**
   * Permanently deletes a session and every document derived from it.
   *
   * ── The order ─────────────────────────────────────────────────────────
   *
   * The durable deletion is attempted **first** and its answer decides the response.
   * Previously the caches were cleared first and the durable result was only consulted to
   * compute `deleted`, so an unreachable store produced `200 success: true` for a session
   * that was still there — and a restart brought it back. It also produced `404 "not
   * found"` for a session that exists, which is a different wrong answer to the same
   * failure.
   *
   * ── The report ────────────────────────────────────────────────────────
   *
   * A deletion cascades over three domain components — the session record, its telemetry
   * and its assessments — and it can **partly** succeed. That is a different fact from
   * "the store did not answer", and the two used to be indistinguishable: the tool
   * reported only the session document's count, so a failed telemetry removal was
   * reported as a complete deletion.
   *
   * The response now names what was removed per component and what was not. A partial
   * deletion is `500 PARTIAL_DELETE` with `retrySafe: true`; an unreachable store is
   * `503 SESSION_STORE_UNAVAILABLE` with nothing attempted. A client that treated the two
   * alike would either retry an operation that never ran, or fail to retry one that
   * half-ran.
   *
   * ── Retry semantics ───────────────────────────────────────────────────
   *
   * Retrying is **safe and is the remedy**. The store removes the derived documents first
   * and the session record last, so a partial failure leaves the session identifiable and
   * nothing orphaned: a retry removes whatever remains and completes. Successful
   * component removals are never undone or re-reported — the second attempt simply
   * reports `0` for them.
   *
   * ── Nonexistent sessions ──────────────────────────────────────────────
   *
   * A delete that removed nothing durable and found nothing in memory is `404`. A delete
   * that removed nothing durable but *did* find the session in memory is `200`: a session
   * that only ever existed in this process is deleted from the process's point of view.
   */
  guardianRouter.delete("/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const requestId = currentRequestId();

    const result = await callMcpTool<{
      deleted?: boolean;
      complete?: boolean;
      partial?: boolean;
      components?: Record<string, { deleted?: number }>;
      failedComponents?: string[];
    }>(config, MCP_TOOL_NAMES.DELETE_SESSION, { sessionId }, { requestId, timeoutMs: MCP_TIMEOUT_MS });

    if (!result.ok) {
      // Nothing can be claimed about the durable state, so nothing is claimed. The
      // caches are left alone: clearing them would hide the session from this process
      // while it is still durable, which is the divergence this ordering removes.
      logger.error(LOG_EVENTS.GUARDIAN_DELETE_FAILURE, {
        sessionId,
        dependency: "mcp",
        classification: "store-unavailable",
        reason: result.error ?? "unknown",
      });
      return c.json(
        {
          success: false,
          error:
            "The session could not be deleted because the persistence layer did not " +
            "answer. Nothing was changed.",
          code: SESSION_TRANSITION_CODES.SESSION_STORE_UNAVAILABLE,
          sessionId,
          correlationId: requestId,
        },
        503,
      );
    }

    const failedComponents = Array.isArray(result.data?.failedComponents)
      ? result.data!.failedComponents!.map(String)
      : [];
    const components = result.data?.components ?? {};

    // ── A partial deletion is reported as partial ──
    //
    // The caches are deliberately **not** cleared: the store leaves the session record in
    // place when a derived component failed, so this process's view of the session is
    // still the truth. Clearing them would hide a session that is still durable.
    if (failedComponents.length > 0) {
      logger.error(LOG_EVENTS.GUARDIAN_DELETE_PARTIAL, {
        sessionId,
        dependency: "mcp",
        classification: "partial",
        removedTelemetry: components["telemetry"]?.deleted ?? 0,
        removedAssessments: components["assessments"]?.deleted ?? 0,
        removedSession: components["session"]?.deleted ?? 0,
        failedComponents,
      });

      return c.json(
        {
          success: false,
          error:
            `The session was only partly deleted: ${failedComponents.join(", ")} ` +
            "could not be removed. Retrying the delete is safe and will finish the job.",
          code: SESSION_DELETION_CODES.PARTIAL_DELETE,
          sessionId,
          complete: false,
          partial: true,
          // Domain component names, never collection names: a collection rename must not
          // be a breaking change to this contract.
          components,
          failedComponents,
          retrySafe: true,
          correlationId: requestId,
        },
        500,
      );
    }

    // The durable delete completed, or matched nothing. Either way the caches must no
    // longer hold the session.
    const removedFromRegistry = activeSessions.delete(sessionId);
    const removedFromStore = sessionStore.delete(sessionId);
    const deletedDurably = result.data?.deleted === true;
    const removedDerived =
      (components["telemetry"]?.deleted ?? 0) + (components["assessments"]?.deleted ?? 0);

    if (!deletedDurably && !removedFromRegistry && !removedFromStore && removedDerived === 0) {
      return c.json(
        {
          success: false,
          error: `Session '${sessionId}' not found`,
          code: SESSION_TRANSITION_CODES.SESSION_NOT_FOUND,
          correlationId: requestId,
        },
        404,
      );
    }

    logger.info(LOG_EVENTS.GUARDIAN_DELETE_COMPLETE, {
      sessionId,
      durable: deletedDurably,
      removedFromRegistry,
      removedFromStore,
      removedTelemetry: components["telemetry"]?.deleted ?? 0,
      removedAssessments: components["assessments"]?.deleted ?? 0,
    });

    return c.json({
      success: true,
      sessionId,
      message: "Session permanently deleted",
      // The same shape a partial deletion reports, so a client reads one contract. A
      // successful delete is simply the one where nothing failed.
      complete: true,
      partial: false,
      components,
      failedComponents: [],
      // Whether the session record itself was removed. `false` means the session existed
      // only in this process, or only its derived documents remained.
      deletedDurably,
    });
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
      logger.warn(LOG_EVENTS.GUARDIAN_SESSION_CREATE_FAILED, {
        sessionId,
        dependency: "mcp",
        classification: "create-failed",
      });
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

  /**
   * Writes the durable aggregate counters from the current in-memory session state.
   *
   * Called twice on an analysed batch — before the analysis, so a batch that does not
   * trigger one still records its counters, and again after a **durable** assessment, so
   * the durable `peakRiskScore` is the score this batch produced rather than the previous
   * batch's. See the comment at the second call site.
   *
   * `eventCount` is the hydrated lifetime total, not `events.length`, which is only what
   * this process has seen since it started. `focusLossCount` is sent because it was once
   * omitted: MongoDB never learned it, and a restart reset it to 0, which silently
   * disabled the focus-loss analysis trigger and its score penalty.
   */
  async function writeDurableCounters(
    session: SessionState,
    requestId: string,
  ): Promise<void> {
    await callMcpTool(
      config,
      MCP_TOOL_NAMES.UPDATE_SESSION_COUNTS,
      {
        sessionId: session.sessionId,
        counts: {
          eventCount: session.eventCount,
          pasteCount: session.pasteCount,
          tabSwitchCount: session.tabSwitchCount,
          focusLossCount: session.focusLossCount,
          copyAttemptCount: session.copyAttemptCount,
          peakRiskScore: session.lastRiskPayload?.overallRiskScore ?? 0,
        },
      },
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );
  }

  /**
   * Reads the durable session document, distinguishing "absent" from "unreadable".
   *
   * The distinction is the whole point: `absent` means the store answered and no such
   * session exists, which is a `404`. `unavailable` means the store did not answer, and
   * nothing at all can be claimed — which is a `503`, not a `404`.
   */
  async function readDurableSessionDocument(
    sessionId: string,
    requestId: string,
  ): Promise<
    | { kind: "document"; view: DurableSessionView; document: Record<string, unknown> }
    | { kind: "absent" }
    | { kind: "unavailable" }
  > {
    const response = await callMcpTool<{
      success?: boolean;
      session?: Record<string, unknown> | null;
    }>(
      config,
      MCP_TOOL_NAMES.GET_SESSION_REVIEW,
      // The document only. Neither the events nor the assessments are used here, and
      // asking for them would make a detail read cost a session's whole history.
      { sessionId, eventsLimit: 0, includeAssessments: false },
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );

    if (!response.ok || !response.data?.success) return { kind: "unavailable" };

    const document = response.data.session ?? null;
    if (!document) return { kind: "absent" };

    // The raw document travels with the view so a read-path cache repair does not need a
    // second read: `reconcileStatus` seeds nothing, but the caller must be able to name the
    // durable value it is repairing toward.
    return {
      kind: "document",
      view: readDurableSessionView(document, sessionId),
      document,
    };
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
      focusLossCount: readFocusLossCount(durable),
      copyAttemptCount: readDurableCounter(durable, "copyAttemptCount"),
      lastRiskPayload: null,
      eventCount,
      status: normalizeStatus(String(durable["status"] ?? "active")),
      lastAnalyzedCodeHash: "",
      recentEventFingerprints: new Set(),
      lastActivityAt: readDurableString(durable, "updatedAt") ?? undefined,
    });

    logger.debug(LOG_EVENTS.GUARDIAN_SESSION_HYDRATED, {
      sessionId,
      eventCount,
      pasteCount,
    });
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
      logger.warn(LOG_EVENTS.GUARDIAN_CORPUS_UNAVAILABLE, {
        dependency: "mcp",
        classification: "read-failed",
        consequence: "similarity-matching-skipped",
      });
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
        focusLossCount: 0,
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
      logger.warn(LOG_EVENTS.SESSION_TRANSITION_REFUSED, {
        action: "autoLock",
        sessionId,
        errorCode: result.code,
        previousStatus: result.previousStatus ?? "unknown",
        riskScore: riskPayload.overallRiskScore,
      });
      return;
    }

    logger.info(LOG_EVENTS.SESSION_TRANSITION, {
      action: "autoLock",
      sessionId,
      status: result.status,
      previousStatus: result.previousStatus,
      applied: result.applied,
      riskScore: riskPayload.overallRiskScore,
    });
  }

  /** Auto-clears a locked session once its score falls below the clear threshold. */
  async function unlockSession(sessionId: string, requestId: string): Promise<void> {
    const result = await transitions.autoClear(sessionId, requestId);

    if (!result.ok) {
      logger.warn(LOG_EVENTS.SESSION_TRANSITION_REFUSED, {
        action: "autoClear",
        sessionId,
        errorCode: result.code,
        previousStatus: result.previousStatus ?? "unknown",
      });
      return;
    }

    logger.info(LOG_EVENTS.SESSION_TRANSITION, {
      action: "autoClear",
      sessionId,
      status: result.status,
      previousStatus: result.previousStatus,
      applied: result.applied,
    });
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
      session.focusLossCount++;
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
  LEGACY_DERIVED_SESSION_STATUSES,
  type PersistedSessionStatus,
  type LegacyDerivedSessionStatus,
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
  if (session.focusLossCount > 0) parts.push("focus lost");
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

/**
 * Route group: /api/v1/sessions
 *
 *   GET /            list sessions (union of durable MongoDB + live in-memory)
 *   GET /:sessionId  full review payload for the console split-panel view
 *
 * The in-memory store is authoritative for live counters; MongoDB is the
 * durable fallback after a restart. Both sources are merged by taking the
 * maximum observed value, so a restart never under-reports activity.
 *
 * These are the REVIEW surfaces. Unlike `GET /api/v1/guardian/sessions`, they
 * deliberately include sessions whose `SESSION_TTL_SECONDS` window has closed:
 * expiry stops monitoring, it never hides evidence. Each entry carries a
 * derived `liveness` field so a caller can tell the two apart.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { RiskAssessmentPayload, SessionReviewResponse, TimelineEntry } from "../types.js";
import { callMcpTool, MCP_TOOL_NAMES } from "../services/mcp-client.js";
import {
  resolveLiveness,
  systemClock,
  type Clock,
  type SessionActivity,
  type SessionLiveness,
} from "../services/session-liveness.js";
import { toISOStringLocal } from "../utils/time.js";
import type { ActiveSession, SessionState } from "./guardian.js";

const MCP_TIMEOUT_MS = 5_000;

type Severity = TimelineEntry["severity"];

/**
 * Reads a report's `generatedAt` as epoch milliseconds, or 0 when unusable.
 *
 * 0 rather than `NaN`: a `NaN` comparator makes `Array.prototype.sort` leave the
 * order unspecified, which is exactly the kind of silent non-determinism this
 * function exists to remove.
 */
function reportTimeMs(report: Record<string, unknown>): number {
  const parsed = Date.parse(String(report["generatedAt"] ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Orders risk assessments oldest-first.
 *
 * The persistence layer returns them **newest-first** (`generatedAt: -1` in
 * `MongoStore.getRiskAssessments`), but every consumer here wants "the latest" as
 * the last element. Sorting explicitly at the point of use means a change to the
 * store's projection, index or sort cannot silently reverse which assessment is
 * treated as final — which is what happened: the route read the *oldest* report as
 * `finalRiskScore`, and the in-process test stub's insertion order hid it.
 */
function sortReportsOldestFirst<T extends Record<string, unknown>>(reports: T[]): T[] {
  return [...reports].sort((a, b) => reportTimeMs(a) - reportTimeMs(b));
}

/** The first value that is a non-empty string, or `""`. */
function firstNonEmptyString(
  ...values: Array<string | null | undefined>
): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

export interface ReviewRouterOptions {
  /** Time source for TTL expiry. Defaults to the system clock. */
  clock?: Clock;
}

/**
 * Extracts the effective character count from a COPY_ATTEMPT payload.
 * Cascades through known field names so the timeline never reports
 * "0 characters copied" when at least one field is populated.
 */
export function extractCopyLength(
  payload: Record<string, unknown> | undefined,
): number {
  const copiedLength =
    typeof payload?.["copiedLength"] === "number"
      ? (payload["copiedLength"] as number)
      : undefined;
  const selectedTextLength =
    typeof payload?.["selectedTextLength"] === "number"
      ? (payload["selectedTextLength"] as number)
      : undefined;
  const copyContentLength =
    typeof payload?.["copyContent"] === "string"
      ? (payload["copyContent"] as string).length
      : undefined;
  const selectedTextLengthFallback =
    typeof payload?.["selectedText"] === "string"
      ? (payload["selectedText"] as string).length
      : undefined;

  return (
    copiedLength ??
    selectedTextLength ??
    copyContentLength ??
    selectedTextLengthFallback ??
    0
  );
}

/** Builds a human-readable timeline entry for a micro-event. */
export function buildTimelineEntry(event: {
  eventType?: string;
  timestamp: string;
  payload?: Record<string, unknown>;
}): TimelineEntry {
  const rawType = event.eventType ?? "";
  const payload = event.payload ?? {};

  let label = rawType
    ? rawType.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase())
    : "Unknown Event";
  let detail = JSON.stringify(payload);
  let severity: Severity = "info";

  switch (rawType) {
    case "KEYSTROKE":
      label = "Keystroke";
      detail = `Delta: ${payload["deltaMs"] ?? "N/A"}ms`;
      if (typeof payload["deltaMs"] === "number" && (payload["deltaMs"] as number) < 80) {
        severity = "warning";
      }
      break;
    case "PASTE_TRIGGER":
      label = "Paste Event";
      detail = `Content length: ${(payload["pasteContent"] as string)?.length ?? 0} chars`;
      severity = "critical";
      break;
    case "CODE_DELTA":
      label = "Code Change";
      detail = `Diff size: ${(payload["diffPatch"] as string)?.length ?? 0} chars`;
      severity = "info";
      break;
    case "TAB_SWITCH":
      label = "Tab Switch";
      detail = `Visibility: ${payload["visibilityState"] ?? "unknown"}`;
      severity = "warning";
      break;
    case "WINDOW_BLUR":
      label = "Window Blur";
      detail = "Operator left the monitored window";
      severity = "warning";
      break;
    case "COPY_ATTEMPT":
      label = "Copy Attempt";
      detail = `Selected: ${extractCopyLength(payload)} chars`;
      severity = "critical";
      break;
    case "DEVELOPER_TOOLS_OPEN":
      label = "Dev Tools Opened";
      detail = "Browser developer console activated";
      severity = "critical";
      break;
    case "FULLSCREEN_EXIT":
      label = "Fullscreen Exit";
      detail = "Operator exited fullscreen mode";
      severity = "critical";
      break;
    case "EXTERNAL_APP_SWITCH":
      label = "External App Switch";
      detail = "Focus moved to an application outside the monitored workspace";
      severity = "warning";
      break;
    case "SUBMIT":
      label = "Submission";
      detail = "Workspace snapshot submitted";
      severity = "info";
      break;
    case "EDIT":
      label = "Code Edit";
      detail = `Snapshot: ${(payload["newText"] as string)?.length ?? 0} chars`;
      severity = "info";
      break;
    case "PASTE":
      label = "Paste Detected";
      detail = `Inserted ${payload["changeLength"] ?? "?"} chars`;
      severity = "critical";
      break;
    default:
      break;
  }

  return { timestamp: event.timestamp, eventType: rawType, label, severity, detail };
}

export function createReviewRouter(
  config: AppConfig,
  sessionStore: Map<string, SessionState>,
  activeSessions: Map<string, ActiveSession>,
  options: ReviewRouterOptions = {},
): Hono {
  const reviewRouter = new Hono();

  /** Time source for every liveness decision in this router. */
  const clock: Clock = options.clock ?? systemClock;
  /** Configured monitoring window, in seconds. */
  const ttlSeconds = config.security.sessionTTLSeconds;

  /**
   * Assembles the activity view for one session from every available source.
   * The predicate takes the most recent usable timestamp, so a stale durable
   * `updatedAt` cannot expire a session that is still ingesting.
   *
   * Only server-generated timestamps appear here; the client-supplied telemetry
   * timestamp is deliberately excluded (see `services/session-liveness.ts`).
   */
  function activityFor(
    sessionId: string,
    durableUpdatedAt: string | null | undefined,
  ): SessionActivity {
    const state = sessionStore.get(sessionId);
    const active = activeSessions.get(sessionId);

    return {
      lastActivityAt:
        state?.lastActivityAt ?? active?.lastActivityAt ?? active?.deployedAt ?? null,
      persistedUpdatedAt: durableUpdatedAt ?? null,
    };
  }

  function livenessFor(
    sessionId: string,
    durableUpdatedAt: string | null | undefined,
  ): SessionLiveness {
    return resolveLiveness(activityFor(sessionId, durableUpdatedAt), ttlSeconds, clock);
  }

  // ─── GET /api/v1/sessions ───────────────────────────────────────
  reviewRouter.get("/", async (c) => {
    const requestId = randomUUID();

    interface SessionEntry {
      sessionId: string;
      employeeId: string;
      auditId: string;
      status: string;
      createdAt: string;
      updatedAt: string;
      eventCount?: number;
      pasteCount?: number;
      tabSwitchCount?: number;
      fullscreenExitCount?: number;
      copyAttemptCount?: number;
      peakRiskScore?: number;
    }

    const seenIds = new Set<string>();
    const allSessions: SessionEntry[] = [];

    const listed = await callMcpTool<{ success: boolean; data?: SessionEntry[] }>(
      config,
      MCP_TOOL_NAMES.LIST_SESSIONS,
      {},
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );

    if (listed.ok && listed.data?.success && Array.isArray(listed.data.data)) {
      for (const entry of listed.data.data) {
        if (!entry.sessionId || seenIds.has(entry.sessionId)) continue;
        allSessions.push(entry);
        seenIds.add(entry.sessionId);
      }
    }

    for (const [sessionId, state] of sessionStore.entries()) {
      if (seenIds.has(sessionId)) continue;
      seenIds.add(sessionId);
      allSessions.push({
        sessionId,
        employeeId: state.employeeId || "unknown",
        auditId: state.auditId || "",
        status: state.status || "active",
        createdAt: state.events[0]?.timestamp ?? toISOStringLocal(),
        updatedAt:
          state.events[state.events.length - 1]?.timestamp ?? toISOStringLocal(),
      });
    }

    for (const [sessionId, active] of activeSessions.entries()) {
      if (seenIds.has(sessionId)) continue;
      seenIds.add(sessionId);
      allSessions.push({
        sessionId,
        employeeId: active.employeeId || "unknown",
        auditId: active.matrixId || "",
        status: active.status,
        createdAt: active.deployedAt || toISOStringLocal(),
        updatedAt: active.deployedAt || toISOStringLocal(),
      });
    }

    if (allSessions.length === 0) {
      return c.json({ success: true, data: [] });
    }

    allSessions.sort(
      (a, b) => new Date(b.createdAt ?? "").getTime() - new Date(a.createdAt ?? "").getTime(),
    );

    const enriched = await Promise.all(
      allSessions.map(async (entry) => {
        const memSession = sessionStore.get(entry.sessionId);
        const active = activeSessions.get(entry.sessionId);

        // `eventCount` is the hydrated lifetime total, so it can exceed the events
        // this process has seen. `events.length` alone would under-report after a
        // restart.
        let eventCount =
          memSession === undefined
            ? (entry.eventCount ?? 0)
            : Math.max(memSession.events.length, memSession.eventCount);
        let pasteCount = memSession?.pasteCount ?? entry.pasteCount ?? 0;
        let tabSwitchCount = memSession?.tabSwitchCount ?? entry.tabSwitchCount ?? 0;
        let fullscreenExitCount =
          memSession?.fullscreenExitCount ?? entry.fullscreenExitCount ?? 0;
        let copyAttemptCount = memSession?.copyAttemptCount ?? entry.copyAttemptCount ?? 0;
        let riskScore =
          memSession?.lastRiskPayload?.overallRiskScore ?? entry.peakRiskScore ?? 0;
        let lastEventTimestamp: string | null = entry.updatedAt ?? null;

        const review = await callMcpTool<{
          success: boolean;
          events?: Array<{ eventType: string; timestamp: string }>;
          riskAssessments?: Array<{ overallRiskScore: number; generatedAt?: string }>;
        }>(
          config,
          MCP_TOOL_NAMES.GET_SESSION_REVIEW,
          { sessionId: entry.sessionId },
          { requestId, timeoutMs: MCP_TIMEOUT_MS },
        );

        if (review.ok && review.data?.success) {
          const events = review.data.events ?? [];
          if (events.length > eventCount) eventCount = events.length;

          const mcpPastes = events.filter(
            (event) => event.eventType === "PASTE_TRIGGER" || event.eventType === "PASTE",
          ).length;
          if (mcpPastes > pasteCount) pasteCount = mcpPastes;

          const mcpTabs = events.filter(
            (event) => event.eventType === "TAB_SWITCH" || event.eventType === "WINDOW_BLUR",
          ).length;
          if (mcpTabs > tabSwitchCount) tabSwitchCount = mcpTabs;

          const mcpCopies = events.filter(
            (event) => event.eventType === "COPY_ATTEMPT",
          ).length;
          if (mcpCopies > copyAttemptCount) copyAttemptCount = mcpCopies;

          const mcpFullscreenExits = events.filter(
            (event) =>
              event.eventType === "FULLSCREEN_EXIT" || event.eventType === "WINDOW_BLUR",
          ).length;
          if (mcpFullscreenExits > fullscreenExitCount) {
            fullscreenExitCount = mcpFullscreenExits;
          }

          if (events.length > 0) {
            lastEventTimestamp = [...events].sort(
              (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
            )[0].timestamp;
          }

          const assessments = sortReportsOldestFirst(
            review.data.riskAssessments ?? [],
          );
          if (assessments.length > 0) {
            const latest = assessments[assessments.length - 1]["overallRiskScore"];
            if (typeof latest === "number" && latest > riskScore) riskScore = latest;
          }
        }

        return {
          sessionId: entry.sessionId,
          employeeId: entry.employeeId || "unknown",
          auditId: entry.auditId || "",
          matrixId: active?.matrixId ?? entry.auditId ?? "",
          targetSystem: active?.targetSystem ?? "",
          status: active?.status ?? entry.status ?? "active",
          // Derived, never persisted: an expired session is still listed here
          // (review must not hide evidence) but is no longer live.
          //
          // `entry.updatedAt` is the durable, server-written activity signal.
          // `lastEventTimestamp` is deliberately NOT used: it comes from the
          // client-supplied `MicroEvent.timestamp`, which must not be able to
          // decide whether monitoring continues. It is still reported below as
          // display data.
          liveness: livenessFor(entry.sessionId, entry.updatedAt),
          eventCount,
          pasteCount,
          tabSwitchCount,
          fullscreenExitCount,
          copyAttemptCount,
          riskScore,
          peakRiskScore: riskScore,
          alertTriggered: riskScore >= 75,
          lastEventTimestamp,
          createdAt: entry.createdAt ?? toISOStringLocal(),
          startedAt: entry.createdAt ?? toISOStringLocal(),
        };
      }),
    );

    return c.json({ success: true, data: enriched });
  });

  // ─── GET /api/v1/sessions/:sessionId ────────────────────────────
  reviewRouter.get("/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const requestId = randomUUID();
    const memSession = sessionStore.get(sessionId);

    const review = await callMcpTool<{
      success: boolean;
      session?: {
        sessionId: string;
        employeeId?: string;
        auditId?: string;
        status?: string;
        terminalContent?: string;
        updatedAt?: string;
        createdAt?: string;
      } | null;
      events?: Array<{
        eventType?: string;
        timestamp: string;
        payload?: Record<string, unknown>;
      }>;
      riskAssessments?: Array<Record<string, unknown>>;
    }>(
      config,
      MCP_TOOL_NAMES.GET_SESSION_REVIEW,
      { sessionId },
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );

    // ── Durable store unreachable: serve from live memory ──
    if (!review.ok) {
      if (!memSession) {
        return c.json({ success: false, error: `Session '${sessionId}' not found` }, 404);
      }

      const timeline = memSession.events.map((event) =>
        buildTimelineEntry({
          eventType: event.eventType,
          timestamp: event.timestamp,
          payload: event.payload as unknown as Record<string, unknown>,
        }),
      );

      const riskSummary: RiskAssessmentPayload[] = memSession.lastRiskPayload
        ? [memSession.lastRiskPayload]
        : [];

      const response: SessionReviewResponse = {
        sessionId,
        employeeId: memSession.employeeId || "unknown",
        auditId: memSession.auditId || "",
        status:
          memSession.status === "terminated" || memSession.status === "locked"
            ? memSession.status
            : riskSummary.length > 0
              ? "flagged"
              : "active",
        terminalContent: memSession.currentCode ?? "",
        timeline,
        riskSummary,
        finalRiskScore: memSession.lastRiskPayload?.overallRiskScore ?? 0,
        liveness: livenessFor(sessionId, null),
      };

      return c.json({ success: true, data: response });
    }

    if (!review.data?.success || !review.data.session) {
      return c.json({ success: false, error: `Session '${sessionId}' not found` }, 404);
    }

    const session = review.data.session;
    const events = review.data.events ?? [];
    // Oldest first, so "the latest" is the last element regardless of the order
    // the persistence layer returned them in.
    const reports = sortReportsOldestFirst(review.data.riskAssessments ?? []);

    const timeline = events.map((event) =>
      buildTimelineEntry({
        eventType: event.eventType,
        timestamp: event.timestamp,
        payload: event.payload,
      }),
    );

    let status: SessionReviewResponse["status"] =
      (session.status as SessionReviewResponse["status"]) ?? "active";

    const hasSubmission = events.some((event) => event.eventType === "SUBMIT");
    const lastReport = reports.length > 0 ? reports[reports.length - 1] : null;
    const isFlagged =
      lastReport !== null && ((lastReport["overallRiskScore"] as number) ?? 0) > 50;

    // Lifecycle states set by the guardian are authoritative: a terminated
    // session stays terminated, and a locked session stays locked, regardless
    // of what the derived risk analysis would otherwise conclude.
    if (status !== "terminated" && status !== "locked") {
      if (isFlagged) {
        status = "flagged";
      } else if (hasSubmission) {
        status = "investigating";
      }
    }

    const riskSummary: RiskAssessmentPayload[] = reports.map((report) => {
      const rawFlags = Array.isArray(report["flags"])
        ? (report["flags"] as Record<string, unknown>[])
        : [];
      const generatedAt = (report["generatedAt"] as string) ?? toISOStringLocal();
      const dims = (report["dimensionScores"] ?? {}) as Record<string, unknown>;

      return {
        riskAssessmentId: (report["riskAssessmentId"] as string) ?? randomUUID(),
        sessionId: (report["sessionId"] as string) ?? sessionId,
        employeeId: (report["employeeId"] as string) ?? session.employeeId ?? "",
        auditId: (report["auditId"] as string) ?? session.auditId ?? "",
        overallRiskScore: (report["overallRiskScore"] as number) ?? 0,
        dimensionScores: {
          dataExfiltration: (dims["dataExfiltration"] as number) ?? 0,
          unauthorizedAccess: (dims["unauthorizedAccess"] as number) ?? 0,
          policyViolation: (dims["policyViolation"] as number) ?? 0,
          amlRedFlag: (dims["amlRedFlag"] as number) ?? 0,
          insiderTrading: (dims["insiderTrading"] as number) ?? 0,
          soxNonCompliance: (dims["soxNonCompliance"] as number) ?? 0,
        },
        flags: rawFlags.map((flag) => ({
          flagType: (flag["flagType"] as string) ?? "unknown",
          severity: ((flag["severity"] as string) ?? "medium") as RiskAssessmentPayload["flags"][number]["severity"],
          sourceEventId: (flag["sourceEventId"] as string) ?? "",
          description:
            (flag["description"] as string) ?? (flag["flagType"] as string) ?? "",
          confidence: (flag["confidence"] as number) ?? 1,
          timestamp: (flag["timestamp"] as string) ?? generatedAt,
        })),
        exfiltrationReport:
          (report["exfiltrationReport"] as RiskAssessmentPayload["exfiltrationReport"]) ??
          null,
        behavioralAnomalies:
          (report["behavioralAnomalies"] as RiskAssessmentPayload["behavioralAnomalies"]) ??
          [],
        generatedAt,
      };
    });

    const finalRiskScore = lastReport
      ? ((lastReport["overallRiskScore"] as number) ?? 0)
      : (memSession?.lastRiskPayload?.overallRiskScore ?? 0);

    const response: SessionReviewResponse = {
      sessionId: session.sessionId,
      employeeId: session.employeeId ?? memSession?.employeeId ?? "unknown",
      auditId: session.auditId ?? memSession?.auditId ?? "",
      status,
      // `monitored_sessions.terminalContent` is never written — no route calls
      // `update_session_terminal_content` — so after a restart this would resolve
      // to "". The newest assessment's `codeSnapshot` holds the same content, so
      // the review view recovers instead of reporting an empty workspace. The
      // evidence was always durable; only the view lost it.
      terminalContent: firstNonEmptyString(
        session.terminalContent,
        memSession?.currentCode,
        lastReport?.["codeSnapshot"] as string | undefined,
      ),
      timeline,
      riskSummary,
      finalRiskScore,
      // `updatedAt` is written by the persistence layer with a server clock and
      // is therefore the only trustworthy durable activity signal. The
      // client-supplied event timestamps in `timeline` are display data and are
      // deliberately not consulted here.
      liveness: livenessFor(sessionId, session.updatedAt ?? session.createdAt ?? null),
    };

    return c.json({ success: true, data: response });
  });

  return reviewRouter;
}

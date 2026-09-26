/**
 * Durable reconciliation for the live session read surfaces.
 *
 * ── The problem ───────────────────────────────────────────────────────
 *
 * The live list and the live detail were built when one process was the only writer. Both
 * answered from `sessionStore` and `activeSessions` — this process's memory — and consulted
 * MongoDB only when that memory was **empty**. With a second replica, that is wrong in two
 * ways, and neither is subtle:
 *
 *   - **A durably-terminated session is reported live.** Process A terminates it; process B
 *     still holds it with its old status and keeps returning `active` until its TTL elapses,
 *     a transition happens to run through B's boundary, or B restarts. The review surfaces
 *     read MongoDB and say `terminated`. Two surfaces, one session, two answers.
 *   - **Another process's sessions are missing entirely.** B's registry holds only what B
 *     deployed, so A's sessions do not appear at all. That is worse than a stale value: the
 *     session is not misreported, it is absent.
 *
 * ── The rule ──────────────────────────────────────────────────────────
 *
 * **One batched durable query per live-list request, and durable wins where it answers.**
 *
 * Not a TTL cache, and not a per-session read. A TTL cache would trade one bounded query for
 * a lie of unknown age; a per-session read would make the list cost one query per session,
 * which is the N+1 the list path must not acquire. One query for the whole page is bounded
 * regardless of how many sessions are in memory, and it is the same query the
 * restart-recovery path already made — it is now simply always made.
 *
 * The merge, field group by field group:
 *
 *   lifecycle status   durable, always. A status this process holds is a cache.
 *   counters           `max(local, durable)`. Counters are monotonic, so the larger value is
 *                      the newer one, and taking the maximum means neither process's
 *                      knowledge is discarded.
 *   peak risk score    `max(local, durable)`, for the same reason.
 *   identity, deployedAt, targetSystem
 *                      durable when present. They are durable-authoritative and this process
 *                      has no way to be more right about them.
 *   workspace, latest payload
 *                      this process, and labelled `ephemeralStateAvailable`. It is the only
 *                      thing here a single process can answer.
 *   liveness           derived from the **most recent** of the two activity instants, so a
 *                      stale local timestamp cannot keep a closed window open and a stale
 *                      durable one cannot close a live window.
 *
 * ── What happens when the store does not answer ───────────────────────
 *
 * The reconciler returns the local view with `reconciled: false` and every row marked
 * `statusSource: "process-local"`. It does **not** invent a status, and it does not silently
 * present the local one as durable truth. Refusing the request outright would take the live
 * dashboard down during a store blip, which is a worse failure than a labelled stale value;
 * claiming the value is durable would be a lie. So it is served, and it is labelled.
 *
 * ── Why this is a pure function ───────────────────────────────────────
 *
 * No database, no clock, no logger. The rule is the thing worth testing, and a pure merge can
 * be driven over states that are awkward to produce through HTTP — a durable document newer
 * than memory, a durable-only session, a page where some rows reconciled and some did not.
 * The route is a thin adapter around it.
 *
 * See `docs/development/live-read-consistency.md` and
 * `docs/development/multi-writer-model.md` §5.1.
 */

import {
  isExpired,
  resolveLiveness,
  type SessionLiveness,
} from "./session-liveness.js";
import {
  readDurableSessionView,
  readDurableString,
  type DurableSessionView,
} from "./session-read-model.js";
import {
  isMonitored,
  normalizeStatus,
  type PersistedSessionStatus,
} from "./session-status.js";

/**
 * This process's view of one live session, before reconciliation.
 *
 * Deliberately a small projection rather than the `SessionState` and `ActiveSession` maps:
 * the reconciler must not be able to reach into mutable process state, and the route is the
 * only place that knows how the two maps combine into one row.
 */
export interface LocalLiveSession {
  sessionId: string;
  employeeId: string;
  matrixId: string;
  targetSystem: string;
  /** This process's status. A cache of the durable value, never the authority. */
  status: string;
  deployedAt: string;
  /** This process's last-activity instant, when it has one. */
  lastActivityAt?: string;
  riskIndex: number;
  eventCount: number;
  pasteCount: number;
  tabSwitchCount: number;
  focusLossCount: number;
  copyAttemptCount: number;
  /**
   * True when this process holds the reconstructed workspace or the latest risk payload for
   * the session. Reported to the client rather than implied.
   */
  ephemeralStateAvailable: boolean;
}

/** A reconciled live-list row. Additive fields are marked. */
export interface ReconciledLiveSession {
  sessionId: string;
  employeeId: string;
  auditId: string;
  matrixId: string;
  targetSystem: string;
  status: PersistedSessionStatus;
  /** **Additive.** Which source answered for `status`. */
  statusSource: "durable" | "process-local";
  liveness: SessionLiveness;
  deployedAt: string;
  startedAt: string;
  createdAt: string;
  riskIndex: number;
  peakRiskScore: number;
  eventCount: number;
  pasteCount: number;
  tabSwitchCount: number;
  focusLossCount: number;
  /** Deprecated alias for `focusLossCount`. Same value. */
  fullscreenExitCount: number;
  copyAttemptCount: number;
  alertTriggered: boolean;
  /** **Additive.** Whether the ephemeral fields can be answered by this process. */
  ephemeralStateAvailable: boolean;
}

/** Why a session the durable document knows about is not on the live list. */
export type LiveDropReason = "terminated" | "expired";

export interface LiveListReconciliation {
  sessions: ReconciledLiveSession[];
  /**
   * False when the durable query did not answer.
   *
   * Every row is then `statusSource: "process-local"`, and a client that needs durable truth
   * must not treat the page as reconciled.
   */
  reconciled: boolean;
  /** Sessions removed because the durable document says they are not live. */
  dropped: Array<{ sessionId: string; reason: LiveDropReason }>;
  /** Sessions present durably but absent from this process's memory. */
  addedFromDurable: string[];
  /**
   * Local sessions whose cached status the durable document contradicts.
   *
   * Each entry carries the durable document, so the caller can repair its cache **toward the
   * document** without a second read. This is the read-path half of the stale-cache defence:
   * a read that discovers a divergence fixes the reporter, so the next request does not have
   * to rediscover it.
   */
  repairs: Array<{
    sessionId: string;
    status: PersistedSessionStatus;
    durable: Record<string, unknown>;
  }>;
  /** Sessions this process holds with no durable document at all. */
  localOnly: string[];
}

export interface ReconcileLiveListOptions {
  /** The configured monitoring window. Non-positive disables expiry, as elsewhere. */
  ttlSeconds: number;
  /** The instant expiry is evaluated against. Passed in so this stays pure. */
  nowMs: number;
  /**
   * The risk score at or above which `alertTriggered` is true.
   *
   * Passed in rather than imported: the threshold lives in `routes/guardian.ts`, and a
   * service importing a route module is the layering inversion `session-status.ts` was
   * extracted to avoid.
   */
  alertThreshold: number;
}

/** The larger of two counters. Counters are monotonic, so the larger one is the newer one. */
function maxCounter(a: number, b: number): number {
  return Math.max(a, b);
}

/** A finite, non-negative counter, or 0. Mirrors the durable reader's tolerance. */
function safeCounter(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** A `Clock` fixed at one instant, so expiry is evaluated exactly once per request. */
function fixedClock(nowMs: number) {
  return { now: () => nowMs };
}

/**
 * Merges this process's live view with the durable documents.
 *
 * @param local this process's rows, already filtered to sessions it considers live
 * @param durableDocuments every session document, or `null` when the store did not answer
 */
export function reconcileLiveList(
  local: LocalLiveSession[],
  durableDocuments: Record<string, unknown>[] | null,
  options: ReconcileLiveListOptions,
): LiveListReconciliation {
  const { ttlSeconds, nowMs, alertThreshold } = options;
  const clock = fixedClock(nowMs);

  const dropped: LiveListReconciliation["dropped"] = [];
  const addedFromDurable: string[] = [];
  const repairs: LiveListReconciliation["repairs"] = [];
  const localOnly: string[] = [];
  const sessions: ReconciledLiveSession[] = [];

  const durableById = new Map<string, Record<string, unknown>>();
  if (durableDocuments) {
    for (const document of durableDocuments) {
      const sessionId = String(document["sessionId"] ?? "");
      if (sessionId.length > 0) durableById.set(sessionId, document);
    }
  }

  const seen = new Set<string>();

  // ── Rows this process already holds ────────────────────────────────
  for (const entry of local) {
    if (seen.has(entry.sessionId)) continue;
    seen.add(entry.sessionId);

    const document = durableById.get(entry.sessionId) ?? null;
    const view: DurableSessionView | null = document
      ? readDurableSessionView(document, entry.sessionId)
      : null;

    if (!document) localOnly.push(entry.sessionId);

    // Durable wins for the lifecycle status. With no document, the local value is all there
    // is, and it is labelled rather than presented as durable truth.
    const status = view ? view.status : normalizeStatus(entry.status);
    const statusSource: ReconciledLiveSession["statusSource"] = view
      ? "durable"
      : "process-local";

    if (view && normalizeStatus(entry.status) !== view.status && document) {
      repairs.push({ sessionId: entry.sessionId, status: view.status, durable: document });
    }

    if (!isMonitored(status)) {
      dropped.push({ sessionId: entry.sessionId, reason: "terminated" });
      continue;
    }

    const activity = {
      lastActivityAt: entry.lastActivityAt ?? null,
      // The durable `updatedAt` is the only activity signal that survives a restart, and the
      // predicate takes the most recent of the two, so neither side can move the window.
      persistedUpdatedAt: document ? readDurableString(document, "updatedAt") : null,
    };

    if (isExpired(activity, ttlSeconds, clock)) {
      dropped.push({ sessionId: entry.sessionId, reason: "expired" });
      continue;
    }

    const eventCount = maxCounter(safeCounter(entry.eventCount), view?.eventCount ?? 0);
    const pasteCount = maxCounter(safeCounter(entry.pasteCount), view?.pasteCount ?? 0);
    const tabSwitchCount = maxCounter(
      safeCounter(entry.tabSwitchCount),
      view?.tabSwitchCount ?? 0,
    );
    const focusLossCount = maxCounter(
      safeCounter(entry.focusLossCount),
      view?.focusLossCount ?? 0,
    );
    const copyAttemptCount = maxCounter(
      safeCounter(entry.copyAttemptCount),
      view?.copyAttemptCount ?? 0,
    );
    const peakRiskScore = maxCounter(safeCounter(entry.riskIndex), view?.riskScore ?? 0);
    const deployedAt = view?.deployedAt ?? entry.deployedAt;

    sessions.push({
      sessionId: entry.sessionId,
      employeeId: view?.employeeId ?? entry.employeeId,
      auditId: view?.matrixId ?? entry.matrixId,
      matrixId: view?.matrixId ?? entry.matrixId,
      targetSystem: view?.targetSystem ?? entry.targetSystem,
      status,
      statusSource,
      liveness: resolveLiveness(activity, ttlSeconds, clock),
      deployedAt,
      startedAt: deployedAt,
      createdAt: deployedAt,
      riskIndex: peakRiskScore,
      peakRiskScore,
      eventCount,
      pasteCount,
      tabSwitchCount,
      focusLossCount,
      fullscreenExitCount: focusLossCount,
      copyAttemptCount,
      alertTriggered: peakRiskScore >= alertThreshold,
      ephemeralStateAvailable: entry.ephemeralStateAvailable,
    });
  }

  // ── Rows only the durable document knows about ─────────────────────
  //
  // This is the branch that makes another process's sessions visible. Before it existed the
  // live list could only ever show what this process had itself deployed or ingested.
  if (durableDocuments) {
    for (const [sessionId, document] of durableById) {
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);

      const view = readDurableSessionView(document, sessionId);

      if (!isMonitored(view.status)) {
        dropped.push({ sessionId, reason: "terminated" });
        continue;
      }

      const activity = { lastActivityAt: null, persistedUpdatedAt: view.lastActivityAt };

      if (isExpired(activity, ttlSeconds, clock)) {
        dropped.push({ sessionId, reason: "expired" });
        continue;
      }

      addedFromDurable.push(sessionId);
      const peakRiskScore = safeCounter(view.riskScore);

      sessions.push({
        sessionId,
        employeeId: view.employeeId,
        auditId: view.matrixId,
        matrixId: view.matrixId,
        targetSystem: view.targetSystem,
        status: view.status,
        statusSource: "durable",
        liveness: resolveLiveness(activity, ttlSeconds, clock),
        deployedAt: view.deployedAt,
        startedAt: view.deployedAt,
        createdAt: view.deployedAt,
        riskIndex: peakRiskScore,
        peakRiskScore,
        eventCount: view.eventCount,
        pasteCount: view.pasteCount,
        tabSwitchCount: view.tabSwitchCount,
        focusLossCount: view.focusLossCount,
        fullscreenExitCount: view.focusLossCount,
        copyAttemptCount: view.copyAttemptCount,
        alertTriggered: peakRiskScore >= alertThreshold,
        // Nothing is ingested here, so there is no workspace and no payload to offer. That
        // is a statement about this process, not about the session.
        ephemeralStateAvailable: false,
      });
    }
  }

  sessions.sort((a, b) => {
    const aTime = Date.parse(a.deployedAt);
    const bTime = Date.parse(b.deployedAt);
    // A malformed instant must not reorder the page unpredictably: an unusable timestamp
    // sorts last rather than producing NaN comparisons.
    const aRank = Number.isFinite(aTime) ? aTime : Number.NEGATIVE_INFINITY;
    const bRank = Number.isFinite(bTime) ? bTime : Number.NEGATIVE_INFINITY;
    return bRank - aRank;
  });

  return {
    sessions,
    reconciled: durableDocuments !== null,
    dropped,
    addedFromDurable,
    repairs,
    localOnly,
  };
}

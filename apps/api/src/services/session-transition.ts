/**
 * The canonical session transition boundary.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 *
 * Session status was previously written by five code paths — deploy, ingest's
 * auto-lock, ingest's auto-clear, reactivate and terminate — and they disagreed in
 * three ways, all recorded in `docs/development/state-transition-model.md`:
 *
 *   1. They ordered their cache and durable writes three different ways, so a partial
 *      failure left a different lie depending on which route failed.
 *   2. Three of them did not inspect the durable write's result, so a status change
 *      that never reached MongoDB was reported as `200 success: true`.
 *   3. None validated the *current* status, so a `terminated` session could be moved
 *      to `locked` by a later high-risk ingest — a state the operator never chose, on
 *      a session they had explicitly stopped.
 *
 * This module is the one place a lifecycle status changes. It is deliberately not a
 * generic `setStatus`: the callers are domain actions, the legal transitions are a
 * table, and the result distinguishes *applied*, *already there*, *refused* and
 * *conflict* so a route never has to guess what happened.
 *
 * ── What it guarantees ────────────────────────────────────────────────
 *
 * 1. **The durable document is the authority.** The current status is read from
 *    MongoDB, never from a cache. A cache is consulted only to decide whether it
 *    needs repairing.
 * 2. **A refused transition never changes the durable status and never applies the
 *    requested change.** It *does* reconcile the cache to the durable value it just
 *    read, when that value is one the durable vocabulary can hold — the cache is
 *    demonstrably wrong at that point, and correcting it is free. So a refusal leaves
 *    the process more consistent than it found it.
 * 3. **The durable write is atomic and predicate-checked.** It applies only while the
 *    stored status is one the transition is legal from, so a concurrent transition is
 *    detected and reported as `SESSION_CONFLICT` rather than silently overwritten.
 * 4. **The caches are repaired from the durable outcome**, never from the caller's
 *    intent. A failed durable write therefore cannot leave a cache asserting a status
 *    MongoDB does not hold.
 *
 * ── What it deliberately is not ───────────────────────────────────────
 *
 * Not responsible for telemetry validation, counter arithmetic, AI analysis,
 * notifications, or any persistence other than lifecycle state. Centralising
 * unrelated logic here would trade five small divergences for one large coupling.
 *
 * It also does not read the session's events or assessments: every read it makes
 * passes `eventsLimit: 0, includeAssessments: false`, so a transition costs one
 * session document rather than a session's history.
 */

import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import { LOG_EVENTS, logger } from "../observability/logger.js";
import { callMcpTool, MCP_TOOL_NAMES } from "./mcp-client.js";
import {
  isDurableStatus,
  normalizeStatus,
  SESSION_TRANSITION_CODES,
  SESSION_TRANSITION_HTTP_STATUS,
  type DurableSessionStatus,
  type PersistedSessionStatus,
  type SessionTransitionCode,
} from "./session-status.js";
import { toISOStringLocal } from "../utils/time.js";
import { systemClock, type Clock } from "./session-liveness.js";

/** Per-call deadline for a transition's persistence call. */
const MCP_TIMEOUT_MS = 5_000;

/** The lifecycle actions a caller may request. */
export type SessionAction =
  | "terminate"
  | "autoLock"
  | "autoClear"
  | "reactivate";

/**
 * The transition table.
 *
 * `from` is the set of durable statuses the action is legal from; `to` is the status
 * it produces. A `from` that contains `to` makes the action idempotent: re-running it
 * is a legal no-op rather than a refusal.
 *
 * The only way one of these actions is refused for a *non-terminal* reason is a
 * document holding a derived status it should not have — `flagged`, `investigating`
 * or `cleared` are never written, so a document holding one is a data-integrity
 * problem, and `INVALID_SESSION_TRANSITION` says so rather than guessing.
 */
interface TransitionRule {
  from: readonly DurableSessionStatus[];
  to: DurableSessionStatus;
}

const TRANSITIONS: Record<SessionAction, TransitionRule> = {
  /**
   * Terminal, and idempotent: terminating an already-terminated session is a legal
   * no-op, which keeps a retried terminate from reporting an error.
   */
  terminate: { from: ["active", "locked", "terminated"], to: "terminated" },
  /**
   * `active` → `locked`. `locked` is in `from` so a second high-risk batch is a no-op
   * rather than a refusal. **`terminated` is absent, and that is the fix**: this is
   * the transition that used to resurrect a terminated session.
   */
  autoLock: { from: ["active", "locked"], to: "locked" },
  /** `locked` → `active` on a score below the clear threshold. */
  autoClear: { from: ["locked", "active"], to: "active" },
  /** Reopens a monitoring window. Refused for a terminal session. */
  reactivate: { from: ["active", "locked"], to: "active" },
};

/** A transition that was applied, or that was a legal no-op. */
export interface SessionTransitionApplied {
  ok: true;
  /**
   * `false` when the session was already in the target state. A legal no-op, not a
   * failure — and distinct from an application, so a caller can tell "I changed this"
   * from "this was already true".
   */
  applied: boolean;
  sessionId: string;
  /** The status after the operation. Always a durable status for a transition. */
  status: PersistedSessionStatus;
  /** The durable status before the operation. */
  previousStatus: PersistedSessionStatus;
}

/** A transition that was refused, or that could not be attempted. */
export interface SessionTransitionRefused {
  ok: false;
  code: SessionTransitionCode;
  httpStatus: number;
  /** Client-facing. Never contains internal detail, a stack, or a store message. */
  message: string;
  sessionId: string;
  /** The durable status observed, when one was read. */
  previousStatus?: PersistedSessionStatus;
}

export type SessionTransitionResult =
  | SessionTransitionApplied
  | SessionTransitionRefused;

/**
 * The in-process caches a transition repairs.
 *
 * An interface rather than the two maps themselves, so this module does not import a
 * route module's types. The implementation lives in `routes/guardian.ts`, which owns
 * the maps.
 *
 * `apply` receives the durable document so it can seed a live-registry entry that
 * does not exist yet — which is what reactivation needs after a restart, when memory
 * holds nothing for the session.
 */
export interface SessionTransitionCache {
  /** The status this process currently holds for the session, or null. */
  read(sessionId: string): PersistedSessionStatus | null;
  /**
   * Records a durable outcome on whichever entries exist.
   *
   * Called only after the durable write has succeeded, or after a read established
   * that the session is already in the target state.
   */
  apply(
    sessionId: string,
    status: DurableSessionStatus,
    at: string,
    durable: Record<string, unknown>,
  ): void;
  /** Drops the session from the live registry. Used by terminate. */
  evict(sessionId: string): void;
  /**
   * Repairs the cached status from a durable value observed on a **read**.
   *
   * Deliberately not `apply`. `apply` stamps the cached activity instant to the transition
   * instant, which is right for a transition — the session was just acted on — and wrong for
   * a read: a status repair that also moved `lastActivityAt` forward would extend a session's
   * monitoring window as a side effect of *looking* at it, which is exactly the bypass the
   * TTL exists to prevent. This method therefore changes the status and nothing else.
   *
   * It also never seeds an entry. A durable-only session is served from the durable document
   * on every read; copying it into this process's registry would grow memory with sessions
   * the process does not otherwise hold, and add no correctness. A `terminated` status
   * **evicts** from the live registry, because a session that is not monitored must not be
   * listed by the next read.
   */
  reconcileStatus(
    sessionId: string,
    status: DurableSessionStatus,
    durable: Record<string, unknown>,
  ): void;
}

export interface SessionTransitions {
  terminate(sessionId: string, requestId?: string): Promise<SessionTransitionResult>;
  autoLock(
    sessionId: string,
    requestId?: string,
  ): Promise<SessionTransitionResult>;
  autoClear(sessionId: string, requestId?: string): Promise<SessionTransitionResult>;
  reactivate(sessionId: string, requestId?: string): Promise<SessionTransitionResult>;
  /**
   * The terminal workspace content for a session, or `null` when nothing holds one.
   *
   * Used by `terminate` to preserve the workspace before monitoring ends.
   */
  workspaceToPreserve(
    sessionId: string,
    inMemoryCode: string | undefined,
    requestId?: string,
  ): Promise<string | null>;
  /**
   * Writes the terminal workspace content.
   *
   * Not a status transition, but it is lifecycle state owned by the session document
   * and it was previously reachable only through a published MCP tool no route
   * called. Routing it here gives terminal content one owner and one existence check.
   *
   * `options` carries the ownership gates. `expectedStatuses` makes the write a
   * compare-and-set on the lifecycle status, so the process whose terminal transition
   * actually applied owns the field; `onlyIfAbsent` narrows it to repairing a terminated
   * session that holds no content yet. `applied` on the result reports whether the write
   * happened, which is a different fact from whether the request was valid.
   */
  updateTerminalContent(
    sessionId: string,
    content: string,
    requestId?: string,
    options?: { expectedStatuses?: readonly string[]; onlyIfAbsent?: boolean },
  ): Promise<SessionTransitionResult>;
}

export interface SessionTransitionDeps {
  config: AppConfig;
  cache: SessionTransitionCache;
  /** Time source for the activity stamp. Defaults to the system clock. */
  clock?: Clock;
}

/**
 * True when telemetry may be accepted for a session in this status.
 *
 * Exported so the ingest path can gate on the durable document it has *already* read,
 * rather than paying for a second round trip to ask the same question. One rule, one
 * definition, two callers.
 */
export function acceptsTelemetry(status: PersistedSessionStatus): boolean {
  return status !== "terminated";
}

/** Builds the canonical transition boundary. */
export function createSessionTransitions(
  deps: SessionTransitionDeps,
): SessionTransitions {
  const { config, cache } = deps;
  const clock: Clock = deps.clock ?? systemClock;

  function refused(
    code: SessionTransitionCode,
    message: string,
    sessionId: string,
    previousStatus?: PersistedSessionStatus,
  ): SessionTransitionRefused {
    return {
      ok: false,
      code,
      httpStatus: SESSION_TRANSITION_HTTP_STATUS[code],
      message,
      sessionId,
      ...(previousStatus !== undefined ? { previousStatus } : {}),
    };
  }

  /**
   * Reads the durable session document, without its events or its assessments.
   *
   * Returns the document, or a refusal. A `null` document is `SESSION_NOT_FOUND`
   * rather than an empty result, because every caller here is a mutation that needs a
   * document to act on.
   */
  async function readDurable(
    sessionId: string,
    requestId: string,
  ): Promise<
    | { ok: true; document: Record<string, unknown> }
    | { ok: false; refusal: SessionTransitionRefused }
  > {
    const response = await callMcpTool<{
      success?: boolean;
      session?: Record<string, unknown> | null;
    }>(
      config,
      MCP_TOOL_NAMES.GET_SESSION_REVIEW,
      // Neither is used, and asking for them would make a status change cost a
      // session's whole history. `eventsLimit: 0` skips the query rather than passing
      // 0 down, where MongoDB would read it as "no limit".
      { sessionId, eventsLimit: 0, includeAssessments: false },
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );

    if (!response.ok || !response.data?.success) {
      return {
        ok: false,
        refusal: refused(
          SESSION_TRANSITION_CODES.SESSION_STORE_UNAVAILABLE,
          "The session store did not answer, so the transition was not attempted.",
          sessionId,
        ),
      };
    }

    const document = response.data.session ?? null;
    if (!document) {
      return {
        ok: false,
        refusal: refused(
          SESSION_TRANSITION_CODES.SESSION_NOT_FOUND,
          `Session '${sessionId}' not found`,
          sessionId,
        ),
      };
    }

    return { ok: true, document };
  }

  /** The durable status of a document, normalised onto the known vocabulary. */
  function statusOf(document: Record<string, unknown>): PersistedSessionStatus {
    return normalizeStatus(String(document["status"] ?? "active"));
  }

  /**
   * Applies a status transition.
   *
   * The order is load-bearing and is the same for every action:
   *   read durable → validate → write durable (predicate-checked) → repair caches.
   */
  async function apply(
    action: SessionAction,
    sessionId: string,
    requestId: string,
  ): Promise<SessionTransitionResult> {
    const rule = TRANSITIONS[action];

    // 1. The durable document is the authority.
    const loaded = await readDurable(sessionId, requestId);
    if (!loaded.ok) return loaded.refusal;

    const { document } = loaded;
    const rawStatus = String(document["status"] ?? "active");
    const current = statusOf(document);
    /**
     * True when the document holds a value the store cannot hold.
     *
     * A legacy `flagged`, `cleared` or a hand-edited string. Such a document is
     * **repaired** rather than refused: see the write below.
     */
    const isRepair = !isDurableStatus(rawStatus);

    // 2. Validate against the table, before writing anything.
    if (!isDurableStatus(current) || !rule.from.includes(current)) {
      // The read established the truth and the cache may disagree with it — this is
      // exactly the case where a status diverged because another writer, or a restart,
      // moved it. Reconciling here is free (the value is in hand) and it means a
      // refusal leaves the process *more* consistent than it found it, rather than
      // leaving a stale cache to be reported by the read paths.
      //
      // Only a durable status can be applied: a document holding a derived one is a
      // data-integrity problem, and copying `flagged` into a cache that the durable
      // vocabulary cannot hold would spread it.
      if (isDurableStatus(current)) {
        const reconciledAt = toISOStringLocal(new Date(clock.now()));
        cache.apply(sessionId, current, reconciledAt, document);
        if (current === "terminated") cache.evict(sessionId);
      }

      // A terminal session is refused with its own code, because "this session has
      // ended" is actionable and "that transition is not in the table" is not.
      return current === "terminated"
        ? refused(
            SESSION_TRANSITION_CODES.SESSION_TERMINAL,
            `Session '${sessionId}' is terminated and cannot be ${describe(action)}. ` +
              "Deploy a new session instead.",
            sessionId,
            current,
          )
        : refused(
            SESSION_TRANSITION_CODES.INVALID_SESSION_TRANSITION,
            `Session '${sessionId}' holds status '${current}', which is not a state ` +
              `'${action}' may start from.`,
            sessionId,
            current,
          );
    }

    const at = toISOStringLocal(new Date(clock.now()));

    // 3. Already in the target state: a legal no-op. Repair the cache from the
    //    durable value — the cache may be the thing that is wrong — and write nothing.
    if (current === rule.to) {
      cache.apply(sessionId, rule.to, at, document);
      if (action === "terminate") cache.evict(sessionId);
      return {
        ok: true,
        applied: false,
        sessionId,
        status: rule.to,
        previousStatus: current,
      };
    }

    // 4. The durable write, predicated on the status the read observed. A concurrent
    //    transition between the read and the write makes this match nothing.
    const written = await callMcpTool<{ success?: boolean; updated?: boolean }>(
      config,
      MCP_TOOL_NAMES.SET_SESSION_STATUS,
      {
        sessionId,
        status: rule.to,
        // ── The one case with no predicate ──
        //
        // A document holding a value the store cannot hold — a legacy `flagged`,
        // `cleared`, or a hand-edited string — has no meaningful predicate. No writer can
        // produce that value, so there is no concurrent transition to detect, and
        // predicating on the normalised value would match nothing and report
        // `SESSION_CONFLICT` on every attempt: a session the operator could never
        // terminate, reactivate or lock. The write is therefore unconditional, and it
        // **repairs** the document to a real status. The repair is logged, because
        // silently rewriting a field is worth knowing about.
        ...(isRepair ? {} : { expectedStatuses: [...rule.from] }),
      },
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );

    if (!written.ok || !written.data?.success) {
      return refused(
        SESSION_TRANSITION_CODES.SESSION_STORE_UNAVAILABLE,
        "The session status could not be persisted, so it was not changed.",
        sessionId,
        current,
      );
    }

    if (isRepair) {
      logger.warn(LOG_EVENTS.SESSION_TRANSITION_REPAIRED, {
        requestId,
        action,
        sessionId,
        // The raw value, not the normalised one: it is the data-integrity signal.
        storedStatus: rawStatus,
        normalisedStatus: current,
        status: rule.to,
      });
    }

    if (written.data.updated !== true) {
      return refused(
        SESSION_TRANSITION_CODES.SESSION_CONFLICT,
        `Session '${sessionId}' changed status while this transition was being ` +
          "applied, so it was not applied. Re-read the session and retry.",
        sessionId,
        current,
      );
    }

    // 5. Repair the caches from the durable outcome, never from the intent.
    cache.apply(sessionId, rule.to, at, document);
    if (action === "terminate") cache.evict(sessionId);

    logger.info(LOG_EVENTS.SESSION_TRANSITION, {
      requestId,
      action,
      sessionId,
      previousStatus: current,
      status: rule.to,
      applied: true,
    });

    return {
      ok: true,
      applied: true,
      sessionId,
      status: rule.to,
      previousStatus: current,
    };
  }

  /**
   * The terminal workspace content for a session, or `null` when nothing holds one.
   *
   * ── Ownership ─────────────────────────────────────────────────────────
   *
   * `monitored_sessions.terminalContent` is the **owner** of "the workspace as it was when
   * monitoring ended", and `update_session_terminal_content` is the only way it is written.
   * Before this, no route called that tool, so the field was always absent and the review
   * path recovered the workspace from a chain of three sources — one concept with three
   * candidate owners and no rule saying which won.
   *
   * The three sources are not equivalent, and the distinction is now explicit:
   *
   *   - `terminalContent` — the workspace as monitoring ended. Owned by the session
   *     document, written once, by the transition that ends monitoring.
   *   - `risk_assessments.codeSnapshot` — the workspace **at the moment a given assessment
   *     ran**. Point-in-time evidence, and a different fact: an assessment taken an hour
   *     before termination records what the workspace was then, not what it ended as.
   *   - the in-memory `currentCode` — this process's reconstruction, which a restart loses.
   *
   * `codeSnapshot` is therefore read here as a **fallback for a session terminated before
   * this change existed**, not as a competing owner. A session terminated by this build
   * always has `terminalContent` written, so the fallback is unreachable for it.
   *
   * `assessmentsLimit: 1` because only the newest assessment can hold the most recent
   * workspace; reading the history to take its first element would be work proportional to
   * the session's whole analysis history.
   */
  async function workspaceToPreserve(
    sessionId: string,
    inMemoryCode: string | undefined,
    requestId: string,
  ): Promise<string | null> {
    if (inMemoryCode && inMemoryCode.length > 0) return inMemoryCode;

    const response = await callMcpTool<{
      success?: boolean;
      session?: Record<string, unknown> | null;
      riskAssessments?: Array<Record<string, unknown>>;
    }>(
      config,
      MCP_TOOL_NAMES.GET_SESSION_REVIEW,
      { sessionId, eventsLimit: 0, assessmentsLimit: 1 },
      { requestId, timeoutMs: MCP_TIMEOUT_MS },
    );

    if (!response.ok || !response.data?.success) return null;

    const stored = response.data.session?.["terminalContent"];
    if (typeof stored === "string" && stored.length > 0) return stored;

    // Newest-first, so the first element is the latest assessment.
    const snapshot = response.data.riskAssessments?.[0]?.["codeSnapshot"];
    return typeof snapshot === "string" && snapshot.length > 0 ? snapshot : null;
  }

  return {
    terminate: (sessionId, requestId = randomUUID()) =>
      apply("terminate", sessionId, requestId),
    autoLock: (sessionId, requestId = randomUUID()) =>
      apply("autoLock", sessionId, requestId),
    autoClear: (sessionId, requestId = randomUUID()) =>
      apply("autoClear", sessionId, requestId),
    reactivate: (sessionId, requestId = randomUUID()) =>
      apply("reactivate", sessionId, requestId),

    workspaceToPreserve,

    async updateTerminalContent(sessionId, content, requestId = randomUUID(), options = {}) {
      // Content, not status: no transition is validated, but the session must exist,
      // because the store matches on `sessionId` and reports a no-op either way.
      const loaded = await readDurable(sessionId, requestId);
      if (!loaded.ok) return loaded.refusal;

      const current = statusOf(loaded.document);

      const written = await callMcpTool<{ success?: boolean; updated?: boolean }>(
        config,
        MCP_TOOL_NAMES.UPDATE_SESSION_TERMINAL_CONTENT,
        {
          sessionId,
          terminalContent: content,
          ...(options.expectedStatuses
            ? { expectedStatuses: [...options.expectedStatuses] }
            : {}),
          ...(options.onlyIfAbsent ? { onlyIfAbsent: true } : {}),
        },
        { requestId, timeoutMs: MCP_TIMEOUT_MS },
      );

      if (!written.ok || !written.data?.success) {
        return refused(
          SESSION_TRANSITION_CODES.SESSION_STORE_UNAVAILABLE,
          "The terminal content could not be persisted.",
          sessionId,
          current,
        );
      }

      // The status is unchanged by a content write, so both fields report what the
      // document holds. `applied` reports whether the write **happened**: with a gate
      // supplied, a document that failed the predicate matched nothing, and saying
      // `applied: true` for it would be the same lie the existence check removed.
      return {
        ok: true,
        applied: written.data.updated !== false,
        sessionId,
        status: current,
        previousStatus: current,
      };
    },
  };
}

/** A verb phrase for the refusal message, so it reads as a sentence. */
function describe(action: SessionAction): string {
  switch (action) {
    case "terminate":
      return "terminated again";
    case "autoLock":
      return "auto-locked";
    case "autoClear":
      return "auto-cleared";
    case "reactivate":
      return "reactivated";
  }
}

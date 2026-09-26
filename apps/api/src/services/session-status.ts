/**
 * The session status vocabulary, in one place.
 *
 * Three vocabularies were previously in play across two modules, and only one of
 * them is durable. Naming them explicitly is what lets the transition boundary
 * validate a requested transition against what the store can actually hold, rather
 * than against everything a response type happens to accept.
 *
 * ── The three vocabularies ────────────────────────────────────────────
 *
 *   DURABLE     what `monitored_sessions.status` may hold, and what
 *               `set_session_status` accepts. Three values.
 *
 *   PERSISTED   the union of the durable set and the review-facing set. Used by
 *               {@link normalizeStatus} so a value that arrived from an older
 *               document, a hand-edited record or a future build is mapped onto
 *               something known rather than propagated.
 *
 *   DERIVED     `flagged`, `investigating` and `cleared` are computed at read time
 *               by the review router and are never written. They are members of
 *               PERSISTED because a document could already hold one, not because
 *               anything produces them: `cleared` has no producer at all.
 *
 * Extracted from `routes/guardian.ts` so the transition boundary can import the
 * vocabulary without importing a route module, which would be a layering inversion
 * and a runtime import cycle. `guardian.ts` re-exports every name below, so existing
 * importers are unaffected.
 */

/**
 * Every status a session document may legitimately carry, durable or derived.
 *
 * This is the union of the review vocabulary and the MCP adapter's writable set, and
 * it deliberately includes `terminated`: a session recovered from MongoDB after a
 * restart must not be reported as live again.
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

/**
 * The statuses the durable store can hold.
 *
 * A strict subset of {@link PERSISTED_SESSION_STATUSES}: `set_session_status`
 * rejects anything else, so a transition boundary must validate against this set
 * rather than the wider one. A predicate that allowed `flagged` would be asking the
 * store to match a status it can never hold.
 */
export const DURABLE_SESSION_STATUSES = ["active", "locked", "terminated"] as const;

export type DurableSessionStatus = (typeof DURABLE_SESSION_STATUSES)[number];

/** True when `value` is a status the durable store can hold. */
export function isDurableStatus(value: string): value is DurableSessionStatus {
  return (DURABLE_SESSION_STATUSES as readonly string[]).includes(value);
}

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

/**
 * Stable client-facing codes for a refused or failed session transition.
 *
 * One meaning per code, and no internal detail: a caller can act on each of these,
 * and none of them describes *why* the store refused — only that it did.
 */
export const SESSION_TRANSITION_CODES = {
  /**
   * The requested transition is not in the table for the session's current status,
   * and the session is not terminal. A programming or client error.
   */
  INVALID_SESSION_TRANSITION: "INVALID_SESSION_TRANSITION",
  /**
   * The session is `terminated`, which is irreversible.
   *
   * Used by every action that would move a terminated session out of that state:
   * `reactivate`, `auto-lock`, `auto-clear`, and telemetry ingestion. One code for
   * one meaning — the session is terminal — rather than a code per action.
   */
  SESSION_TERMINAL: "SESSION_TERMINATED",
  /**
   * The durable status changed between the read and the write, so the transition was
   * applied to a state the caller did not see. The write did **not** happen.
   */
  SESSION_CONFLICT: "SESSION_CONFLICT",
  /** No session document matched. */
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  /** The persistence layer did not answer, or answered with a failure. */
  SESSION_STORE_UNAVAILABLE: "SESSION_STORE_UNAVAILABLE",
} as const;

export type SessionTransitionCode =
  (typeof SESSION_TRANSITION_CODES)[keyof typeof SESSION_TRANSITION_CODES];

/**
 * The HTTP status for each refusal code.
 *
 * `SESSION_TERMINAL` and `SESSION_CONFLICT` are 409: the request was well-formed and
 * the server understood it, but it conflicts with the resource's current state.
 * `SESSION_EXPIRED`, which the ingest path already returns for a closed monitoring
 * window, is also 409, so the two "this session will not accept that" answers agree.
 */
export const SESSION_TRANSITION_HTTP_STATUS: Record<SessionTransitionCode, number> = {
  [SESSION_TRANSITION_CODES.INVALID_SESSION_TRANSITION]: 409,
  [SESSION_TRANSITION_CODES.SESSION_TERMINAL]: 409,
  [SESSION_TRANSITION_CODES.SESSION_CONFLICT]: 409,
  [SESSION_TRANSITION_CODES.SESSION_NOT_FOUND]: 404,
  [SESSION_TRANSITION_CODES.SESSION_STORE_UNAVAILABLE]: 503,
};

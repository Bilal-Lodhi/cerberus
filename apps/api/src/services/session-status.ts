/**
 * The session status vocabulary, in one place.
 *
 * ── One vocabulary, not three ─────────────────────────────────────────
 *
 * Three vocabularies were previously in play across two modules, and only one of them was
 * durable. That is what let the same session report three different statuses from three
 * surfaces, and what let an unreachable state (`cleared`) sit in the vocabulary for two
 * releases.
 *
 * There is now **one** set of statuses a session document may carry: `active`, `locked`,
 * `terminated`. {@link DURABLE_SESSION_STATUSES} is what the store accepts and
 * {@link PERSISTED_SESSION_STATUSES} is what {@link normalizeStatus} may return; the two
 * are the same set on purpose.
 *
 * ── The derived values are not statuses ───────────────────────────────
 *
 * `flagged` and `investigating` are a **review disposition** — what the evidence suggests
 * — and they live in `SessionReviewResponse.disposition`, derived at read time by
 * `routes/review.ts`. Folding them into `status` made the review detail the only surface
 * reporting a derived value under the lifecycle name, and made the console display a
 * session as LOCKED when it was not. See
 * [read-model.md](../../../docs/development/read-model.md).
 *
 * `cleared` was a member of this vocabulary with **no producer at all**: nothing wrote it,
 * `set_session_status` never accepted it, and the one "clear" behaviour the product has —
 * lifting a lock when the score falls — produces `active`. It was removed rather than
 * given a producer, because giving it one would mean inventing a human review workflow to
 * justify an enum. See {@link LEGACY_DERIVED_SESSION_STATUSES}.
 *
 * Extracted from `routes/guardian.ts` so the transition boundary can import the
 * vocabulary without importing a route module, which would be a layering inversion and a
 * runtime import cycle. `guardian.ts` re-exports every name below, so existing importers
 * are unaffected.
 */

/**
 * Every status a session document may legitimately carry.
 *
 * Deliberately includes `terminated`: a session recovered from MongoDB after a restart
 * must not be reported as live again.
 */
export const PERSISTED_SESSION_STATUSES = ["active", "locked", "terminated"] as const;

export type PersistedSessionStatus = (typeof PERSISTED_SESSION_STATUSES)[number];

/**
 * The statuses the durable store can hold.
 *
 * The same set as {@link PERSISTED_SESSION_STATUSES}, named separately because the two
 * answer different questions: one is "what may a document carry", the other is "what will
 * `set_session_status` accept". A predicate that allowed anything else would be asking the
 * store to match a status it can never hold.
 */
export const DURABLE_SESSION_STATUSES = ["active", "locked", "terminated"] as const;

export type DurableSessionStatus = (typeof DURABLE_SESSION_STATUSES)[number];

/**
 * Values a **legacy or hand-edited** document may hold that are no longer statuses.
 *
 * Kept as a named list rather than deleted knowledge, so the mapping is explicit and
 * testable rather than implied by a fallback. {@link normalizeStatus} maps every one of
 * them onto `active`, which is:
 *
 *   - `cleared` — the state the product's one clear behaviour produces. Auto-clear lifts a
 *     lock and writes `active`, so the historical meaning of `cleared` **is** `active`.
 *     Nothing ever produced it and no document is known to hold it.
 *   - `flagged`, `investigating` — a review disposition, not a lifecycle state. They are
 *     reported under `SessionReviewResponse.disposition`, derived from the evidence, so
 *     mapping the status onto `active` loses nothing that was ever persisted.
 *
 * `active` is also what an entirely unrecognised value maps to, so a legacy document is
 * treated no differently from a corrupted one — which is the honest answer, since neither
 * is a state the system can reach.
 */
export const LEGACY_DERIVED_SESSION_STATUSES = [
  "flagged",
  "investigating",
  "cleared",
] as const;

export type LegacyDerivedSessionStatus =
  (typeof LEGACY_DERIVED_SESSION_STATUSES)[number];

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
 * Stable codes for a session **deletion**.
 *
 * Separate from the transition codes because a deletion is not a transition: it is
 * destructive, it cascades over three components, and it can partly succeed. Folding it
 * into the transition set would make one vocabulary describe two different kinds of
 * operation.
 */
export const SESSION_DELETION_CODES = {
  /**
   * The deletion ran and only part of it succeeded. The response names the components that
   * were removed and the ones that were not.
   *
   * Deliberately distinct from `SESSION_STORE_UNAVAILABLE`, which means the store did not
   * answer and **nothing was attempted**. A client that treats the two the same would
   * either retry an operation that never ran, or fail to retry one that half-ran.
   */
  PARTIAL_DELETE: "PARTIAL_DELETE",
} as const;

export type SessionDeletionCode =
  (typeof SESSION_DELETION_CODES)[keyof typeof SESSION_DELETION_CODES];


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

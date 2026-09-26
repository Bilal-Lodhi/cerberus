/**
 * The paid-operation claim: its vocabulary, its record shape, and the two indexes that
 * make it work.
 *
 * ── Why this module exists ────────────────────────────────────────────
 *
 * The claim is the whole of the mutual exclusion for a paid operation. It is a single
 * MongoDB document, and the thing that makes it exclusive is a **unique index** — not a
 * lock, not a lease service, not a transaction. That means the index is not an
 * optimisation: it *is* the correctness mechanism. Two API processes racing one
 * `Idempotency-Key` both attempt an insert, and exactly one is allowed to proceed
 * because the index refuses the second.
 *
 * ── Why the index specification lives in its own module ────────────────
 *
 * Both `MongoStore.ensureIndexes()` and migration `0004` create these indexes, and a
 * database is brought up to date by whichever of the two runs first. If the two declared
 * the specification separately they could drift, and a drift here is not cosmetic:
 * `createIndex` with the same key pattern but different options raises
 * `IndexOptionsConflict` (or `IndexKeySpecsConflict`), so the *second* one to run would
 * fail and the database would not start. Declaring the list once and having both callers
 * apply it makes that state unrepresentable.
 *
 * The TTL index uses `expireAfterSeconds: 0`, which means "delete the document when the
 * value of `expiresAt` is in the past". The retention window is therefore **data**, not
 * index configuration — so the index specification is a constant that can never need to
 * change, and a deployment that changes `CERBERUS_IDEMPOTENCY_TTL_SECONDS` changes only
 * the value written into each record.
 */

import type { Collection, Document } from "mongodb";

/**
 * The route families a claim may belong to.
 *
 * A key namespace per family, so the same `Idempotency-Key` used against two different
 * routes cannot collide. Without this, a key that a caller happened to reuse across
 * routes would be answered with the *other* route's result — or, worse, rejected as a
 * conflict for a request the caller never made against this route.
 */
export const PAID_ROUTE_FAMILIES = ["scenarios", "auditor"] as const;
export type PaidRouteFamily = (typeof PAID_ROUTE_FAMILIES)[number];

/**
 * The lifecycle of a claim.
 *
 * Deliberately three states. A claim is either being worked on, done, or failed; every
 * additional state would be one more thing a reader has to hold in their head, and the
 * distinction that actually matters — whether a failure may be retried — is carried by
 * the `retryable` flag on a `failed` record rather than by a fourth state.
 */
export const OPERATION_CLAIM_STATUSES = ["pending", "completed", "failed"] as const;
export type OperationClaimStatus = (typeof OPERATION_CLAIM_STATUSES)[number];

/** One index the claim collection depends on. */
export interface OperationClaimIndex {
  /** The key pattern, as MongoDB spells it. */
  key: Record<string, 1 | -1>;
  options: {
    unique?: boolean;
    expireAfterSeconds?: number;
  };
  /** Why the index is load-bearing, so a reader cannot mistake it for an optimisation. */
  why: string;
}

/**
 * The indexes `operation_claims` depends on.
 *
 * Applied by both `MongoStore.ensureIndexes()` and migration `0004`, from this one list.
 */
export const OPERATION_CLAIM_INDEXES: readonly OperationClaimIndex[] = [
  {
    key: { routeFamily: 1, keyHash: 1 },
    options: { unique: true },
    why:
      "the mutual exclusion: the first insert wins and every other writer gets E11000, " +
      "so two API processes cannot both execute one idempotency key. Without it a second " +
      "insert succeeds, both processes call the provider, and the duplicate spend this " +
      "collection exists to prevent happens silently",
  },
  {
    key: { expiresAt: 1 },
    options: { expireAfterSeconds: 0 },
    why:
      "bounds the collection: every record holds a caller-supplied key, so without a " +
      "retention sweep the collection grows with traffic and never shrinks. " +
      "`expireAfterSeconds: 0` means the deadline is the field's value, so the retention " +
      "window is data rather than index configuration",
  },
];

/**
 * Creates the claim indexes on `collection`.
 *
 * Idempotent for an identical specification, which is what makes it safe to call from
 * both the startup path and the migration. The collection is created implicitly if it
 * does not exist, so a database upgraded by the migration CLI alone already carries both
 * indexes before any API process starts.
 */
export async function ensureOperationClaimIndexes(
  collection: Collection<Document>,
): Promise<void> {
  for (const index of OPERATION_CLAIM_INDEXES) {
    await collection.createIndex(index.key, index.options);
  }
}

/**
 * A claim document.
 *
 * Every field is here for a reason a reader can check:
 *
 *   - `keyHash`, never the raw key. The record is a document an operator can dump, and a
 *     caller's key is not evidence. `sha256` is enough to find a record from a key and is
 *     not reversible.
 *   - `fingerprint` + `fingerprintVersion`. The fingerprint detects a key reused for a
 *     *different* request, and the version makes a future canonicalisation change a new
 *     version rather than a silent reinterpretation of records already written.
 *   - `claimId`. The ownership token. Completion and failure are conditional on it, so a
 *     process whose lease expired cannot overwrite a record a reclaimer now owns.
 *   - `leaseExpiresAt` versus `expiresAt`. Two different deadlines: the lease bounds how
 *     long a `pending` claim may block a retry, and `expiresAt` bounds how long the record
 *     exists at all. Conflating them would mean a retry could never proceed while the
 *     record was retained, or that a record vanished while its lease was still live.
 *   - `result` is the response to replay, not a reference to one. Neither paid route
 *     persists a result the replay could point at: the scenarios matrix is written
 *     best-effort and may not be there, and the auditor persists nothing.
 */
export interface OperationClaimRecord {
  routeFamily: PaidRouteFamily;
  keyHash: string;
  fingerprint: string;
  fingerprintVersion: number;
  status: OperationClaimStatus;
  claimId: string;
  createdAt: Date;
  updatedAt: Date;
  leaseExpiresAt: Date;
  expiresAt: Date;
  result?: { status: number; body: unknown };
  resultOmitted?: string;
  errorCategory?: string;
  retryable?: boolean;
}

/**
 * Fields that must never appear in a claim document.
 *
 * Exported as a list rather than left as a comment because it is asserted: a test writes
 * a maximal claim through the real store and greps the stored BSON for each of these.
 * A guarantee stated only in prose is a guarantee that drifts.
 */
export const OPERATION_CLAIM_FORBIDDEN_FIELDS = [
  "idempotencyKey",
  "apiKey",
  "token",
  "authorization",
  "prompt",
  "question",
] as const;

// ═══════════════════════════════════════════════════════════════════
// The claim protocol
// ═══════════════════════════════════════════════════════════════════

/** The response a completed — or definitively failed — operation replays. */
export interface PaidOperationResult {
  status: number;
  body: unknown;
}

/**
 * The two deadlines, and why they are derived rather than configured independently.
 *
 * The **lease** bounds how long a `pending` claim may block a retry. It must be longer than
 * the slowest possible provider call, or a healthy operation would have its lease expire
 * while the first process was still waiting and a second process would reclaim it and spend
 * again — a duplicate charge caused by a misconfiguration rather than by a crash.
 *
 * So it is derived from the provider timeout rather than set beside it:
 *
 *     lease = clamp(2 × providerTimeout + margin, MIN, MAX)
 *
 * The doubling covers the fact that a `/scenarios` operation runs **two** provider calls
 * back to back, each of which may take the full timeout; the margin covers the durable
 * round trips inside the operation. An operator who raises `OPENAI_REQUEST_TIMEOUT_MS` to
 * ten minutes therefore gets a twenty-minute lease without having to know this rule exists.
 *
 * `expiresAt` is separate and independent: it bounds how long the *record* exists, which is
 * a retention question rather than a concurrency one.
 */
export const MIN_LEASE_MS = 60_000;
export const MAX_LEASE_MS = 30 * 60_000;
export const LEASE_TIMEOUT_MULTIPLIER = 2;
export const LEASE_MARGIN_MS = 30_000;

/** The lease for a given provider timeout, clamped to the documented bounds. */
export function deriveLeaseMs(providerTimeoutMs: number): number {
  const usable =
    Number.isFinite(providerTimeoutMs) && providerTimeoutMs > 0 ? providerTimeoutMs : 180_000;
  const derived = usable * LEASE_TIMEOUT_MULTIPLIER + LEASE_MARGIN_MS;
  return Math.min(Math.max(Math.round(derived), MIN_LEASE_MS), MAX_LEASE_MS);
}

/** The default retention window, in seconds. One day: long enough for an ordinary retry. */
export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 86_400;
/** The shortest retention an operator may configure. One minute. */
export const MIN_IDEMPOTENCY_TTL_SECONDS = 60;
/** The longest. Seven days. */
export const MAX_IDEMPOTENCY_TTL_SECONDS = 604_800;

/**
 * The largest response body a completed claim will store, in bytes.
 *
 * The record exists so a retry can be answered without spending again, which means it has
 * to hold the response. Holding an *unbounded* response in a collection whose whole purpose
 * is bounded retention would be the one way this collection could grow without limit, so
 * there is a ceiling.
 *
 * The ceiling is defensive rather than reachable: the auditor caps its `raw` array at 200
 * records and its summary at 1 200 output tokens, and a test serialises a maximal payload
 * and asserts it lands far below this. The branch that handles an over-large result is
 * therefore a refusal that should never fire, and it is written to be truthful if it ever
 * does — the record is marked completed with `resultOmitted`, and a replay answers `503`
 * saying the prior result was too large to retain rather than silently re-executing.
 */
export const MAX_STORED_RESULT_BYTES = 4 * 1024 * 1024;

/**
 * Why an operation failed, as a stable category.
 *
 * A category, never a provider message: the record is on a path that handles
 * operator-authored content, and a provider's error text can quote the request. The
 * category is what an operator acts on, and it is what decides whether a retry may
 * re-execute.
 */
export const OPERATION_FAILURE_CATEGORIES = [
  /** The provider call did not complete: timeout, transport failure, 429 or 5xx. */
  "provider-unavailable",
  /** The provider answered with a definitive failure that produced nothing usable. */
  "provider-failed",
  /** The provider answered, and Cerberus could not record the result. */
  "result-persist-failed",
  /** The response was too large to retain for replay. */
  "result-too-large",
  /** The caller cancelled the operation, so it produced nothing. */
  "cancelled",
  /** The idempotency store itself could not be reached. */
  "state-unavailable",
] as const;
export type OperationFailureCategory = (typeof OPERATION_FAILURE_CATEGORIES)[number];

/**
 * The categories for which a same-key retry **re-executes**.
 *
 * `provider-unavailable` and `provider-failed` describe a call that did not produce a
 * usable result, so re-executing is the whole point of the retry.
 *
 * `result-persist-failed` and `result-too-large` describe the opposite: Cerberus **observed
 * the provider succeed** and then failed to record it. The money is already spent, so
 * re-executing would spend again on an operation that already ran. Those are recorded
 * `retryable: false` and replayed, and a caller who wants a different outcome uses a **new
 * key** — a deliberate act rather than a silent second charge.
 *
 * `state-unavailable` is not reachable through the claim path at all: if the store cannot
 * be reached, there is no record to mark and the route answers `503` with nothing claimed.
 */
export const RETRYABLE_FAILURE_CATEGORIES: readonly OperationFailureCategory[] = [
  "provider-unavailable",
  "provider-failed",
  "cancelled",
];

/** Whether a failure in `category` may be retried by re-executing the operation. */
export function isRetryableFailure(category: OperationFailureCategory): boolean {
  return RETRYABLE_FAILURE_CATEGORIES.includes(category);
}

/** The input to a claim. */
export interface ClaimPaidOperationInput {
  routeFamily: PaidRouteFamily;
  keyHash: string;
  fingerprint: string;
  fingerprintVersion: number;
  /** How long a `pending` claim blocks a retry. See {@link deriveLeaseMs}. */
  leaseMs: number;
  /** How long the record exists at all. */
  ttlMs: number;
}

/**
 * What a claim attempt produced.
 *
 * Five outcomes, and the route treats each differently. `conflict` and `pending` are
 * the two that must **never** be answered by calling the provider.
 */
export type PaidOperationClaimOutcome =
  | { outcome: "claimed"; claimId: string }
  | { outcome: "reclaimed"; claimId: string }
  | {
      outcome: "replay";
      state: "completed" | "failed";
      result: PaidOperationResult | null;
      resultOmitted?: string;
    }
  | { outcome: "pending"; retryAfterSeconds: number }
  | { outcome: "conflict" };

/** The input to a completion. */
export interface CompletePaidOperationInput {
  routeFamily: PaidRouteFamily;
  keyHash: string;
  claimId: string;
  result: PaidOperationResult;
  ttlMs: number;
  /**
   * Present only when the real result was too large to retain.
   *
   * The record is still `completed` — the operation did succeed — and `result` carries a
   * small, truthful substitute saying so. This field is what lets an operator tell that
   * apart from an ordinary replay.
   */
  resultOmitted?: string;
}

/** The input to a failure. */
export interface FailPaidOperationInput {
  routeFamily: PaidRouteFamily;
  keyHash: string;
  claimId: string;
  errorCategory: OperationFailureCategory;
  ttlMs: number;
  /**
   * The response to replay, required when the failure is **not** retryable.
   *
   * A non-retryable failure is one Cerberus observed the provider complete, so there is no
   * re-execution to offer and the only truthful answer to a same-key retry is the recorded
   * failure. A record that says "failed, do not retry" with nothing to replay would leave
   * the caller with no answer at all, so the store refuses to write one.
   */
  result?: PaidOperationResult;
}

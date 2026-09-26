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

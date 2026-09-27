/**
 * The live-list normal form, as a pure function of one session document.
 *
 * ── What this module is for ───────────────────────────────────────────
 *
 * `MongoStore.listSessions` reads **every** session document ever created and
 * `reconcileLiveList` then discards the terminated and expired ones
 * (`docs/development/read-path-performance.md`). Replacing that scan with a bounded,
 * index-backed query needs a predicate the server can evaluate, and
 * [live-list-equivalence-model.md](../../../docs/development/live-list-equivalence-model.md)
 * derives exactly which one:
 *
 * ```
 * Q = { d : d.sessionId ∈ L }                                     // the local rows' documents
 *   ∪ { d : status ∈ {active, locked} ∧ <live instant> > cutoff }  // everything else that is live
 * ```
 *
 * Nothing else in the document is consulted by the list. So the whole of the storage change
 * this cycle needs is two fields made total:
 *
 * | Field | Why |
 * | --- | --- |
 * | `status` | `normalizeStatus` maps a missing, `null`, unknown, case-variant or wrong-typed status onto `active`. A `status: { $in: ["active","locked"] }` filter would silently drop `"cleared"` and absent-status rows, which the current code lists. |
 * | `liveListUpdatedAt` | The current liveness rule is `updatedAt → deployedAt → createdAt → now`, and an **unparseable** value means "never expires". No stored timestamp expresses "never expires", and no filter on `updatedAt` alone sees the fallback chain. |
 *
 * ── What it deliberately does not do ─────────────────────────────────
 *
 * **It does not rewrite `updatedAt`.** The obvious simplification is to normalise
 * `updatedAt` into a `Date` and range-query it directly. That is wrong, and the model's §9.3
 * has the counterexample: the reconciler evaluates expiry through **two different branches**
 * (model §4.1). The durable-only branch falls through `updatedAt → deployedAt → createdAt →
 * now`; the local-row branch consults only `readDurableString(updatedAt)`, which refuses
 * anything that is not a non-empty string. For a document with no usable `updatedAt`, a recent
 * `deployedAt` and a local row whose own instant is stale, the current code **drops** the
 * session; after rewriting `updatedAt = deployedAt` the local row gains a durable candidate,
 * the maximum wins, and the session is **reported live**. Rewriting the field changes the
 * answer for exactly the malformed documents this cycle exists to be equivalent on.
 *
 * So the normalised instant goes in its own field, `updatedAt` and every other timestamp are
 * left exactly as they are, and the reconciler keeps disagreeing with itself in precisely the
 * way it disagrees today. §9.3 of the model is the argument; `liveListUpdatedAt` is the
 * consequence.
 *
 * **It never invents an instant.** When no truthful instant exists — `updatedAt`, `deployedAt`
 * and `createdAt` are all absent, or the first of them that is present cannot be parsed — the
 * document's durable-only verdict is "live, forever", because the chain's last resort is the
 * request instant and it is re-read on every list request. The only faithful representation of
 * that in one stored value is a sentinel above every real instant, so `MAX_LIVENESS_INSTANT`
 * stands for "no verifiable last-activity instant, conservatively never expires". Reading the
 * clock here would instead make such a row expire one TTL after the migration ran, which is a
 * different answer from the one the current code gives.
 *
 * ── Purity ────────────────────────────────────────────────────────────
 *
 * No database, no clock, no mutation. {@link planSessionListNormalisation} maps one document to
 * the values that document should hold, and is idempotent: feeding it a document it has
 * already normalised produces no further change. Both properties are what make the migration
 * re-runnable and what make the equivalence proof in this cycle a pure comparison.
 *
 * See `docs/development/live-list-equivalence-model.md` §5, §9.2, §9.3 and §10.
 */

import {
  SESSION_STATUSES,
  type SessionStatus,
} from "./tool-names.js";

/** The durable status vocabulary, as a set, so the normaliser cannot drift from it. */
const DURABLE_STATUS_SET: ReadonlySet<string> = new Set(SESSION_STATUSES);

/**
 * The status a document with no usable lifecycle value is treated as carrying.
 *
 * `active`, because that is what `normalizeStatus` in `apps/api/src/services/session-status.ts`
 * maps every unrecognised value onto — and the whole point of this module is to store the
 * value the reconciler would compute, not a different one.
 */
export const NORMALISED_DEFAULT_STATUS: SessionStatus = "active";

/**
 * The largest instant a BSON `Date` can hold, used as the "never expires" sentinel.
 *
 * `8640000000000000` is `new Date(8640000000000000).toISOString() ===
 * "+275760-09-13T00:00:00.000Z"` — the maximum representable time value. Any real `cutoff`
 * computes as `now - ttlSeconds * 1000` from a plausible clock, so
 * `sentinel > cutoff` holds for every representable `now`, which is exactly the semantics of
 * "an unreadable timestamp must not silently hide a session".
 *
 * The largest representable value is used rather than a large-looking literal such as
 * `9999-12-31`: a constant that a future clock could overtake would turn a documented
 * invariant into a time bomb.
 */
export const MAX_LIVENESS_INSTANT = 8_640_000_000_000_000;

/** Which link of the timestamp chain supplied a document's instant. */
export type LivenessInstantSource =
  | "updatedAt"
  | "deployedAt"
  | "createdAt"
  | "unverifiable";

/** What one document should hold. Both fields are `null` when nothing needs to change. */
export interface SessionListNormalisation {
  /**
   * The status to **write**, or `null` when the stored value is already the normalised one.
   *
   * `null` cannot mean "store no status": the target of this normalisation is a total status,
   * so an absent status is always written. It means "no write needed".
   */
  status: SessionStatus | null;
  /**
   * The instant to **write**, or `null` when the stored value already is it.
   *
   * `null` is never a target value, for the same reason as {@link status}.
   */
  liveListUpdatedAt: Date | null;
  /** Where {@link liveListUpdatedAt} came from, for the migration's accounting. */
  source: LivenessInstantSource;
  /** True when the stored status was absent or `null` rather than present-but-unrecognised. */
  statusWasMissing: boolean;
}

/**
 * Parses one candidate value from the timestamp chain into an instant, or `null`.
 *
 * ── Why a `Date` is not parsed through `String()` ─────────────────────
 *
 * The rule this mirrors is the reconciler's, and the reconciler sees a document that has been
 * through `JSON.stringify` on its way out of the MCP adapter. A BSON `Date` therefore reaches
 * it as a **millisecond-precise ISO string**, and the instant is exact. `String(date)` — which
 * is what the reconciler does to the *fallback* chain — renders a date without milliseconds,
 * so parsing that would truncate to the second and place a document up to 999 ms early.
 *
 * Migration reads BSON documents, so a `Date` here is a real one and its exact instant is the
 * truthful value; using `getTime()` is what makes the migration agree with the wire path the
 * reconciler actually sees. Model §5.1 records the truncation that makes this necessary, and
 * `apps/api/test/live-list-current-semantics.test.ts` demonstrates it.
 *
 * Every other type is stringified before parsing, because that is what the current code does:
 * `String(123)` is `"123"`, which `Date.parse` accepts as a legacy year-12 instant, and
 * `String([1,2])` is `"1,2"`, which it accepts as year 2001. A predicate that special-cased
 * "not a date, therefore unusable" would disagree with the reconciler on both.
 */
export function parseLivenessValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }

  const parsed = Date.parse(typeof value === "string" ? value : String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The instant a document's liveness is judged by, and which chain link supplied it.
 *
 * `null` means **no truthful instant exists**, which the reconciler treats as "never expires"
 * (model §5.1 cases C3 and C4). That happens in two ways, and both must reach the sentinel:
 *
 *   - none of `updatedAt`, `deployedAt` and `createdAt` is present at all, so the chain's last
 *     resort — the request instant — is used and the row is live at every instant; or
 *   - the **first** present value cannot be parsed, so `isExpired` finds no usable candidate
 *     and returns `false` forever.
 *
 * Note the `??`-equivalent selection: the chain stops at the first value that is **present**,
 * not the first that parses. A document whose `deployedAt` is `""` has `createdAt` ignored,
 * even when `createdAt` is a perfectly good recent instant.
 */
export function readLivenessInstant(
  document: Record<string, unknown>,
): { instant: number | null; source: LivenessInstantSource } {
  const candidates: ReadonlyArray<[string, LivenessInstantSource]> = [
    ["updatedAt", "updatedAt"],
    ["deployedAt", "deployedAt"],
    ["createdAt", "createdAt"],
  ];

  for (const [field, source] of candidates) {
    const value = document[field];
    // `??`: an absent field and an explicit `null` are the same thing to the reconciler, and
    // both let the chain continue.
    if (value === null || value === undefined) continue;

    return { instant: parseLivenessValue(value), source };
  }

  return { instant: null, source: "unverifiable" };
}

/**
 * The status the reconciler would compute for `document`.
 *
 * A deliberate re-implementation of `normalizeStatus(String(d.status ?? "active"))` rather
 * than an import: `packages/mcp-mongodb` does not depend on `apps/api`, and a storage-layer
 * module that reached into the API's service tree would invert the layering the API's own
 * `session-status.ts` was extracted to protect. `apps/api/test/live-list-normalisation.test.ts`
 * asserts the two agree on every case in the model's table, which is the cheap direction of
 * that dependency.
 */
export function normalisedStatusOf(value: unknown): SessionStatus {
  if (typeof value !== "string") return NORMALISED_DEFAULT_STATUS;
  return DURABLE_STATUS_SET.has(value) ? (value as SessionStatus) : NORMALISED_DEFAULT_STATUS;
}

/** True when `value` is absent or `null`, i.e. the status was never written. */
function isMissing(value: unknown): boolean {
  return value === null || value === undefined;
}

/** True when the stored instant already is `target`, to the millisecond and in type. */
function alreadyHoldsInstant(value: unknown, target: number): boolean {
  return value instanceof Date && value.getTime() === target;
}

/**
 * Plans the normal form of one session document.
 *
 * Pure, idempotent and total: every document has exactly one plan, and the plan for a document
 * that already holds its normal form is "change nothing" in both fields.
 *
 * The migration applies the plan; nothing here writes. Keeping the decision in a pure function
 * is what makes the dry run's accounting exact rather than an estimate, and what lets the
 * equivalence proof compare *intended changes* against the reconciler without a database.
 */
export function planSessionListNormalisation(
  document: Record<string, unknown>,
): SessionListNormalisation {
  const storedStatus = document["status"];
  const statusWasMissing = isMissing(storedStatus);
  const status = normalisedStatusOf(storedStatus);

  // Only write when the stored value is not already exactly the normalised one. Comparing the
  // **value**, not the stringified form, is what keeps `status: "active"` untouched while
  // `status: 42` and `status: null` are rewritten.
  const statusWrite = storedStatus === status ? null : status;

  const { instant, source } = readLivenessInstant(document);
  const targetInstant = instant ?? MAX_LIVENESS_INSTANT;
  const instantWrite = alreadyHoldsInstant(document["liveListUpdatedAt"], targetInstant)
    ? null
    : new Date(targetInstant);

  return {
    status: statusWrite,
    liveListUpdatedAt: instantWrite,
    // Reported as "unverifiable" whenever there is no instant, whichever link failed to supply
    // one: the accounting question is "which documents are conservatively kept live", and a
    // document whose `deployedAt` is an empty string belongs to that set just as much as one
    // with no timestamps at all. Which link was consulted is still available from
    // `readLivenessInstant`, which is what the chain-link assertions use.
    source: instant === null ? "unverifiable" : source,
    statusWasMissing,
  };
}

/** True when applying `plan` would write something. */
export function planChangesDocument(plan: SessionListNormalisation): boolean {
  return plan.status !== null || plan.liveListUpdatedAt !== null;
}

/**
 * The `$set` document for a plan, or `null` when the plan writes nothing.
 *
 * Built here rather than at the call site so the migration and its tests cannot disagree about
 * what a plan means.
 */
export function buildSessionListUpdate(
  plan: SessionListNormalisation,
): Record<string, unknown> | null {
  const set: Record<string, unknown> = {};
  if (plan.status !== null) set["status"] = plan.status;
  if (plan.liveListUpdatedAt !== null) set["liveListUpdatedAt"] = plan.liveListUpdatedAt;
  return Object.keys(set).length > 0 ? { $set: set } : null;
}

/**
 * The filter that matches a document **only while the fields its plan was computed from are
 * unchanged**.
 *
 * Without it the migration's write is last-writer-wins, and a migration that lost that race
 * would do something worse than nothing: it would write a status and an instant computed from a
 * state the document no longer holds, overwriting a concurrent lifecycle transition with a
 * stale normalisation. The migration is not the authority on a session's status — only on the
 * *form* of the value.
 *
 * With it the write is a compare-and-set on exactly the inputs the decision used, so a document
 * that changed underneath the scan is left alone. That is not a loss: a session the application
 * has just written carries a `Date` `updatedAt`, which the bounded query's own `updatedAt`
 * branch covers while it is live, so it is listed correctly whether or not migration reached it.
 *
 * `_id` is always part of the filter, and an absent field is matched with `$exists: false`
 * rather than with `null`, because MongoDB's `{ field: null }` also matches a document where the
 * field is missing — which would let a document that gained a status after the scan be matched
 * by a filter that meant "it had none".
 */
export function buildSessionListGuard(
  document: Record<string, unknown>,
  plan: SessionListNormalisation,
): Record<string, unknown> {
  const filter: Record<string, unknown> = { _id: document["_id"] };

  if (plan.status !== null) {
    const stored = document["status"];
    filter["status"] = stored === undefined ? { $exists: false } : stored;
  }

  if (plan.liveListUpdatedAt !== null) {
    const stored = document["liveListUpdatedAt"];
    filter["liveListUpdatedAt"] = stored === undefined ? { $exists: false } : stored;
  }

  return filter;
}

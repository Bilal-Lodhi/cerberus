/**
 * The bounded live-list query: the indexes it depends on.
 *
 * ── Why this module exists ────────────────────────────────────────────
 *
 * The live session list has always read **every** session document ever created and discarded
 * the terminated and expired ones in JavaScript (`MongoStore.listSessions` → `find({})`). At
 * 5 020 stored sessions that is a 75 ms p50 on a loopback `mongod`
 * (`docs/development/read-path-performance.md`), and it grows with history rather than with the
 * number of sessions actually being monitored.
 *
 * [live-list-equivalence-model.md](../../../docs/development/live-list-equivalence-model.md)
 * derives what a bounded replacement has to return, and §10.1 states the predicate. This module
 * holds the **index specification that predicate needs**, in one place, so that:
 *
 *   - `MongoStore.ensureIndexes()` applies it;
 *   - `scripts/release/critical-indexes.json` declares it, and the restore script verifies a
 *     restore preserved it;
 *   - `apps/api/test/release/critical-indexes.test.ts` asserts both directions against a real
 *     database — the list names no index the product does not create, and the product creates no
 *     live-list index the list omits.
 *
 * That last property is the reason the specification is shared rather than repeated. Two
 * declarations of one index drift, and a drifted declaration is not a missing index — it is a
 * *differently shaped* index, which a restore check would report as present while the query it
 * was built for stopped using it.
 *
 * ── Why the status test is `$ne: "terminated"` ────────────────────────
 *
 * `v0.6.1`'s release notes recorded that "monitored" is `$ne: "terminated"` — "which is not an
 * index-friendly predicate, and any conservative `$or` branch covering the legacy values forces
 * the collection scan the change exists to remove". That was true of the *shape* they were
 * considering, and it is not true of this one. Two facts make it affordable:
 *
 *   1. **`$ne: "terminated"` is exactly the reconciler's rule.** `isMonitored` is
 *      `status !== "terminated"` and `normalizeStatus` maps everything unrecognised onto
 *      `active`, so "not terminal after normalisation" and "not the exact string `terminated`"
 *      are the same condition. Nothing has to be enumerated, and no legacy value can be missed.
 *   2. **MongoDB serves it as a multi-range index scan, not a collection scan.** With a
 *      `status` prefix, `$ne` becomes the bounds `[MinKey, "terminated")` ∪
 *      `("terminated", MaxKey]`, which excludes the terminated bucket — usually the largest one
 *      in a real deployment — and includes the `null` bucket, where a document with *no* status
 *      is indexed. Measured in `apps/api/test/release/live-list-query-plan.test.ts`.
 *
 * ── Why two indexes ───────────────────────────────────────────────────
 *
 * The predicate ranges over two **different** fields, and the branches are alternatives rather
 * than a conjunction, so one index cannot serve both:
 *
 * ```
 * { status: { $ne: "terminated" }, liveListUpdatedAt: { $gt: cutoff } }
 * { status: { $ne: "terminated" }, updatedAt:         { $gt: cutoff } }
 * ```
 *
 * The second is what makes the query correct and bounded for every document Cerberus has ever
 * written, all of which carry a BSON `Date` `updatedAt` — including a document written by an
 * older process after the migration ran, and including every document in a database the
 * migration has not reached. It is also why **no application write has to maintain a derived
 * field** for a live session to stay on the list.
 *
 * The first covers the documents whose `updatedAt` is not a `Date` — absent, `null`, a
 * hand-edited string, or a value `Date.parse` cannot read. A range query on `updatedAt` cannot
 * see those at all, because MongoDB compares within a BSON type bracket; migration `0005` gives
 * each of them a `liveListUpdatedAt` precisely so this branch can.
 *
 * A single index cannot serve both: a compound `{ status, updatedAt, liveListUpdatedAt }` is
 * usable only when `updatedAt` is constrained, which is exactly what the first branch does not
 * do.
 *
 * ── What is deliberately *not* in the filter ──────────────────────────
 *
 * There is no branch for "a document with no `liveListUpdatedAt` at all". Such a document exists
 * only in a database the migration has not classified, and a branch covering it could not carry
 * a status prefix — which would leave the whole query a collection scan, measured rather than
 * assumed. Instead the **store** decides, once, from the migration ledger: when every known
 * migration is applied it applies this filter, and when one is pending it reads the collection
 * exactly as the previous build did and says so. Correctness therefore never depends on an
 * operator having migrated; only the cost does. See `docs/operations/upgrade.md`.
 */

import type { Collection, Document } from "mongodb";

/** One index the bounded live-list query depends on. */
export interface LiveListIndexSpec {
  /**
   * The index's name.
   *
   * Named rather than left to the server's derivation so that a query plan can be asserted to
   * have used *this* index. An unnamed `{ status: 1, updatedAt: -1 }` reports as
   * `status_1_updatedAt_-1`, which is a description rather than an identity — and two indexes
   * with the same key and different options are different indexes.
   */
  name: string;
  /** The key pattern, as `createIndex` takes it. */
  key: Record<string, 1 | -1>;
  /** Why a restore must preserve it. Read by operators, so it is a sentence, not a label. */
  why: string;
}

/**
 * Every index the bounded live-list query depends on.
 *
 * Append-only in practice: an index named here is verified after every restore, so removing one
 * silently turns that verification into a check for an index nothing creates.
 */
export const LIVE_LIST_INDEXES: readonly LiveListIndexSpec[] = [
  {
    name: "live_list_status_updated_at",
    key: { status: 1, updatedAt: -1 },
    why:
      "the live-list recency branch (status in {active, locked} and updatedAt > cutoff); " +
      "without it the bounded list falls back to reading every session document ever created",
  },
  {
    name: "live_list_status_liveness",
    key: { status: 1, liveListUpdatedAt: -1 },
    why:
      "the live-list branch for documents whose updatedAt is not a BSON Date — absent, null, " +
      "a hand-edited string, or an unparseable value — which a range query on updatedAt cannot " +
      "see at all; migration 0005 derives this field for exactly those documents",
  },
];

/**
 * Creates the live-list indexes, idempotently.
 *
 * `createIndex` is idempotent for an identical specification, so this is safe on every
 * `connect()`. It is called by `MongoStore.ensureIndexes()` rather than by migration `0005`,
 * because the index is not a data repair: an operator who migrates and never starts a service
 * still gets it from the migration CLI's own `ensureIndexes()` call, and one who starts a
 * service gets it from `connect()`.
 */
export async function ensureLiveListIndexes(
  collection: Collection<Document>,
): Promise<void> {
  for (const index of LIVE_LIST_INDEXES) {
    await collection.createIndex(index.key, { name: index.name });
  }
}

// ═══════════════════════════════════════════════════════════════════
// The predicate
// ═══════════════════════════════════════════════════════════════════

/**
 * What the caller knows that the query needs.
 */
export interface LiveListQueryInput {
  /**
   * The instant a document's liveness is measured against: a candidate is one whose activity
   * instant is **strictly after** this.
   *
   * `null` means expiry is disabled — `SESSION_TTL_SECONDS` non-positive or non-finite — in
   * which case no session ever expires and the live set is every non-terminated session ever
   * created. That is genuinely unbounded, so the query says so rather than pretending otherwise.
   */
  liveAfter: Date | null;
  /**
   * Sessions this process holds in memory, whose documents must be returned **whatever their
   * liveness**.
   *
   * This is not an optimisation. A local row whose durable document is `terminated`, or expired
   * under the local-row rule, has to be *seen* so the reconciler can drop it; if the query
   * omitted it the reconciler would treat the session as having no document at all and answer
   * from this process's cache — republishing a terminated session as live. Model §9.1.
   */
  sessionIds?: readonly string[];
}

/**
 * The cutoff a request's expiry comparison uses, or `null` when expiry is disabled.
 *
 * The same arithmetic `isExpired` performs: `now - ttlSeconds * 1000`. Kept here so the query
 * and the reconciler cannot disagree about where the boundary is — the reconciler's comparison
 * is `>=`, so a document is **live** exactly when its instant is strictly greater than this.
 */
export function liveListCutoff(nowMs: number, ttlSeconds: number): Date | null {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return null;
  return new Date(nowMs - ttlSeconds * 1000);
}

/**
 * The filter the bounded live-list query evaluates.
 *
 * ── The branches, and why each is necessary ───────────────────────────
 *
 * | Branch | Covers |
 * | --- | --- |
 * | `sessionId ∈ L` | the documents of this process's local rows, whatever they say |
 * | `status ≠ terminated ∧ liveListUpdatedAt > cutoff` | every document migration `0005` classified, judged by the instant it derived |
 * | `status ≠ terminated ∧ updatedAt > cutoff` | every document with a BSON `Date` `updatedAt` — which is every document Cerberus has written, migrated or not |
 *
 * Over-selecting is safe and under-selecting is not: a document the filter returns that is not
 * live is one the reconciler already had and drops, while a live document the filter omits is a
 * session that silently disappears from the dashboard. So each branch is written to be a
 * **superset** of what it must cover, and neither filters on anything the reconciler would decide
 * differently.
 *
 * `null` is returned when there is nothing to narrow: with expiry disabled the live set is every
 * non-terminated session ever created, which is genuinely unbounded. The caller reads the
 * collection then, and says so.
 */
export function buildLiveListFilter(
  input: LiveListQueryInput,
): Record<string, unknown> | null {
  const localIds = (input.sessionIds ?? []).filter(
    (sessionId) => typeof sessionId === "string" && sessionId.length > 0,
  );

  const branches: Record<string, unknown>[] = [];

  if (localIds.length > 0) {
    branches.push({ sessionId: { $in: [...localIds] } });
  }

  // `$ne: "terminated"` and not `$in: ["active", "locked"]`: the two are the same condition —
  // `normalizeStatus` maps everything else onto `active` — but only this one matches a document
  // whose status is absent, `null`, or a value no version of the vocabulary ever held, which the
  // reconciler reports as `active`. It is index-served as two ranges around the excluded value.
  const monitored = { $ne: "terminated" } as const;

  if (input.liveAfter === null) {
    // Expiry disabled: every non-terminated session is live, so the status is the only thing that
    // narrows the read.
    branches.push({ status: monitored });
  } else {
    const cutoff = input.liveAfter;
    branches.push({ status: monitored, liveListUpdatedAt: { $gt: cutoff } });
    branches.push({ status: monitored, updatedAt: { $gt: cutoff } });
  }

  if (branches.length === 0) return null;
  if (branches.length === 1) return branches[0]!;
  return { $or: branches };
}

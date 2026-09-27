# The live-list equivalence model

What the live session list **does today**, written down before anything about it is changed.

```
GET /api/v1/guardian/sessions   ->   localLiveSessions()
                                     + one unbounded list_sessions call
                                     + reconcileLiveList()
```

This document is the **pre-migration truth**. It describes the semantics that
`MongoStore.listSessions` (`find({})`) and `reconcileLiveList` produce together, case by
case, including the legacy and malformed documents a real deployment accumulates. Every
statement below is derived from the code named beside it, and every case is pinned by
`apps/api/test/live-list-current-semantics.test.ts`, which fails if the described behaviour
stops being the behaviour.

It exists because the cycle it precedes replaces one half of that pipeline — the
`find({})` — with a bounded, index-backed query, and a replacement is only safe if the
thing being replaced is specified precisely enough to be compared against. "It looks
equivalent on healthy documents" is not a specification.

---

## 1. Vocabulary and the one rule that matters

Four words are used here with exactly one meaning each:

| Word | Meaning | Source |
| --- | --- | --- |
| **status** | the durable lifecycle value: `active`, `locked`, `terminated` | `apps/api/src/services/session-status.ts` |
| **liveness** | `active` or `expired` — *derived*, never persisted | `apps/api/src/services/session-liveness.ts` |
| **local row** | a session this process holds in `sessionStore` or `activeSessions` | `apps/api/src/routes/guardian.ts` `localLiveSessions()` |
| **durable document** | a `monitored_sessions` document returned by `list_sessions` | `packages/mcp-mongodb/src/mongo-client.ts` `listSessions()` |

The list is a **merge of two sources**, and the rule that governs the merge is:

> **Durable wins wherever the durable document answers.**

A local row is a cache. It is consulted only for the fields a single process can answer
(the reconstructed workspace, the latest risk payload, `ephemeralAvailable`) and for
identity when the document does not carry it. Every decision about *whether a session is on
the list at all* is made from the durable document when one exists.

### Notation

Fixed for the rest of this document, at one evaluation instant:

| Symbol | Meaning |
| --- | --- |
| `T` | the request instant, `clock.now()` in epoch ms — **injected**, never `Date.now()` inside the reconciler |
| `ttlSeconds` | `SESSION_TTL_SECONDS`; expiry is **disabled** when it is non-finite or `<= 0` |
| `cutoff` | `T - ttlSeconds * 1000` |
| `D` | the set of documents `list_sessions` returns, in `createdAt: -1` order |
| `L` | the set of local rows this process holds |
| `d` | one durable document |
| `String(x)` | JavaScript's `String()`, applied to whatever BSON/JSON value is present |

---

## 2. What the API actually receives

`MongoStore.listSessions` projects a **fixed field set** and sorts:

```js
find({}, { projection: { sessionId, employeeId, auditId, matrixId, targetSystem, status,
                         eventCount, pasteCount, tabSwitchCount, focusLossCount,
                         fullscreenExitCount, copyAttemptCount,
                         peakRiskScore, overallRiskScore, riskIndex,
                         deployedAt, createdAt, updatedAt, _id: 0 } })
  .sort({ createdAt: -1 })
```

Two consequences are load-bearing:

1. **A field outside that projection is invisible to the list**, whatever it holds. The
   list predicate can only ever be a function of the fields above.
2. **BSON `Date` values arrive at the API as ISO-8601 strings.** The route reaches the
   store through the MCP HTTP adapter, whose `sendJson` is `JSON.stringify`; a `Date` has
   no JSON representation other than its ISO string. `createSession` and every session
   mutation write `updatedAt`, `createdAt` and `deployedAt` as `new Date()`, so **in
   production the list sees ISO strings, not `Date` objects.**

That second fact is the origin of §5's asymmetry, and it is why this document separates the
*wire* value from the *stored* value everywhere.

---

## 3. Status: `normalizeStatus`

```
readDurableSessionView:  status = normalizeStatus(String(d.status ?? "active"))
```

`normalizeStatus` returns its input when it is one of `active | locked | terminated`, and
`"active"` otherwise (`session-status.ts`). The truth table is therefore small and total:

| `d.status` as the API sees it | `String(d.status ?? "active")` | normalised |
| --- | --- | --- |
| `"active"` | `"active"` | `active` |
| `"locked"` | `"locked"` | `locked` |
| `"terminated"` | `"terminated"` | `terminated` |
| absent (`undefined`) | `"active"` | `active` |
| `null` | `"active"` (via `??`) | `active` |
| `""` | `""` | `active` |
| `"flagged"` | `"flagged"` | `active` |
| `"investigating"` | `"investigating"` | `active` |
| `"cleared"` | `"cleared"` | `active` |
| `"Flagged"`, `"TERMINATED"` | unchanged | `active` |
| any other string | unchanged | `active` |
| `5`, `true`, `{}`, `[]` | `"5"`, `"true"`, `"[object Object]"`, `""` | `active` |

**The single most important row is `"TERMINATED"`.** Case matters. A document whose status
is `"Terminated"` is **not** terminal: it normalises to `active` and is reported live. Any
replacement predicate that matches on a case-insensitive or prefix form of `terminated`
would change the answer for that document.

`isMonitored(status)` is `status !== "terminated"`, so `active` and `locked` are the two
live statuses and everything unknown has already become `active` by this point.

**Status is idempotent under normalisation:** `normalizeStatus(normalizeStatus(x)) ==
normalizeStatus(x)` for every `x`. This is why a migration may rewrite a stored status into
the durable domain without changing any decision the reconciler makes — a fact §9 depends on.

---

## 4. Expiry: `isExpired`

```
isExpired(activity, ttlSeconds, clock):
  ttlSeconds non-finite or <= 0   -> false            (expiry disabled)
  candidates = [parse(activity.lastActivityAt), parse(activity.persistedUpdatedAt)]
  usable     = candidates that are finite, non-null
  usable empty                    -> false            (not expired)
  last       = min(max(usable), T)
  return (T - last) >= ttlSeconds * 1000
```

with `parse(x)` = `null` unless `x` is a non-empty string whose `Date.parse` is finite
(`parseTimestampMs`).

Three properties:

* **A non-empty string is the only accepted input.** A `Date` object is not a string, and
  numbers, booleans, arrays and objects are not strings either.
* **An unreadable timestamp is not expired.** This is deliberate and documented in
  `session-liveness.ts`: "an unreadable timestamp must not silently hide a session".
* **The comparison is `>=` against the TTL**, so a session is expired exactly at, and one
  millisecond past, `cutoff`. The boundary is inclusive on the *expired* side; equivalently,
  **live means `last > cutoff`**, strictly.

Because the clock is injected and the arithmetic is absolute epoch milliseconds, the
boundary is timezone-independent: `2026-06-04T08:22:36.123+05:00` and
`2026-06-04T03:22:36.123Z` are the same instant and compare equal.

### 4.1 The two call sites do not use the same durable input

This is the crux of the whole document. The reconciler evaluates expiry for a document in
**two different branches**, and the durable contribution differs between them.

| Branch | The durable value used | Read by |
| --- | --- | --- |
| **Durable-only** — the document's session is *not* in this process's memory | `d.updatedAt ?? d.deployedAt ?? d.createdAt ?? toISOStringLocal()`, then `String(...)` | `readDurableSessionView` -> `view.lastActivityAt` -> `persistedUpdatedAt` |
| **Local row** — the document's session *is* in this process's memory | `readDurableString(d, "updatedAt")` — `null` unless `d.updatedAt` is a **non-empty string** | `readDurableString` -> `persistedUpdatedAt`, beside the local `lastActivityAt` |

`readDurableString` has no fallback chain. The durable-only branch does. So the same
document can be judged by different timestamps depending on whether *this* process happens
to hold the session — and for a document with no usable `updatedAt`, the durable-only branch
falls through to `deployedAt`/`createdAt`/now while the local row falls back to nothing at
all.

**This asymmetry is a documented fact of the current semantics, not a defect to be fixed
here.** §9 shows that any attempt to "tidy" it by rewriting `updatedAt` into a `Date`
changes the answer for exactly these documents, which is why the replacement design in this
cycle does not touch `updatedAt` at all.

---

## 5. The timestamp chain, case by case

`tsString(d) = String(d.updatedAt ?? d.deployedAt ?? d.createdAt ?? toISOStringLocal())`

Note the `??`: it selects the first **non-nullish** value, *not* the first parseable one. A
present-but-garbage `d.deployedAt` therefore **blocks** `d.createdAt` from ever being
consulted.

Let `P = parse(tsString(d))`.

| # | `updatedAt` | `tsString(d)` | `P` | Durable-only verdict | Local-row durable contribution |
| --- | --- | --- | --- | --- | --- |
| U1 | ISO string (the wire form of a `Date`) | the string | the instant | expires at that instant | `readDurableString` returns it; parsed, same instant |
| U2 | absent | `String(deployedAt ?? createdAt ?? now)` | deployedAt / createdAt / now | expires at that instant | `null` — **contributes nothing** |
| U3 | `null` | same as U2 | same | same as U2 | `null` — contributes nothing |
| U4 | `""` | `""` (non-nullish, so it wins) | `null` | **never expires** | `null` (length 0) — contributes nothing |
| U5 | unparseable string | the string | `null` | **never expires** | the string, but `parse` is `null` — contributes nothing |
| U6 | number, e.g. `1700000000000` | `"1700000000000"` | `null` | **never expires** | `null` (not a string) — contributes nothing |
| U7 | number that *parses*, e.g. `123` | `"123"` | `-58285715292000` (a legacy ms value V8 accepts!) | expires at that absurd instant — i.e. always expired | `null` (not a string) — contributes nothing |
| U8 | `true` / `false` | `"true"` / `"false"` | `null` | **never expires** | `null` — contributes nothing |
| U9 | object or array, e.g. `[1,2]` | `"[object Object]"` / `"1,2"` | `null` / a parsed instant | never expires / expires | `null` — contributes nothing |

U7 and U9 are not hypothetical tidiness: V8's `Date.parse` accepts `"123"` and `"1,2"` as
legacy date formats. A predicate that special-cased "looks like a number, therefore
unparseable" would disagree with the reconciler on exactly those documents.

### 5.1 `updatedAt` is not the only input

| # | Case | Effect |
| --- | --- | --- |
| C1 | `deployedAt` a valid ISO string | `deployedAt` field of the row; and the U2/U3 fallback instant |
| C2 | `deployedAt` absent, `createdAt` valid | `readDurableSessionView` falls back to `createdAt`; so does the U2/U3 chain |
| C3 | `deployedAt` present but unparseable (`""`, `"n/a"`) | it is **non-nullish**, so the chain stops there; `createdAt` is ignored; the row is **permanently live** in the durable-only branch |
| C4 | both absent | `toISOStringLocal()` — **the request instant**, recomputed on every read. The row is therefore live at every instant: `T - min(now, T) == 0` |
| C5 | `createdAt` invalid | only matters for ordering (§7) and for the U2/U3 chain when `deployedAt` is nullish |

**C3 and C4 are the "no truthful instant" rows.** Their durable-only verdict is *live,
forever*, and it is not expressible as a fixed persisted timestamp: a stored `Date` becomes
older than `cutoff` eventually, while these rows are re-dated to `now` on every read. §9
shows how the replacement predicate keeps them live without inventing a timestamp.

Also note the **sub-second asymmetry**, which is measured rather than assumed. For a *raw*
BSON `Date` (no JSON round trip) the durable-only branch does `String(date)` and gets
`Sun Mar 01 2026 10:59:59 GMT+0500 (… )` — **no milliseconds** — so `Date.parse` returns the
instant truncated to the second, up to 999 ms early. Through the production JSON path the ISO
string keeps milliseconds and the instant is exact.

The consequence is narrow and demonstrable: of the whole adversarial fixture, exactly one row
changes verdict between the two paths, and it is the row placed **one millisecond inside the
cutoff**. Truncating it to the second moves it onto the cutoff, where `isExpired`'s `>=` makes
it expired, so the raw path drops a session the wire path lists. No other row in the fixture
differs, because the truncation can only matter within one second of the boundary.
`apps/api/test/live-list-current-semantics.test.ts` asserts that single difference and that it
is the *only* one, so this document, and every equivalence fixture in this cycle, models the
**JSON path** — the path a deployment takes.

---

## 6. The two drop rules

A session the durable document knows about is removed from the response for exactly two
reasons (`LiveDropReason`):

| Reason | Condition | Order |
| --- | --- | --- |
| `terminated` | `normalizeStatus(...) == "terminated"` | evaluated **first** |
| `expired` | `isExpired(...)` holds on the branch's inputs | only if not terminated |

Status is checked first, so a terminated session is never reported as expired. Both are
computed from the durable document for a session the durable store knows about, and from
local state only for a local row with **no** durable document.

`dropped` is **not returned by the route**. It is used for one debug log line
(`droppedNotLive: reconciliation.dropped.length`). The response body is `{ success: true,
data: reconciliation.sessions, reconciled }`.

---

## 7. Ordering

Three ordering rules apply in sequence, and only the last one is a contract:

1. **Store order.** `list_sessions` sorts by `createdAt: -1`. A missing `createdAt` sorts as
   BSON `null`, which is below every date, so those documents come last.
2. **Map order.** `reconcileLiveList` builds `durableById` by iterating `D` in that order.
   For a **duplicate `sessionId` the last document wins** (`Map.set` overwrites), so a
   duplicated session is represented once, by the *oldest-`createdAt`* copy.
3. **Response order.** `sessions.sort((a, b) => Date.parse(b.deployedAt) - Date.parse(a.deployedAt))`
   — newest `deployedAt` first, with an unparseable `deployedAt` ranked
   `Number.NEGATIVE_INFINITY` so a malformed instant sorts **last** rather than producing a
   `NaN` comparator. `Array.prototype.sort` is stable, so **equal `deployedAt` keeps the
   order the rows were pushed in**: first the local rows (in `localLiveSessions()` insertion
   order), then the durable-only rows in `createdAt: -1` order. §9.4 replaces that last
   sentence with a specified tie-breaker in this cycle.

Two further details of rule 3, recorded because they are the kind a comparison silently gets
wrong:

* `bRank - aRank` is `-Infinity - -Infinity`, i.e. `NaN`, when **both** rows carry an
  unparseable `deployedAt`. The sort specification collapses `NaN` to "equal", so their
  relative order is whatever the input order was — undefined for the durable side.
* For a document with no `deployedAt` and no `createdAt`, the fallback instant is the
  **request instant**, not a second reading of the wall clock: `readDurableSessionView` takes
  the reconciler's injected `nowMs`. Before this cycle it called `toISOStringLocal()` with no
  argument, so the value was `Date.now()` read *inside the row loop* — the same instant to
  within a millisecond, but not a function of `(documents, now)`. The rail is now exact.

**Ties on `deployedAt` have no specified order today.** The order shown for two sessions
that share a `deployedAt` (to the millisecond) is whatever MongoDB returned for the
durable-only rows, which is not a documented guarantee. Anything that compares two orderings
must therefore either avoid such ties or fix a tie-breaker first; this cycle does the latter
(§9.4), because a benchmark that seeds thousands of sessions in a loop produces ties
constantly.

`deployedAt` is `String(d.deployedAt ?? d.createdAt ?? now)` — **not** `createdAt` and not
`updatedAt`. Two documents can therefore share a `createdAt` and differ in `deployedAt`, and
the response order follows `deployedAt`.

---

## 8. Pagination, duplicates and identity

**There is no pagination.** `GET /api/v1/guardian/sessions` takes no query parameters,
applies no `limit` or `offset`, and returns **every** live session it can see, in one
response. There is no `total`, no cursor and no `hasMore`. A client that wants fewer rows
filters after the fact.

"Preserving pagination semantics" therefore means **preserving the absence of pagination**:
one request, one page, and that page is the whole live set. Introducing a cap would be an
API change, not an optimisation.

| Concern | Behaviour |
| --- | --- |
| Duplicate `sessionId` within one page | collapsed by `durableById`; the last document in `createdAt: -1` order wins |
| A local row with no durable document | reported with `statusSource: "process-local"`, its status taken from local state, and listed in `localOnly` |
| A local row whose durable document is terminated | dropped (`reason: "terminated"`), and pushed to `repairs` so the transition cache is corrected toward the document |
| A local row whose durable document is active/locked | included; `statusSource: "durable"` |
| A durable-only row | always `statusSource: "durable"`, `ephemeralStateAvailable: false` |
| `reconciled` | `true` whenever the store **answered** (including "no rows"); `false` only when the store did not answer, in which case every row is process-local and labelled so |

The `sessionId` used for a document is `String(d.sessionId ?? "")`; a document with a
missing or empty `sessionId` is **skipped entirely** and appears on no list.

---

## 9. What any replacement predicate must reproduce

The response is a pure function of `(L, D, T, ttlSeconds)`. A bounded query returns a
**subset** `Q ⊆ D`. The reconciler is unchanged, so:

> **Sufficiency condition.** `reconcile(L, Q) == reconcile(L, D)` for the response body if
> and only if `Q` contains
>
> **(A)** the durable document of every local row — `{d ∈ D : d.sessionId ∈ L}` — because a
> local row whose document is absent is reported as `process-local` and a durably-terminated
> session would leak back onto the list; and
>
> **(B)** every document that is live under the **durable-only** rule,
> `{d ∈ D : live_durable_only(d)}` — because those are the rows the durable-only branch adds.

`Q` may contain **more** than that: an extra document is a document the old path also had,
and the reconciler reaches the same verdict about it. A query that over-selects costs a
fetch; a query that under-selects changes the answer. Completeness, not minimality, is the
invariant.

Where `live_durable_only(d)` is, from §3 and §5:

```
normalizeStatus(String(d.status ?? "active")) != "terminated"
  AND ( parse(tsString(d)) is null  OR  parse(tsString(d)) > cutoff )
```

with `tsString(d) = String(d.updatedAt ?? d.deployedAt ?? d.createdAt ?? toISOStringLocal())`.

### 9.1 Consequence 1 — the query must be a union, not a filter

(A) is not implied by (B). A local row whose document is `terminated`, or whose document is
expired under the local-row rule, is **excluded** by (B) and **required** by (A). A query
that returned only the live set would make that session look absent durably, and the
reconciler would then answer from this process's cache — republishing a terminated session
as live. So the replacement is necessarily:

```
Q = { d ∈ D : d.sessionId ∈ L }                       (A)
  ∪ { d ∈ D : live_durable_only(d) }                  (B)
```

and (A) is `sessionId: { $in: [...] }` on the existing unique index, so it costs one index
seek per locally-held session and is bounded by this process's memory rather than by the
size of the collection.

### 9.2 Consequence 2 — the durable-only rule needs a *normalised* field

(B) is currently evaluated in JavaScript over every document. Moving it into MongoDB needs a
value the server can range-compare, and §5 shows why that value cannot simply be
`d.updatedAt`:

* U2/U3/U5/U6/U8 have **no parseable `updatedAt`** yet are live when `deployedAt`/`createdAt`
  carries a recent instant (U2/U3) or are live unconditionally (U5/U6/U8).
* C3/C4 have **no truthful instant anywhere** and are live *forever*, which no stored
  timestamp can express — any `Date` eventually falls behind `cutoff`.

Both cases are handled by a single derived field that a migration writes once:

```
liveListUpdatedAt(d) = new Date(parse(tsString(d)))      when parse(tsString(d)) is finite
                     = SENTINEL (max representable Date) otherwise
```

Then, for **every** document and **every** `cutoff`:

```
liveListUpdatedAt(d) > cutoff   <=>   parse(tsString(d)) is null  OR  parse(tsString(d)) > cutoff
```

which is exactly the second half of (B). The sentinel is "conservatively never expires",
which *is* the pre-migration behaviour for those documents, and it is deliberately **not**
"now": migration never reads the clock.

### 9.3 Consequence 3 — `updatedAt` itself must not be rewritten

The tempting simplification is to normalise `updatedAt` in place to a `Date` and range-query
it directly. It is wrong, and §4.1 says why. Take a document with **no** `updatedAt`, a
recent `deployedAt`, and a local row whose `lastActivityAt` is older than `cutoff`:

* **Today:** the durable-only branch is live (it falls through to `deployedAt`), but the
  local row's branch consults only `readDurableString(updatedAt)`, which is `null`, so the
  row's own old timestamp expires it and the session is **dropped**.
* **After rewriting `updatedAt = deployedAt`:** the local row now has a durable candidate, the
  maximum of the two wins, and the session is **reported live**.

The same flip happens for U5/U6/U8 documents under the sentinel. Both are reachable only
from hand-edited or corrupted documents — and "every legacy and malformed stored document"
is exactly the case this cycle must not paper over. So the normalised value goes in its own
field, the reconciler keeps reading `updatedAt` unchanged, and the two branches keep
disagreeing in precisely the way they disagree today.

### 9.4 Consequence 4 — a deterministic tie-breaker

Because §7 leaves equal-`deployedAt` order unspecified, this cycle adds `sessionId`
(ascending) as the final comparator in the response sort. That **refines** an unspecified
order into a specified one; it does not reorder any pair whose `deployedAt` differs. Without
it, no equivalence test over generated fixtures could assert an ordering, and no benchmark
that seeds thousands of sessions in a tight loop would be reproducible.

The comparator is on **code units**, not `localeCompare`: the response order must not depend
on which ICU collation the runtime was built with. It also removes the `-Infinity - -Infinity`
case from §7, so two rows with an unusable `deployedAt` are now ordered by `sessionId` rather
than by whatever order the durable side returned.

This is additive and observable only for sessions sharing a `deployedAt` to the millisecond.

---

## 10. The target normal form

Everything above yields one target shape for a `monitored_sessions` document, and nothing
more than this shape is required to make the list predicate total, index-usable and
provably equivalent:

**Implemented by migration `0005-normalise-session-list-fields`**
(`packages/mcp-mongodb/src/migrations.ts`), with the decision itself in the pure module
`packages/mcp-mongodb/src/session-list-normalisation.ts` and the equivalence asserted by
`apps/api/test/live-list-normalisation.test.ts` and
`apps/api/test/release/live-list-normalisation-migration.test.ts`.

| Field | Before | After | Rule |
| --- | --- | --- | --- |
| `status` | any value, or absent | `active` \| `locked` \| `terminated` | `normalizeStatus(String(status ?? "active"))`, applied only when it differs |
| `liveListUpdatedAt` | absent | BSON `Date` | `Date(parse(tsString(d)))`, or the max-Date sentinel when no truthful instant exists |
| `updatedAt` | anything | **unchanged** | §9.3 |
| `deployedAt`, `createdAt` | anything | **unchanged** | ordering and display stay exactly as they were |
| counters, `terminalContent`, … | anything | **unchanged** | not list inputs |

Status is rewritten because it is idempotent under `normalizeStatus` (§3) and because it
makes `status: { $in: ["active", "locked"] }` an exact filter rather than one that silently
drops a legacy `"cleared"` or absent status — the rows §3 normalises to `active`.

`liveListUpdatedAt` is added because it is the only representation of (B) that is total over
the case table in §5, range-comparable in MongoDB, and free of any invented instant.

### 10.1 The bounded predicate

```
{ $or: [
    { sessionId: { $in: L } },                                              // (A)
    { status: { $in: ["active", "locked"] },
      updatedAt: { $gt: cutoff } },                                         // (B) normal rows
    { status: { $in: ["active", "locked"] },
      liveListUpdatedAt: { $gt: cutoff } },                                 // (B) rows with no usable updatedAt
    { liveListUpdatedAt: { $exists: false } },                              // not yet migrated
  ] }
  .sort({ createdAt: -1 })
```

with the supporting index `{ status: 1, liveListUpdatedAt: -1 }`.

The fourth branch is what makes the predicate **correct in every database state**. A document
that migration has not classified — written by an older process, or inserted while the
migration pass was running — has no `liveListUpdatedAt`, cannot be judged by the server, and
is therefore handed to the reconciler exactly as it is today. Before migration has run, that
branch matches every document and the list behaves **exactly as it does now**; after
migration it matches nothing, and the first three branches carry the whole predicate. A
deployment that starts the new build before the migration has finished is therefore
*correct but not yet faster*, rather than wrong. `docs/operations/upgrade.md` states the
ordering.

| Contract | How the predicate satisfies it |
| --- | --- |
| (A) local rows | branch 1, one `sessionId` index seek per local row |
| (B) durable-only live rows, `updatedAt` a `Date` | branch 2, range scan on the compound index |
| (B) durable-only live rows, `updatedAt` absent/garbage/sentinel | branch 3, range scan on the same compound index |
| not-yet-migrated rows | branch 4, the index's `null` bucket |
| terminated rows | never added by branches 2–3; branch 4 may return them, and the reconciler drops them |
| expired rows | never added by branches 2–3; branch 4 may return them, and the reconciler drops them |
| no full-collection post-filter | the reconciler receives a subset of `D` and never sees the collection |
| one query per page, no N+1 | one `list_sessions` call, one cursor, one `toArray()` |

---

## 11. What this model does *not* claim

* **Zero staleness is unchanged.** The list is still one durable query per request with no
  cache. Nothing in this cycle introduces a TTL, a memo or a snapshot
  (`docs/development/live-read-freshness-policy.md`).
* **`dropped` shrinks.** The debug-only `droppedNotLive` count covers the documents the
  query returned and the reconciler removed. Documents the bounded query never fetched are
  not counted. The **response body is unaffected**; the log field stops counting rows the
  request did not look at.
* **`updatedAt` stays ambiguous.** U2–U9 remain readable in exactly the ways they are today.
  Closing the `readDurableString` / `Date` asymmetry is *not* semantics-preserving for these
  documents (§9.3) and is therefore retained and documented rather than "fixed".
* **`liveListUpdatedAt` is derived storage.** A hand-edit that changes `updatedAt` without
  re-running or re-deriving the field changes what the *query* selects, though never what the
  reconciler decides about a document it was given. Any process write keeps the two
  consistent; `docs/operations/upgrade.md` says so for direct database edits.

## 12. Evidence

| Claim | Pinned by |
| --- | --- |
| the case tables in §3, §5 and §6 | `apps/api/test/live-list-current-semantics.test.ts` |
| §5 on a real store, including `Date` vs adapter string | `apps/api/test/live-list-current-semantics.test.ts` (real-Mongo half) |
| §9.1, §9.2, §9.3 after migration | `apps/api/test/live-list-bounded-query.test.ts` — one reconciler over two document sets |
| §9.2 over generated fixtures | `apps/api/test/live-list-equivalence-generated.test.ts` — 60 seeded fixtures, pre-migration documents against migrated ones |
| that the mirror of the query describes the server | `apps/api/test/release/live-list-mirror-vs-query.test.ts` |
| §9.4 ordering | `apps/api/test/live-list-current-semantics.test.ts`, plus the equivalence suites |
| the predicate and its index | `apps/api/test/release/live-list-query-plan.test.ts` |
| §10.1's branch costs | `npm run bench:read-path` |
| the normal form and its accounting | `apps/api/test/live-list-normalisation.test.ts`, `apps/api/test/release/live-list-normalisation-migration.test.ts` |

## 13. See also

* [live-read-consistency.md](live-read-consistency.md) — why the list is reconciled from
  durable truth on every request.
* [multi-writer-model.md](multi-writer-model.md) — the two-process races the reconciler's
  durable-wins rule exists to close.
* [session-state-model.md](session-state-model.md) — the lifecycle status vocabulary.
* [live-read-freshness-policy.md](live-read-freshness-policy.md) — the zero-staleness
  contract this model must not weaken.
* [read-path-performance.md](read-path-performance.md) — the measurement this cycle extends.

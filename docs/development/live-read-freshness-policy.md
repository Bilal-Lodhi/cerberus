# Live read freshness policy

What **current** means on every surface that reads a session, what may be cached, how stale a
response may be, which states may **never** be served stale, and what evidence would be required
before any of that changes.

This document is a **contract written before implementation**, deliberately. A cache designed
first and documented afterwards produces a policy that describes whatever the code happens to do,
which is the opposite of a freshness contract. Every clause below therefore states what the API
owes a client; §8 states what would have to be true before the live detail is allowed to answer
from anything other than durable truth, and §9 records the decision this cycle reached.

This supersedes the freshness table in [live-read-consistency.md](live-read-consistency.md) §2 as
the normative statement, and keeps that document's reconciliation model as the mechanism. The
measured cost behind every number here is in
[read-path-performance.md](read-path-performance.md).

## 1. The four words

Used precisely, because "eventually consistent" is not an answer an operator can act on.

| Term | Meaning | What a client may conclude |
| --- | --- | --- |
| **`DURABLE_CURRENT`** | The value was reconciled against the durable store **during this request**. | The value is what the session document holds now. |
| **`BOUNDED_STALE`** | The value is a durable value that was read earlier, and the response states a bound in milliseconds that it cannot exceed. | The value was true at some instant within the last *N* ms, and is true now unless a write landed in that window. |
| **`PROCESS_LOCAL`** | The durable store did not answer. The value is this process's own last-known view. | The value is a statement about **this process**, not about the cluster. It may be arbitrarily out of date. |
| **`ABSENT`** | No truthful answer exists — neither the store nor this process can answer. | Nothing is claimed. Reported as absent, never as `0` or as a default. |

`BOUNDED_STALE` is the only one of the four that does not exist today, and §8 is the gate it must
pass.

## 2. The contract, per surface

`max staleness` is the largest interval between a durable write and the moment a client can
observe it on that surface. `source` is what the response says about where the answer came from.

| Surface | Route | `source` | Max staleness | Terminal-state behaviour | Outage behaviour |
| --- | --- | --- | --- | --- | --- |
| **Live list** | `GET /api/v1/guardian/sessions` | `statusSource` per row, `reconciled` per page | **0 ms** — `DURABLE_CURRENT` | A durably `terminated` session is dropped in the same request; an expired one is dropped by the TTL predicate | `reconciled: false`, every row `statusSource: "process-local"`, `200` |
| **Live detail** | `GET /api/v1/guardian/sessions/:sessionId` | `statusSource`, `reconciled`, `source` | **0 ms** — `DURABLE_CURRENT` | `terminated` is reported from the document; a cached `active` cannot survive it | `200` labelled `process-local` when this process holds the session; `503` `SESSION_STORE_UNAVAILABLE` when nothing does |
| **Review list** | `GET /api/v1/sessions` | none (durable by construction) | **0 ms** — `DURABLE_CURRENT` | Reports the durable status verbatim | `503`, never a `404` and never an empty page |
| **Review detail** | `GET /api/v1/sessions/:sessionId` | none (durable by construction) | **0 ms** — `DURABLE_CURRENT` | Reports the durable status verbatim | `503` |
| **Dashboard counters** | derived by the console from the live list | inherited | **0 ms** — inherited from the live list | Inherited: a terminated session is not counted | Inherited |
| **Console polling** | the console re-reading on its timer | inherited | Inherited from whichever endpoint it reads | Inherited | Inherited |

**There is deliberately no `BOUNDED_STALE` surface in this release.** §9 records the decision and
the evidence.

### Why the ephemeral fields are `PROCESS_LOCAL` and not `ABSENT`

The reconstructed workspace and the latest risk payload exist only in the process that ingested
the events. They are not durable and cannot be made durable by reading. The honest answer is to
serve them when this process holds them and **say so**, which is what `ephemeralStateAvailable`
and `source` are for. A client that needs the durable workspace reads the review surface. This is
a separate axis from the freshness of the durable fields and is not affected by §8.

## 3. Metadata the API returns

Additive, and each field answers exactly one question:

| Field | Surface | Values | Question it answers |
| --- | --- | --- | --- |
| `statusSource` | live list (per row), live detail | `durable`, `process-local` | Where did the **status** come from? |
| `reconciled` | live list (per page), live detail | `true`, `false` | Did the store **answer** for the durable fields? |
| `source` | live detail | `memory`, `durable` | Does this process hold the reconstructed workspace and latest payload? |
| `ephemeralStateAvailable` | live list (per row), live detail | `true`, `false` | Is the ephemeral state answerable at all? |

`reconciled: true` means the store answered — **including** when it answered that no such session
exists. It is `false` only when the store did not answer. Collapsing "absent" into "unavailable"
is what once made an unreachable store answer `404` for a session that exists.

If a bounded cache is ever introduced, §8.4 fixes the metadata it must add and forbids reusing
`statusSource: "durable"` for a value that was not read in that request.

## 4. What may be cached, if anything is

Stated now so that a future implementation is constrained by the contract rather than the
reverse.

**May be cached:** only durable, reconstructable session-detail fields — the same fields the
durable reader already returns: `status`, `employeeId`, `matrixId`/`auditId`, `targetSystem`,
`deployedAt`, `updatedAt`, the five counters, and `peakRiskScore`.

**Must never be cached:**

- operator credentials, the MCP token, or anything derived from them;
- request-specific correlation data (`requestId`, `correlationId`, timestamps of the request);
- provider responses unrelated to session detail;
- the reconstructed workspace and the latest risk payload — these are `PROCESS_LOCAL` by
  definition and caching them would present one process's memory as a shared value;
- a `404`/missing-session result, by default. A negative cache can hide a just-created session,
  and the only defence is a TTL short enough to be useless. It is **not** introduced unless a
  measurement justifies it, and §8.3 states what that measurement would have to show.

**Cache key:** `sessionId`, and nothing coarser. A page-level or tenant-level key would make one
session's invalidation silently affect another's.

## 5. Invalidation, and what one process can and cannot do

**A local write reconciles the local cache immediately.** Every mutation path already has a
single boundary — `createSessionTransitions` and its `SessionTransitionCache` — and that boundary
is where a cache update or eviction belongs. The paths that must be covered:

| Local write | Effect on a cached live detail |
| --- | --- |
| deploy / create | seed or invalidate — the session is new |
| ingest (counters changed) | invalidate, or update the counters it advanced |
| lock / unlock | invalidate, or set the status it wrote |
| terminate | **evict**, not merely invalidate — a terminal session must not stay in a live registry |
| `terminalContent` update | invalidate |
| review / risk update (`peakRiskScore`) | invalidate, if the detail exposes the score |
| delete | evict |

**A process cannot invalidate another process's in-memory cache.** There is no shared
infrastructure and none is proposed: a distributed cache or a pub/sub invalidation channel is a
cache-consistency architecture fork, which is a reserved owner decision and out of scope for this
phase. Therefore:

- a remote transition becomes visible on this process **only** when the cache entry expires or
  this process's own write touches it;
- the declared maximum staleness **is** that expiry bound, and it is the honest statement of the
  cross-replica guarantee. Nothing may claim instant cross-replica invalidation, because nothing
  can provide it;
- the bound must be stated in milliseconds in the response, not left for a client to infer.

## 6. The evidence this decision rests on

### 6.1 The measured cost of durable truth

From [read-path-performance.md](read-path-performance.md) §4, against a loopback `mongod` with the
real driver, dataset 20 sessions × 200 events, commit `a9f5079`:

| Case | p50 | p95 | persistence calls/request |
| --- | --- | --- | --- |
| Live detail (process holds the session) | 1.36 ms | 1.96 ms | 1.00 |
| Live detail (after restart) | 1.13 ms | 1.61 ms | 1.00 |
| Live list (20 sessions) | 1.59 ms | 2.34 ms | 1.00 |
| Review detail | 6.55 ms | 8.73 ms | 1.00 |

At best concurrency (8 in flight) one process serves **1 849 live-detail requests per second**.

### 6.2 Who actually polls, and how often

The console's request-frequency audit is the fact that decides this. Its findings, quoted from the
audit rather than restated:

- the console's only periodic mechanism is a 5-second poll loop
  (`apps/console/lib/services/api_service.dart:212-230`);
- the endpoint that loop reads is the **review detail**, `GET /api/v1/sessions/{id}`
  (`api_service.dart:299-308`), with the live detail `GET /api/v1/guardian/sessions/{id}` used
  only as a **fallback** when the primary does not answer `200` with a body
  (`api_service.dart:363-371`);
- the **live list is not polled at all**; it is fetched on five explicit triggers, the mount
  being one of them;
- there is no visibility guard, no in-flight guard, and two concurrent identical detail requests
  are issued on every session selection;
- steady state with a healthy primary endpoint is **12 requests/minute**, all of them to the
  review detail. Steady state against the live detail is **0 requests/minute**.

### 6.3 The arithmetic

The console's poll interval is 5 s, so a single console issues **12 requests/minute**.

- Against the **review detail** (its actual polled endpoint): 12 × 6.55 ms = **79 ms of work per
  minute**, or 0.13 % of one process's capacity.
- Against the **live detail**, at the measured p50: 12 × 1.36 ms = **16 ms per minute**, or
  0.02 % of one process's capacity.
- At 1 849 req/s, one process has room for **≈ 9 200 consoles** polling the live detail at
  12 req/min before the measured knee is reached — and the console does not poll it at all.

### 6.4 The surface that does not scale is not the one the cache would cover

[read-path-performance.md](read-path-performance.md) §4.3 measures both read surfaces against a
store that grows from 20 to 5 020 sessions:

| Stored sessions | Live list p50 | Live detail p50 |
| --- | --- | --- |
| 20 | 2.53 ms | 1.45 ms |
| 520 | 10.21 ms | 1.17 ms |
| 5 020 | **75.58 ms** | **0.98 ms** |

The live detail is **flat** — it is a lookup on the unique `sessionId` index. The live list grows
**linearly with the total number of stored sessions**, because `MongoStore.listSessions` issues
`find({})` with no filter and no limit and the route then discards every session that is not live.

Two consequences for this policy, and they point the same way:

1. **A cache in front of the live detail would optimise the one read surface that is already
   independent of the store's size**, on a path the console does not poll. It would not touch the
   cost that actually grows.
2. **The list's cost is a query-shape problem, not a staleness problem.** The answer to it is a
   *bounded durable query* — one that returns exactly the documents the reconciler needs, so the
   response is unchanged — and not a cache. A bound preserves `DURABLE_CURRENT` at zero
   staleness, which is strictly better than any TTL, and it is why this cycle's work on the list
   changes no freshness clause at all.

That change is tracked separately: the durable list query gains a bound that preserves the current
answer exactly, and §7's terminal-state clauses are the invariants it must not weaken.

## 7. Which states may never be served stale

These hold unconditionally, whether or not a cache exists, and they are the clauses a cache
implementation would have to satisfy rather than relax:

1. **`terminated` is terminal and is never cached as `active` beyond the declared bound.** A
   local terminate evicts immediately (§5). A remote terminate becomes visible within the
   declared bound and not later.
2. **A transition never trusts a stale value for its precondition.** Every transition reads the
   durable document and writes through a predicate (`expectedStatuses`), so a decision made on a
   stale value matches nothing and reports `SESSION_CONFLICT` rather than overwriting the winner.
   The cache is never the authority for a write.
3. **A stale cache never writes back.** The read path repairs the cache toward the document and
   never the document toward the cache.
4. **`terminated` and expired sessions are never returned by the live list**, at any staleness.
5. **The review surfaces are never served from a stale cache.** They are the evidentiary
   surface: a review answer that is a cache is not evidence.
6. **A dependency outage never becomes a `404`.** `ABSENT` and "the store did not answer" are
   different facts and stay different.

## 8. The gate a bounded cache must pass

If the live detail is ever to answer `BOUNDED_STALE`, all of the following must hold. They are
stated as requirements so that a future cycle is measured against the contract rather than
against its own design.

**8.1 A declared, enforced maximum staleness.** The bound is a configured TTL with a documented
default, a documented minimum and a documented maximum. An invalid value **fails closed** at
startup — a typo must not silently change how stale an operator's view may be. Zero disables the
cache. No parsed-but-unused setting.

**8.2 Terminal states cannot be served active beyond the bound.** Local terminal transitions
evict or update immediately. Cross-replica terminal transitions become visible within the bound.
A test must demonstrate: process A caches `active`, process B terminates, A reads before the
bound (documented as permitted, labelled) and after it (must report `terminated`), and A's
attempted transition while stale must never write `active` over `terminated`.

**8.3 Bounded memory and deterministic eviction.** A cache with no memory bound is not
acceptable. Entries are bounded (a maximum entry count, or an LRU, or both), eviction is
deterministic enough to assert in a test, and there is no unbounded per-entry timer.

**8.4 Truthful metadata.** A `BOUNDED_STALE` answer must not report `statusSource: "durable"` or
`reconciled: true` as those are defined today, because neither is true of it. It needs its own
value — a `cache` source and an age — and §3's table is the place that is recorded.

**8.5 Honest outage behaviour.** If the store is unavailable, a cache entry **within** its bound
may be served, labelled as cached with its age. An **expired** entry must not be presented as
current: it is `PROCESS_LOCAL` at best, and labelled as such, or the request is a `503`.

**8.6 Cross-replica convergence proved, not asserted.** Two real API processes against one real
MongoDB, with an injected clock rather than sleeps: A caches, B writes, A converges within the
bound; a restart is truthful; an outage and a recovery are truthful; simultaneous refreshes do
not produce a duplicate-read storm or a lost update.

**8.7 Measurable hit/miss behaviour without leaking data.** Structured events for hit, miss,
expiry, eviction and invalidation, carrying a request id, an age and a reason — and never a
payload, a workspace or a secret.

**8.8 A measured improvement that justifies the complexity.** Before/after on the same machine
and configuration, in absolute numbers, with the query count before and after. A ratio alone is
not evidence, and the surface the console actually polls is the review detail, which §7.5 keeps
durable.

## 9. The decision for this cycle

**No `BOUNDED_STALE` surface is introduced.** The live detail keeps its durable read per request,
and the freshness contract above is the deliverable.

The reasoning, in the order it was reached:

1. **The cost being optimised is one bounded round trip.** 1.00 persistence calls per request,
   1.36 ms p50 / 1.96 ms p95 against a real `mongod` — and **flat in the size of the store**
   (1.45 ms at 20 sessions, 0.98 ms at 5 020), because it is a lookup on a unique index. There is
   no scan, no N+1, and no cost that grows with a session's history on the live detail — it asks
   for the session document alone.
2. **The client that exists does not poll this surface.** The console polls the review detail at
   12 requests/minute; its steady-state load on the live detail is zero. Caching the live detail
   would optimise a path with no measured traffic, and §7.5 keeps the surface that *is* polled
   durable because it is evidence.
3. **The capacity headroom is four orders of magnitude.** 1 849 requests/second against
   12 requests/minute per console is not a constraint worth adding a staleness surface to a
   correctness-critical read for.
4. **The one read surface that does not scale is the live list, and a cache is the wrong
   instrument for it** (§6.4). Its cost grows linearly with the number of *stored* sessions
   because its durable query is unbounded, and the fix is a bounded durable query that keeps the
   answer identical — zero staleness rather than a TTL.
5. **The complexity is not free and is not local.** A cache introduces a second answer to "what
   is this session's status", a declared staleness bound operators must reason about, bounded
   memory, deterministic eviction, and a cross-replica convergence property that cannot be better
   than the TTL because no shared invalidation channel is proposed.
6. **The charter permits this outcome explicitly.** *"A maturity cycle may conclude that no cache
   is the right answer. That is a valid success."* and *"If evidence says current behavior is
   cheap enough: KEEP durable read per request."*

**What would change the decision.** A measured change in any of: the number of persistence calls
per live-detail request; the p95 above the low single-digit milliseconds against a realistic
(non-loopback) MongoDB; the live detail's cost becoming dependent on the size of the store; a
client that polls the live detail at a rate where the measured knee is approached; or a session
count that makes the live list's bounded query expensive enough to matter. §8 is the gate that
would then apply, unchanged.

## 10. Threat model for the freshness contract

Even with no cache implemented, the contract makes claims, and those claims have a security
reading.

| Claim | What it is worth |
| --- | --- |
| Durable state is the authority | Unchanged by this cycle. No read path can write, and no cache is authoritative for a transition. |
| Staleness bound | **Zero** today. There is no window in which a client can observe a value that the durable store does not hold. |
| Multi-replica convergence | Immediate, because every read reconciles against the store. This is a property of the current design and is **lost** the moment a process-local cache is introduced without shared invalidation. |
| Response metadata | `statusSource`, `reconciled`, `source` and `ephemeralStateAvailable` describe provenance, not trust. A client must still authenticate; they are not an access control. |
| No compliance claim | None of this is a compliance, retention or auditability claim. `DURABLE_CURRENT` means the value was read from the store in this request, not that the store is authoritative for legal purposes. |

## 11. Compatibility

- **No field is removed** from any response.
- **No response metadata is added** by this cycle: `statusSource`, `reconciled`, `source` and
  `ephemeralStateAvailable` already exist and already carry the meanings in §3.
- **No configuration is added**, so there is no new knob and no config census change.
- **Default behaviour is unchanged**: every surface remains `DURABLE_CURRENT`, exactly as
  [live-read-consistency.md](live-read-consistency.md) §2 already stated. What this document adds
  is the definition, the per-surface maximum staleness, the states that may never be served
  stale, the gate a future cache must pass, and the evidence for declining to build one now.

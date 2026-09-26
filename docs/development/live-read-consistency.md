# Live read consistency

What **current** means on each surface that reads a session, how long a value may be stale,
and how the live surfaces are reconciled against durable truth.

The problem this document answers is stated in
[multi-writer-model.md](multi-writer-model.md) §5.1: the review surfaces read MongoDB,
the live surfaces read this process's memory, and with more than one replica they can
disagree about the same session.

## 1. The surfaces

| Surface | Route | Question it answers |
| --- | --- | --- |
| Live list | `GET /api/v1/guardian/sessions` | Which sessions are being monitored right now, and how are they doing? |
| Live detail | `GET /api/v1/guardian/sessions/:sessionId` | Everything this system knows about one session, including this process's live workspace |
| Review list | `GET /api/v1/sessions` | Which sessions exist, for review? |
| Review detail | `GET /api/v1/sessions/:sessionId` | The durable evidence for one session |
| Dashboard counters | derived by the console from the live list | How many sessions, how many alerts? |
| Console polling | the console re-reading the live list on a timer | Has anything changed since the last poll? |

## 2. The freshness contract

Four words, used precisely, because "eventually consistent" is not an answer an operator can
act on.

| Term | Meaning |
| --- | --- |
| **durable current** | The value the session document holds *now*. A read that reports this has read MongoDB in this request. |
| **bounded-stale** | The value may be up to N seconds behind durable truth, and N is stated. |
| **local best effort** | The value is one process's own view and is **not** a statement about the cluster. The response says so. |
| **absent** | The value cannot be answered by this process, and is reported as absent rather than as `0`. |

The contract, per surface:

| Surface | Durable-authoritative fields (status, counters, peak risk, last activity) | Ephemeral fields (workspace, latest payload) |
| --- | --- | --- |
| **Live detail** | **durable current** — the document is read in the request and wins | **local best effort**, labelled through `ephemeralStateAvailable` |
| **Review detail** | **durable current** | Reconstructed from `risk_assessments` — durable, not ephemeral |
| **Review list** | **durable current** | Not served |
| **Live list** | **durable current**, from one batched query for the whole page | **local best effort** per row, labelled through `ephemeralStateAvailable` |
| **Dashboard counters** | Inherited from the live list, therefore **durable current** | N/A |
| **Console polling** | Inherited from the live list | N/A |

There is deliberately **no bounded-stale surface**. A TTL cache in front of the session
document would trade a query for a lie of unknown age, and the cost of the query is one
bounded round trip per request, measured in
[performance-baseline.md](performance-baseline.md). "Current" is cheaper to reason about
than "recent".

### Why `local best effort` is allowed at all

Because the alternative is worse. The reconstructed workspace lives only in the process that
ingested the events; reconstructing it from `micro_events` on every detail read would cost
work proportional to the session's whole history on a polling surface. The honest answer is
to serve it when this process holds it and **say so**, which is what
`ephemeralStateAvailable` and `source` are for. A client that needs the durable workspace
reads the review surface.

## 3. How the live list reconciles

The rule: **one batched durable query per list request, and durable wins where it answers.**

```
                    ┌─────────────────────────────────────────┐
  request ────────► │ 1. build the local view (memory)        │
                    │    sessions this process deployed/ingested
                    └────────────────┬────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────┐
                    │ 2. ONE list_sessions durable query      │  ← always, not only when memory is empty
                    │    identity, status, counters, peak risk,
                    │    updatedAt for every session          │
                    └────────────────┬────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────┐
                    │ 3. merge: durable wins per field        │
                    │    • status        ← durable            │
                    │    • counters      ← max(local,durable) │
                    │    • peakRiskScore ← max(local,durable) │
                    │    • lastActivity  ← max(local,durable) │
                    │    • workspace / payload ← local, labelled
                    │    • durable-only sessions are ADDED
                    │    • durable `terminated` / expired are DROPPED
                    └────────────────┬────────────────────────┘
                                     │
                                     ▼  one bounded page, one query
```

Four properties this gives, each of which is a charter requirement:

1. **A durably-terminated session cannot appear live indefinitely.** It is dropped by the
   merge in the same request that would have reported it.
2. **Another process's sessions are not omitted.** They come from the durable query, which
   is the only source that can see them.
3. **Counters cannot regress.** The merge takes the maximum, and the storage layer's `$max`
   means durable itself cannot have regressed.
4. **The query count is bounded.** One query per list request, regardless of how many
   sessions are in memory. There is no per-session read, so no N+1.

### The merge is a pure function

The merge lives in `apps/api/src/services/session-reconciliation.ts` and takes
`(localEntries, durableDocuments)` with no database, clock, or logger. It is unit-tested
directly, and the route is a thin adapter around it. Two reasons: the rule is the thing
worth testing, and a pure merge can be exercised over states that are awkward to produce
through HTTP (a durable document newer than memory, a durable-only session, a mixed page).

## 4. How the live detail reconciles

The rule: **read the document, then let durable win for durable-authoritative fields.**

Today the route returns from `sessionStore` whenever it has the session and never reads
MongoDB. The change is to read the document unconditionally and merge, exactly as the list
does:

| Field group | Winner |
| --- | --- |
| `status`, counters, `peakRiskScore`, `deployedAt`, `targetSystem`, `lastActivityAt` | durable |
| `liveness` | derived from the durable activity instant |
| `currentCode`, `lastRiskPayload` | this process, labelled `ephemeralStateAvailable: true` |
| `eventCount` | `max(local hydrated total, durable)` |

This costs one durable round trip on the memory path that previously cost none. It is the
price of the answer being true, and it is the same round trip the fallback path already
pays.

### When the store does not answer

The route must not invent a status. The behaviour is:

- **memory holds the session, store unreachable** — serve the local view with
  `reconciled: false`, `statusSource: "process-local"`, and a warning log. The status is
  this process's last known value and is labelled as such rather than presented as durable
  truth. Refusing outright would take the live dashboard down during a store blip, which is
  a worse failure than a labelled stale value.
- **nothing holds the session, store unreachable** — `503` with
  `SESSION_STORE_UNAVAILABLE`, which is what the route already does. The existence of the
  session is genuinely unknown, and `404` would assert something the process cannot verify.

## 5. Cache reconciliation is one-directional

When a read discovers that this process's cache disagrees with the document, it **repairs
the cache toward the document**. It never repairs the document toward the cache.

That direction is the whole of the stale-cache write-back defence on the read path. On the
write path the defence is different and already in place: `set_session_status` takes an
`expectedStatuses` predicate, so a transition built on a stale read matches nothing and
reports `SESSION_CONFLICT` rather than overwriting the winner.

A repair also **evicts** rather than updates when the durable status is `terminated`: the
live registry must not hold a session that is no longer monitored, or the next list read
has to filter it out again.

## 6. Failure injection

The behaviours above are asserted against a real MongoDB with two API processes, not only in
unit tests. The scenarios, and what each one must produce:

| Injected failure | Required answer |
| --- | --- |
| The store is unreachable between the cache read and the durable reconcile | A labelled `process-local` status, never a claim of durable truth |
| One replica is stale and one is current | Both report the durable status; neither reports its own cache |
| A process dies mid-transition | The document holds the pre-transition status, because the predicate write is atomic; the next read reports it |
| A process dies after a paid call and before persistence | The response says `assessmentPersisted: false`; the session is not locked and no notification is sent |
| A duplicate caller retries while a claim is pending | See §5.4 of [multi-writer-model.md](multi-writer-model.md) — no durable idempotency state exists today |

See [failure-semantics.md](failure-semantics.md) for the general form of these guarantees,
and [performance-baseline.md](performance-baseline.md) for the measured cost of the added
durable read.

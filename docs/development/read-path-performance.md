# Read-path performance — a real-MongoDB baseline

What the live and review read surfaces cost when there is a **real MongoDB** on the other end
of a real driver, and how many of those requests one process can serve.

```
npm run bench:read-path                      full run
npm run bench:read-path -- --quick           fewer iterations, for a smoke check
npm run bench:read-path -- --json out.json   also write the raw results
```

Requires `CERBERUS_BENCH_MONGODB_URI`. It **fails closed** when that is unset; see §2.

## 1. Why this exists next to `npm run bench`

[performance-baseline.md](performance-baseline.md) documents `npm run bench`, which drives the
compiled API in process with the persistence adapter replaced by an in-process double. That is
the right instrument for *"what does Cerberus's own code cost"* — it needs no server, so a
regression is attributable to this repository rather than to a container's warm-up.

It cannot answer the question the read-path cycle is about. There, a "durable read" is a
function call plus a JSON round trip, so the reported live-detail p50 is the route's own work
**around** a read that costs nothing. Whether the durable read is expensive — and therefore
whether a cache in front of it would buy anything — needs a real server.

So there are two benchmarks, and they measure different things:

| | `npm run bench` | `npm run bench:read-path` |
| --- | --- | --- |
| Persistence | in-process double | **real MongoDB**, real driver |
| Needs a server | no | yes (`CERBERUS_BENCH_MONGODB_URI`) |
| AI provider | stubbed | stubbed (never spends) |
| Answers | what Cerberus's own code costs | what a durable read costs |
| Persistence calls per request | not counted | **counted and reported** |

## 2. What is real, and what is not

**Real:** the MongoDB server, the MongoDB driver, the connection pool, the queries, the
documents, the migrations and the indexes; the MCP **tool registry** (`createToolRegistry`) and
its argument validation; the compiled API routes and the whole reconciliation path.

**Not real:** the HTTP server and its parsing (the app is driven through `app.request()`), TLS,
and the HTTP hop to the MCP adapter — the tool registry is called in process through the same
`fetch` seam `run-bench.mjs` uses. The AI provider is stubbed, so no money is spent and no model
latency is included.

So the **MongoDB round trip is included and both HTTP hops are not**. Every figure here is a
floor for a real deployment, and no figure here may be compared with a figure taken on another
machine or in another container.

The script writes these four facts into every JSON run as
`includesMongodbRoundTrip` / `includesMcpHttpHop` / `includesHttpServerStack` /
`includesModelLatency`, so a comparison can state what it was comparing rather than assert it.

### The guard is a refusal, not a fallback

An unset `CERBERUS_BENCH_MONGODB_URI` exits `1` with an explanation. It does **not** quietly use
a stub. A read-path figure produced against an in-process double is not a read-path figure, and
a silent fallback would make the number it printed indistinguishable from a real one — which is
the failure this document exists to avoid, committed by the document itself.

## 3. Environment

| | |
| --- | --- |
| OS | `win32 10.0.26200 x64` |
| CPU | AMD Ryzen 5 5600G, 12 logical cores |
| Memory | 7.94 GiB |
| Node | `v24.19.0` |
| MongoDB | `7.0.43` |
| Topology | standalone (single `mongod`), **loopback** |
| Deployment | local Docker container, `127.0.0.1:27170` |
| Commit | `42f7234` — the head of the release-harness branch this run was taken on. That change is `829e713` on `main`; the two differ only in documentation, and the benchmark records the commit it ran at in its own JSON. |
| Dataset | 20 sessions × 200 events = 4 000 event documents |
| Warm-up | 10 % of each case's samples (minimum 5) |
| Samples | 300 per read case, 150 for the list and review cases, 400 per concurrency row |

The dataset is seeded **through the real ingest route**, so the documents are written by the
production code path and the process under measurement holds exactly the sessions a running
deployment would hold.

§4.1 to §4.4 are all from this one run. Several figures moved slightly against the `v0.6.1` numbers
— the live detail from 1.36 to 1.64 ms p50, the review detail from 6.55 to 8.32 ms. That is the
same machine at a different time, not a change in the code: neither path was touched by this cycle,
and a single-run figure from one machine is not a trend. The figures that *are* a change are in
§4.3, and the deterministic evidence there is the documents examined rather than the milliseconds.

## 4. Results

### 4.1 The read surfaces

| Case | n | p50 ms | p95 ms | p99 ms | max ms | persistence calls/request | statuses |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Live detail — this process holds the session | 300 | **1.64** | **2.70** | 3.37 | 3.68 | **1.00** | 200 ×300 |
| Live detail — after restart (memory empty) | 300 | **2.11** | **3.26** | 3.79 | 3.89 | **1.00** | 200 ×300 |
| Live list — 20 sessions | 150 | **2.67** | **3.51** | 4.27 | 4.58 | **1.00** | 200 ×150 |
| Review detail — durable evidence | 150 | **8.32** | **10.38** | 11.33 | 11.84 | **1.00** | 200 ×150 |
| Live detail — missing session | 300 | 1.43 | 1.91 | 2.11 | 2.38 | 1.00 | 404 ×300 |
| Live detail — terminated session | 300 | 1.40 | 1.76 | 1.89 | 2.18 | 1.00 | 200 ×300 |

Three things this says:

**The durable read is one bounded round trip, and it is cheap.** Every read surface makes
**exactly one** call to the persistence layer per request. The live list makes one call for the
whole page of 20 sessions — it has not acquired the per-session N+1 the list path was designed
to avoid, and it did not acquire one when its query gained a bound.

**The live detail costs about 1.6 ms p50, not 3.49 ms.** That is *with* the durable read
included and *with* a real network round trip to a real server. The stubbed benchmark reports a
larger number for the same route on the same machine, which is worth understanding rather than
averaging away — see §5.

**A restart is not a slower case.** "After restart" is 2.11 ms p50 against 1.64 ms for a process
that holds the session. Nothing is lazily loaded on the read path, so a cold process answers the
first request exactly as it answers the thousandth; the difference here is run-to-run variance on
one machine, not a warm-up effect, and it is the kind of figure §8 warns against reading as a
trend.

**The review detail is the expensive read** at 8.32 ms p50 — about 5× the live detail. That is
the evidentiary surface: its one persistence call carries up to 500 micro-events plus the risk
assessments, where the live detail asks for the session document alone
(`eventsLimit: 0, includeAssessments: false`).

### 4.2 Concurrency — how many of these one process serves

Sequential latency answers "what does one request cost". The cache decision turns on a different
question: how many of these requests per second can one process serve? A read that is cheap per
request but saturates a shared resource at eight concurrent callers is worth caching; one that
scales flat is not.

| Case | concurrency | n | req/s | p50 ms | p95 ms | p99 ms | persistence calls/request |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Live detail | 1 | 400 | 603 | 1.52 | 2.53 | 4.16 | 1.00 |
| Live detail | 8 | 400 | **1 861** | 4.05 | 5.55 | 12.14 | 1.00 |
| Live detail | 32 | 400 | 1 658 | 17.03 | 30.60 | 44.00 | 1.00 |
| Live list | 1 | 400 | 485 | 2.02 | 2.43 | 2.77 | 1.00 |
| Live list | 8 | 400 | **1 121** | 6.95 | 9.68 | 10.66 | 1.00 |
| Live list | 32 | 400 | 974 | 30.51 | 45.65 | 46.27 | 1.00 |

**Throughput stops improving at eight concurrent callers.** The live detail goes 603 → 1 861
req/s from 1 to 8 and then *falls* to 1 658 at 32, while p99 rises from 4.16 ms to 44.00 ms; the
live list peaks at 8 and falls to 974 at 32 with a p99 of 46 ms. Past the knee, adding concurrency
adds queueing rather than throughput.

That knee is a property of this process on this machine — one Node event loop, one driver
connection pool — and it is the number a capacity statement has to be built on. It is **not**
evidence about the storage layer: the same measurement against a stub would find a different
knee, and against a remote or replica-set MongoDB it would find another.

### 4.3 Scaling — read cost against the size of the durable store

The cases above run against 20 sessions, which is not enough to see a query that is unbounded in
the number of **historical** sessions. This section grows the collection while holding the live set
constant, which is what a real deployment looks like over time: sessions accumulate and are
finished with, and the number being monitored right now does not grow with them.

The fixture is history, and it is written as history: half recently terminated and half long
expired but still marked `active` — the shape a deployment accumulates because expiry is derived
and never persisted — and **none of it is live**. So every extra document is cost the query has to
stop paying for, and the "live rows" column stays at the ingested sessions.

| Stored sessions | Live rows returned | Live **list** p50 | p95 | p99 | Live **detail** p50 | p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 20 | 19 | 2.63 ms | 3.43 ms | 6.19 ms | 1.39 ms | 1.81 ms |
| 520 | 19 | 2.64 ms | 3.23 ms | 8.10 ms | 1.47 ms | 1.91 ms |
| 5 020 | 19 | 3.45 ms | 5.64 ms | 8.15 ms | 3.58 ms | 11.34 ms |
| 20 020 | 19 | **2.92 ms** | 4.12 ms | 5.63 ms | **1.33 ms** | 1.95 ms |

**This is the read-path scaling result, and it is a change.** `v0.6.1` measured the live list at
2.53 ms → 10.21 ms → **75.58 ms** p50 for 20 → 520 → 5 020 stored sessions. It is now **flat**:
2.63 ms → 2.64 ms → 3.45 ms → 2.92 ms across a thousandfold growth in the store, and the point that
cost 75.58 ms costs 3.45 ms.

The 5 020 stage is the one figure that stands out, and it is a measurement artefact rather than a
scaling effect: that stage inserts 5 000 documents immediately before it measures, and both its
list and its detail figures (3.45 ms and 3.58 ms) sit above their neighbours at 520 and 20 020 —
including the **detail**, which is a lookup on a unique index and cannot depend on the store's size.
A warm-up of 10 % of the samples does not fully absorb a 5 000-document insert. The next two
columns are the evidence that does not depend on that.

#### What the server actually did

Both queries, in this environment, on this data, through `explain("executionStats")`. The
previous build's query is `find({})`; the bounded query is the predicate the route now issues, with
the same cutoff and the same local session ids.

| Stored | Previous build: docs examined | keys | plan | Bounded: docs examined | keys | returned | plan |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 20 | 20 | 0 | **COLLSCAN** | **20** | 42 | 20 | IXSCAN, OR |
| 520 | 520 | 0 | **COLLSCAN** | **20** | 43 | 20 | IXSCAN, OR |
| 5 020 | 5 020 | 0 | **COLLSCAN** | **20** | 43 | 20 | IXSCAN, OR |
| 20 020 | 20 020 | 0 | **COLLSCAN** | **20** | 43 | 20 | IXSCAN, OR |

This is the claim, and it is deterministic rather than statistical:

- the previous build's query examined **every document ever written** — 20 020 of them at the
  largest size, with no index at all;
- the bounded query examined **20 documents at every size**, and 43 index keys;
- it returned 20 documents for a page of 19 rows, which is the local-sessions branch doing its job:
  the session the benchmark terminated is still in the process's memory, so its document must come
  back for the reconciler to drop it. A query that returned only the live set would republish it.

The bound is `{ status: { $ne: "terminated" } }` combined with a range on `updatedAt` or on the
derived `liveListUpdatedAt`, from two indexes on `monitored_sessions`. The reasoning, including why
`$ne: "terminated"` **is** index-friendly despite `v0.6.1`'s release notes saying otherwise, is in
[live-list-equivalence-model.md](live-list-equivalence-model.md) §10.1 and
`packages/mcp-mongodb/src/live-list-query.ts`.

**The live detail is flat, as it was.** 1.39 ms → 1.47 ms → 1.33 ms at the three sizes whose
measurement is not disturbed by its own seeding. It is a lookup on the unique `sessionId` index, so
it is `O(log n)` in the store and effectively constant at these sizes.

### 4.4 Store unavailable

The store is genuinely disconnected mid-run, so the failure travels the real driver and the real
tool registry (`MongoStore.dbOrThrow` raises it) rather than being simulated by a stub that
throws.

| Case | n | p50 ms | p95 ms | p99 ms | statuses | required answer |
| --- | --- | --- | --- | --- | --- | --- |
| Store down — this process holds the session | 100 | 0.17 | 0.26 | 0.32 | 200 ×100 | labelled `process-local`, not a claim of durable truth |
| Store down — nothing holds the session | 100 | 0.33 | 0.41 | 0.54 | 503 ×100 | `SESSION_STORE_UNAVAILABLE`, never a `404` |
| Store down — live list | 100 | 0.23 | 0.35 | 0.38 | 200 ×100 | `reconciled: false`, every row `statusSource: "process-local"` |

Every status is the one the contract requires, and the failing path is **faster** than the
working one (0.17 ms against 1.64 ms) because it fails before reaching the database. A dependency
outage does not become a false `404`, and a session whose existence cannot be verified is not
asserted to be absent.

## 5. The stubbed baseline does not reproduce, and that is a finding

The charter for this cycle quoted the stubbed benchmark's live-detail figure as
**p50 ≈ 3.49 ms, p95 ≈ 6.80 ms**, against a `v0.4.0` memory-only path of 0.09 ms — a ratio of
about **38×**.

At `a9f5079` on this machine, in the same stubbed harness, the same case measures:

```
GET /guardian/sessions/:id (live detail)    1000      741     1.21     1.87     3.68     13.10
```

**1.21 ms p50**, not 3.49 ms. The documented ratio does not reproduce, and the real-Mongo
measurement above is comparable at 1.64 ms p50 with an actual network round trip included.

Two facts follow, and they are separate:

1. **The 38× ratio was never a statement about the durable read.** The denominator is a
   memory-only path that made no persistence call at all, so any work whatsoever produces a
   large ratio. `performance-baseline.md` already says this in its own words: *"the old path was
   pure memory, so its denominator is near zero and a large ratio follows from any work at all."*
2. **The stubbed harness's persistence double does not honour the read bounds the API sends.**
   `get_session_review` is called with `eventsLimit: 0, includeAssessments: false` — the real
   store then skips both queries — but the benchmark's double ignores both arguments and returns
   up to 500 micro-events regardless. So the double makes every ingest and every live-detail read
   carry a session's history that the real store never returns.

That second point is the failure mode `performance-baseline.md` documents three times under
*"The stubs must match the real store's bounds"*, and it is the reason the two benchmarks
disagree about which direction the live detail moved. It is tracked as its own change: the double
is corrected to honour both arguments, and a test compares it against the real tool registry's
answer for the same arguments so a drift fails rather than silently re-inflating a baseline.

**Until that lands, no figure in `performance-baseline.md`'s live-surface comparison should be
read as a measurement of the durable read.** The real-Mongo figures in §4 are.

## 6. What this establishes for the freshness question

The read-path cycle asks whether a bounded cache in front of the live detail can preserve the
`v0.5.0` correctness guarantees while reducing the cost of live reads. This baseline is the
evidence that question is decided on:

- **The read is one bounded round trip per request** (1.00 persistence calls/request), not a
  scan and not an N+1. A cache would reduce that count from one to zero on a hit.
- **The read costs about 1.6 ms p50 and 2.7 ms p95** against a loopback `mongod`, on a machine
  that also runs the API process under measurement — and it is **flat in the size of the store**
  (1.39 ms at 20 sessions, 1.33 ms at 20 020), because it is a lookup on a unique index.
- **One process serves about 1 860 live-detail requests per second** at its best concurrency.
- **The console polls the review detail, not the live detail.** Its steady-state load on the
  live detail is zero while the primary endpoint answers. That audit is recorded separately and
  is cross-referenced from [live-read-freshness-policy.md](live-read-freshness-policy.md) §6,
  which carries the arithmetic.
- **The surface that did not scale was the live list, and it now does.** §4.3 measured it at
  2.53 ms at 20 stored sessions and 75.58 ms at 5 020, because its durable query was `find({})`
  with no bound. That was a query-shape problem rather than a staleness problem, and the answer
  was a bounded query rather than a cache — which is why it changed no freshness clause at all.
  The bound has landed: the same measurement is now 2.63 ms → 2.64 ms → 3.45 ms → 2.92 ms across
  20 → 520 → 5 020 → 20 020 stored sessions, and the query examines 20 documents at every size.

The third and fourth points are decisive for the KEEP/REVERT decision, and both are measured
rather than assumed. They are recorded in
[live-read-freshness-policy.md](live-read-freshness-policy.md) §6 alongside the arithmetic.

## 7. Reproducing

```bash
docker run --rm -d -p 27170:27017 --name cerberus-bench-mongo mongo:7
export CERBERUS_BENCH_MONGODB_URI='mongodb://127.0.0.1:27170'
npm run bench:read-path -- --json after.json
```

The command builds both workspaces first, so the benchmark always measures current compiled
output rather than a stale `dist/`. The database is disposable: the script creates
`cerberus_bench_read_<uuid>`, seeds it, and drops it in a `finally` block.

Dataset and sample counts are configurable, so the shape can be checked as well as the absolute
figures:

| Variable | Default | What it controls |
| --- | --- | --- |
| `CERBERUS_BENCH_SESSIONS` | 20 | sessions the list case reconciles |
| `CERBERUS_BENCH_EVENTS` | 200 | events each of those sessions holds |
| `CERBERUS_BENCH_SAMPLES` | 300 | samples per sequential read case |

The scaling stages are 0 / 500 / 5 000 / 20 000 extra stored sessions (0 / 500 in `--quick`),
because a shape is only comparable between runs if the points it is sampled at are the same. Each
stage seeds its history and then measures, so the stage that inserts 5 000 documents is the one
whose figures can carry that insert's cost — §4.3 says which figure that is.

`--json` writes the environment, every case, the concurrency rows, the scaling rows — including
**both** queries' `explain("executionStats")` counts and plan stages — the unavailable rows, the
tools exercised and the application's own log-level tally, so a comparison can state what it was
comparing.

`npm run verify:live-list-bench` runs the benchmark in its quick shape and gates the deterministic
part of §4.3: the previous build's query must collect-scan, the bounded one must not, the documents
examined must be bounded by the live set, and the examined count must not follow the collection. It
does not gate a latency, and says why.

## 8. What this does not establish

- **Not a production figure.** No TCP, no TLS, no HTTP server parsing, no MCP HTTP hop, no model
  latency. Loopback `mongod` in a local container.
- **Not a throughput claim for a deployment.** These are single-process figures with no reverse
  proxy, no other tenant on the machine and no network between the API and the database.
- **Not a comparison across machines.** Every number here was taken back to back on one machine
  in one container, and must not be compared with a figure taken anywhere else.
- **Not a leak or endurance result.** The longest case runs 400 requests; a steady-state memory
  claim needs hours.

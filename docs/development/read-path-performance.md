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
| Commit | `a9f5079c57dcaac6c6fa0610746443a84107bf94` |
| Dataset | 20 sessions × 200 events = 4 000 event documents |
| Warm-up | 10 % of each case's samples (minimum 5) |
| Samples | 300 per read case, 150 for the list and review cases, 400 per concurrency row |

The dataset is seeded **through the real ingest route**, so the documents are written by the
production code path and the process under measurement holds exactly the sessions a running
deployment would hold.

## 4. Results

### 4.1 The read surfaces

| Case | n | p50 ms | p95 ms | p99 ms | max ms | persistence calls/request | statuses |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Live detail — this process holds the session | 300 | **1.36** | **1.96** | 2.40 | 2.85 | **1.00** | 200 ×300 |
| Live detail — after restart (memory empty) | 300 | **1.13** | **1.61** | 2.00 | 2.13 | **1.00** | 200 ×300 |
| Live list — 20 sessions | 150 | **1.59** | **2.34** | 2.77 | 2.87 | **1.00** | 200 ×150 |
| Review detail — durable evidence | 150 | **6.55** | **8.73** | 9.92 | 10.65 | **1.00** | 200 ×150 |
| Live detail — missing session | 300 | 1.08 | 1.43 | 1.81 | 3.38 | 1.00 | 404 ×300 |
| Live detail — terminated session | 300 | 1.08 | 1.42 | 1.56 | 1.76 | 1.00 | 200 ×300 |

Three things this says:

**The durable read is one bounded round trip, and it is cheap.** Every read surface makes
**exactly one** call to the persistence layer per request. The live list makes one call for the
whole page of 20 sessions — it has not acquired the per-session N+1 the list path was designed
to avoid.

**The live detail costs about 1.4 ms p50, not 3.49 ms.** That is *with* the durable read
included and *with* a real network round trip to a real server. The stubbed benchmark reports a
larger number for the same route on the same machine, which is worth understanding rather than
averaging away — see §5.

**A restart is not a slower case.** "After restart" is 1.13 ms p50 against 1.36 ms for a process
that holds the session, which is inside run-to-run noise. Nothing is lazily loaded on the read
path, so a cold process answers the first request exactly as it answers the thousandth.

**The review detail is the expensive read** at 6.55 ms p50 — about 5× the live detail. That is
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
| Live detail | 1 | 400 | 831 | 1.12 | 1.78 | 2.18 | 1.00 |
| Live detail | 8 | 400 | **1 849** | 3.96 | 6.05 | 13.39 | 1.00 |
| Live detail | 32 | 400 | 1 841 | 16.26 | 27.09 | 39.21 | 1.00 |
| Live list | 1 | 400 | 686 | 1.37 | 1.85 | 2.21 | 1.00 |
| Live list | 8 | 400 | **1 483** | 5.06 | 7.98 | 8.49 | 1.00 |
| Live list | 32 | 400 | 1 069 | 28.80 | 50.56 | 52.23 | 1.00 |

**Throughput stops improving at eight concurrent callers.** The live detail goes 831 → 1 849
req/s from 1 to 8 and then is flat to 32, while p99 rises from 2.18 ms to 39.21 ms; the live
list peaks at 8 and *falls* to 1 069 at 32 with a p99 of 52 ms. Past the knee, adding
concurrency adds queueing rather than throughput.

That knee is a property of this process on this machine — one Node event loop, one driver
connection pool — and it is the number a capacity statement has to be built on. It is **not**
evidence about the storage layer: the same measurement against a stub would find a different
knee, and against a remote or replica-set MongoDB it would find another.

### 4.3 Scaling — read cost against the size of the durable store

The cases above run against 20 sessions, which is not enough to see a query that is unbounded in
the number of **historical** sessions. This section seeds extra sessions **directly through the
store** — history this process never held, which is exactly the durable-only case the list's
batched query exists to cover — and measures both read surfaces at each size. One session in five
is seeded `active` and the rest `terminated`, because a real deployment accumulates far more
finished sessions than live ones.

| Stored sessions | Live rows returned | Live **list** p50 | p95 | p99 | Live **detail** p50 | p95 | p99 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 20 | 20 | 2.53 ms | 5.23 ms | 16.21 ms | 1.45 ms | 2.30 ms | 2.81 ms |
| 520 | 120 | 10.21 ms | 12.92 ms | 16.21 ms | 1.17 ms | 2.01 ms | 2.21 ms |
| 5 020 | 1 020 | **75.58 ms** | **85.40 ms** | 92.42 ms | **0.98 ms** | **1.16 ms** | 1.20 ms |

**This is the read-path scaling result, and it is not where the charter expected it.**

- **The live detail is flat.** 1.45 ms → 1.17 ms → 0.98 ms as the store grows 250×. It is a
  lookup on the unique `sessionId` index, so it is `O(log n)` in the store and effectively
  constant at these sizes. Whatever the live detail's 1.4 ms is made of, it is not the number of
  sessions in the database.
- **The live list grows linearly with the total number of stored sessions.** 2.53 ms → 10.21 ms
  → 75.58 ms p50 for 20 → 520 → 5 020 stored sessions. At 5 020 stored sessions it is **30×**
  its 20-session cost and its p95 is 85 ms.

The cause is one line. `MongoStore.listSessions` issues:

```js
this.collection("sessions").find({}, { projection: { … } }).sort({ createdAt: -1 }).toArray()
```

There is no filter and no limit. It returns **every session document ever created** — the
terminated and long-expired ones included — and the route then reads all of them, reconciles all
of them, and discards the ones that are not live. At 5 020 stored sessions the response carries
1 020 live rows out of 5 020 documents read.

So the batched query is bounded in the sense that matters for the N+1 question — one query, not
one per session — but it is **not bounded in the size of the store**, and the cost is paid on
every request by every replica. A deployment with a few hundred monitored sessions a day
accumulates `active`-but-expired documents indefinitely, because expiry is derived and never
persisted, so this grows without limit.

That is a real limit and it is recorded as its own change: the durable list query is given a
bound that preserves the current answer exactly (see
[live-read-freshness-policy.md](live-read-freshness-policy.md) §6.4 for why the live detail was
*not* the surface worth optimising, and §9 for what this implies for the cache question).

### 4.4 Store unavailable

The store is genuinely disconnected mid-run, so the failure travels the real driver and the real
tool registry (`MongoStore.dbOrThrow` raises it) rather than being simulated by a stub that
throws.

| Case | n | p50 ms | p95 ms | p99 ms | statuses | required answer |
| --- | --- | --- | --- | --- | --- | --- |
| Store down — this process holds the session | 100 | 0.13 | 0.16 | 0.19 | 200 ×100 | labelled `process-local`, not a claim of durable truth |
| Store down — nothing holds the session | 100 | 0.21 | 0.27 | 0.36 | 503 ×100 | `SESSION_STORE_UNAVAILABLE`, never a `404` |
| Store down — live list | 100 | 0.18 | 0.25 | 0.34 | 200 ×100 | `reconciled: false`, every row `statusSource: "process-local"` |

Every status is the one the contract requires, and the failing path is **faster** than the
working one (0.13 ms against 1.36 ms) because it fails before reaching the database. A dependency
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
measurement above is comparable at 1.36 ms p50 with an actual network round trip included.

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
- **The read costs about 1.4 ms p50 and 2.0 ms p95** against a loopback `mongod`, on a machine
  that also runs the API process under measurement — and it is **flat in the size of the store**
  (1.45 ms at 20 sessions, 0.98 ms at 5 020), because it is a lookup on a unique index.
- **One process serves about 1 850 live-detail requests per second** at its best concurrency.
- **The console polls the review detail, not the live detail.** Its steady-state load on the
  live detail is zero while the primary endpoint answers. That audit is recorded separately and
  is cross-referenced from [live-read-freshness-policy.md](live-read-freshness-policy.md) §6,
  which carries the arithmetic.
- **The surface that does not scale is the live list, not the live detail** (§4.3): 2.53 ms at
  20 stored sessions, 75.58 ms at 5 020, because its durable query is `find({})` with no bound.
  That is a query-shape problem, not a staleness problem, and the answer to it is a bounded
  query rather than a cache — which is why it does not change the freshness contract at all.

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

The scaling stages are fixed at 0 / 500 / 5 000 extra stored sessions (0 / 500 in `--quick`),
because a shape is only comparable between runs if the points it is sampled at are the same.

`--json` writes the environment, every case, the concurrency rows, the scaling rows, the
unavailable rows, the tools exercised and the application's own log-level tally, so a comparison
can state what it was comparing.

## 8. What this does not establish

- **Not a production figure.** No TCP, no TLS, no HTTP server parsing, no MCP HTTP hop, no model
  latency. Loopback `mongod` in a local container.
- **Not a throughput claim for a deployment.** These are single-process figures with no reverse
  proxy, no other tenant on the machine and no network between the API and the database.
- **Not a comparison across machines.** Every number here was taken back to back on one machine
  in one container, and must not be compared with a figure taken anywhere else.
- **Not a leak or endurance result.** The longest case runs 400 requests; a steady-state memory
  claim needs hours.

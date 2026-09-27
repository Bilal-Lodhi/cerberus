# Local performance baseline

A measured baseline for Cerberus's own request handling, so a regression can be
attributed to this code rather than guessed at.

```
npm run bench                      full run (~1 minute)
npm run bench -- --quick           fewer iterations, for a smoke check
npm run bench -- --json out.json   also write the raw results
```

## Methodology

The benchmark drives the **compiled API in process**, through `app.request()`, with
the persistence layer and the AI provider replaced by in-process stubs. No MongoDB,
no network, no paid inference, no container warm-up.

**What that measures:** routing, authentication, body handling, validation,
deduplication, session state, response building — everything Cerberus itself does.

**What it does not measure:** TCP and TLS, HTTP parsing in a real server, MongoDB
round trips, or model latency. **A number here is a floor, not an end-to-end
latency.** `scripts/stress-telemetry.ps1` drives a running instance over HTTP and is
the tool for the other question.

Every case warms up for 10% of its iterations before sampling, because the first
iterations pay for JIT compilation and would measure the runtime rather than the
code. Latencies are reported as p50 / p95 / p99 with the sample count: request
latency is right-skewed, a mean hides the tail, and the tail is what an operator
experiences.

The limiter is **disabled** for the baseline, so these figures measure the
application rather than bucket arithmetic. It has its own tests.

### The stubs must match the real store's bounds

This is not a footnote. An earlier version of this benchmark reported a **quadratic
ingest cost** — a 29× throughput loss between an empty session and one holding 5 000
events — and it was wrong. The cause was the benchmark's own MCP double: it returned
*every* event from `get_session_review`, while the real store caps that at 500
(`MongoStore.getSessionEvents`, `limit ?? 500`). The double re-serialised a growing
array on every ingest, and the growth was attributed to the application.

The same mistake has appeared **five** times in this repository's history: a review
route that assumed a sort order the real store does not provide; a test double that did
not deduplicate events the way the unique index does; the event cap above; and — in this
very document, for four further releases — a double that ignored the `eventsLimit` and
`includeAssessments` arguments the API sends and so returned 500 events per call where
the real store returns none. **A double that does not match the real store's bounds
measures the double.**

The doubles now live in `scripts/bench/mcp-double.mjs` and are compared against the real
tool registry by `apps/api/test/bench-double.test.ts`, because the previous four
occurrences were each fixed by *editing the double* and none was fixed by making the
double checkable. See §"The double ignored the read bounds".

## Environment

| | |
| --- | --- |
| Node | v24.19.0 |
| Platform | win32 / x64 |
| CPU | AMD Ryzen 5 5600G, 12 logical cores |
| Run | `npm run bench` (full), `--expose-gc` for the memory figure |

Absolute numbers are machine-specific. **The shape and the ratios are the durable
part**, and they are what a future run should be compared against.

> **The tables below were re-measured after the benchmark's own MCP double was corrected.**
> The double had been ignoring the `eventsLimit` and `includeAssessments` bounds the API sends,
> so it returned up to 500 micro-events the real store never returns — see
> §"The double ignored the read bounds" for what that did to the published figures. Every
> number in this section is from the corrected double; the superseded figures are quoted in
> that section rather than deleted, because the error is the finding.

## Results

### Request handling

`main` at the commit that corrected the double, `npm run bench` (full), corrected double:

| Case | n | req/s | p50 ms | p95 ms | p99 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /health` | 2000 | 18 299 | 0.05 | 0.10 | — | — |
| `POST /guardian/ingest` (oversized → 413) | 300 | 10 900 | 0.08 | 0.15 | — | — |
| `GET /api/v1/sessions` (401, unauthenticated) | 2000 | 9 944 | 0.08 | 0.18 | — | — |
| `GET /api/v1/sessions` | 1000 | 9 514 | 0.09 | 0.19 | — | — |
| `GET /guardian/sessions/:id` (live detail) | 1000 | 9 411 | **0.10** | **0.16** | — | — |
| `POST /guardian/ingest` (1 KEYSTROKE) | 1000 | 4 409 | 0.20 | 0.38 | — | — |
| `POST /guardian/ingest` (50 events) | 300 | 1 548 | 0.57 | 0.93 | — | — |
| `POST /guardian/ingest` (50 replayed events) | 300 | 2 099 | 0.43 | 0.70 | — | — |
| `POST /guardian/ingest` (analysis) | 300 | 1 897 | 0.49 | 0.74 | — | — |
| `GET /api/v1/sessions` (20×200 history) | 300 | 1 823 | 0.51 | 0.75 | — | — |
| `GET /api/v1/sessions/:id` (review detail) | 500 | 442 | 2.06 | 3.22 | — | — |
| `GET /guardian/sessions` (live list) | 1000 | 388 | 2.41 | 3.51 | — | — |

The p99 and max columns are omitted because a single run's tail on a shared desktop-class CPU
is not reproducible to two decimal places and the previous revision's tail figures were quoted
as though they were. The p50 and p95 columns above are stable across repeated runs to within
the noise noted in §"Reading the numbers".

**What changed, and it is not a small correction.** The live detail went from a published
**1.21 ms p50** to **0.10 ms**; ingest of one keystroke from **1.36 ms** to **0.20 ms**; ingest
of 50 events from **2.10 ms** to **0.57 ms**; and the review list with 20×200 history from
**10.28 ms** to **0.51 ms**. None of that is a code change. It is the double.

### Ingest cost against session size

The same single-event request, against sessions holding different amounts of history:

| Events already held | n | req/s | p50 ms | p95 ms | p99 ms |
| --- | --- | --- | --- | --- | --- |
| 0 | 200 | 5 291 | 0.17 | 0.31 | 0.36 |
| 100 | 200 | 4 427 | 0.18 | 0.35 | 0.39 |
| 500 | 200 | 4 769 | 0.17 | 0.34 | 0.37 |
| 1 000 | 200 | 5 386 | 0.16 | 0.31 | 0.34 |
| 2 500 | 200 | 5 849 | 0.15 | 0.26 | 0.30 |
| 5 000 | 200 | 4 926 | 0.15 | 0.28 | 0.36 |

**There is no step, and there never was one in the application.** The previous revision
reported a rise from 0.53 ms to about 1.3–1.4 ms between an empty session and one holding 500
events, and explained it as the review fetch carrying up to 500 events — while noting that
`get_session_review` had since gained `eventsLimit`/`includeAssessments` and that ingest now
passes `0` and `false`. The explanation was right and the conclusion drawn from it was wrong:
the benchmark's double had **not** been updated to honour those arguments, so it went on
returning 500 events per call. The step was the double's serialisation work.

With the double corrected, ingest is flat in a session's history — and slightly *faster* at
5 000 events than at 0, which is run-to-run noise rather than a real improvement.

### Memory

5 000 events ingested into one session, with the MCP double replaced by a sink that
retains nothing, so the heap delta is what Cerberus holds rather than what the double
holds beside it:

```
heap 28.5 MiB -> 33.2 MiB   (+4.7 MiB, ~991 B/event)
```

**Treat this figure with care, and treat the bound as the real result.** A heap delta
in one process includes V8 bookkeeping and anything else allocated during the run, so
it cannot isolate the session store. What *is* deterministic is the bound, asserted in
`apps/api/test/session-memory-window.test.ts`: after 20 000 events, `session.events`
stays at or below `2 * MAX_IN_MEMORY_EVENTS` and `session.keystrokeDeltas` at or below
`2 * MAX_KEYSTROKE_DELTAS`.

Before the window existed, `session.events` grew for a session's whole lifetime —
`MAX_EVENTS_PER_BATCH` bounds one request, not a session. A length assertion can prove
a bound; a heap figure cannot, because several things contribute to it.

This is not a leak test. A leak needs hours.

## Reading the numbers

**The cheap paths are genuinely cheap.** Health, an unauthenticated rejection, and an
oversized-body rejection all sit at 9 900–18 300 req/s with p95 at or under 0.18 ms. The
body limit rejects before buffering, which is why a 9 MiB claim costs 0.08 ms.

**The dedup fast path is ~1.4× faster than a fresh batch** (2 099 vs 1 548 req/s for 50
events). A replayed batch is cheap as well as correct, which is what the idempotency
work was aiming for.

**A request that triggers analysis is not the slowest ingest path** (1 897 req/s vs
4 409 for a plain keystroke) — the analysis case runs against a fresh session each
time, so it carries less session state than the keystroke case, which by then has
thousands of events behind it.

**`GET /api/v1/sessions/:id` (review detail) and `GET /guardian/sessions` (live list) are
the most expensive reads**, at 2.06 ms and 2.41 ms p50. The review detail assembles the
timeline and the risk summary from one bounded review fetch; the live list reconciles the
whole page against durable truth in one batched query.

## What this baseline found, honestly

Two real defects, one wrong finding the baseline was corrected for, and one wrong finding
this revision corrected.

**Real:** `session.events` and `session.keystrokeDeltas` had no bound, so a live
session's memory grew for its lifetime and every consumer that scanned those arrays
got slower as it did. `hasAnomalousKeystrokes` scanned the entire keystroke history on
every single event, and `computeKeystrokeMetrics` used `Math.max(...deltas)`, which
throws `RangeError: Maximum call stack size exceeded` past roughly 100 000 entries.
Both are fixed, and the fix is proved by a length assertion rather than a heap figure.

**Wrong, and corrected:** the quadratic ingest cost reported by the first version of
this benchmark was an artifact of a stub that did not match the real store's event
cap. The corrected measurement plateaus.

**Wrong, and corrected again:** the live-detail ratio published by the previous revision —
and the whole "ingest cost plateaus at a higher level because of the review fetch"
explanation — were artifacts of the same class of error, in the same double, for four more
releases. See §"The double ignored the read bounds".

The failure mode — a double that measures itself — has now appeared **five** times in this
repository: the quadratic ingest cost, the review route that assumed a sort order the real
store does not provide, the test double that did not deduplicate events the way the unique
index does, the benchmark double that ignored the event cap, and now the benchmark double
that ignored the read bounds. It is worth recognising on sight, which is why the benchmark's
doubles are now a module with a fidelity suite rather than closures inside a script.

## The double ignored the read bounds

This is the finding that reframes the read-path cycle, so it is recorded in full.

### What the double did

`scripts/bench/run-bench.mjs` drove the application through an in-process MCP double. Its
`get_session_review` case read:

```js
const all = events.get(id) ?? [];
return Response.json({
  success: true,
  session: sessions.get(id) ?? null,
  events: all.slice(-500),      // ← both arguments ignored
  riskAssessments: [],
});
```

`body.eventsLimit` and `body.includeAssessments` were never read. The real store, given
`eventsLimit: 0`, **skips the events query entirely** — `packages/mcp-mongodb/src/tools.ts`
resolves it to `Promise.resolve([])` rather than passing `0` to the driver, where `.limit(0)`
means "no limit".

The API passes exactly that on its hot paths. `ensureMongoSession` (every ingest) and
`readDurableSessionDocument` (every live-detail read) both send
`{ sessionId, eventsLimit: 0, includeAssessments: false }`, and the review list sends
`{ eventsLimit: 0, assessmentsLimit: 1 }`. So the double made **every ingest, every
live-detail read, and every review-list row** carry up to 500 micro-event documents that the
real store never returns, and the API discarded all of them.

### What it did to the numbers

Same machine, back to back, same benchmark code, only the double changed:

| Case | Published (double ignored the bounds) | Corrected | Ratio |
| --- | --- | --- | --- |
| Live detail | 1.21 ms p50 | **0.10 ms** | 12× |
| Ingest (1 KEYSTROKE) | 1.36 ms | **0.20 ms** | 7× |
| Ingest (50 events) | 2.10 ms | **0.57 ms** | 4× |
| `GET /api/v1/sessions` (20×200 history) | 10.28 ms | **0.51 ms** | 20× |
| Ingest into a 500-event session | 1.52 ms | **0.22 ms** | 7× |

And the published live-surface comparison — `v0.4.0` at 0.09 ms against `main` at 3.49 ms,
a ratio of **38×** — was measuring the double. The real-Mongo measurement of the same route
is **1.36 ms p50**, round trip included; see
[read-path-performance.md](read-path-performance.md).

### Why the previous revision could not see it

Two reasons, and both are structural rather than careless.

**The double was a closure.** It lived inside `run-bench.mjs`, so no test could drive it and
the real tool registry through the same call and compare the answers. `bench-config.test.ts`
asserted the *config literal* covered every `AppConfig` key — which it did — and nothing
asserted the double matched the store.

**The document already said the double was out of date.** The previous revision's ingest-scaling
section reads: *"the benchmark in `scripts/bench/run-bench.mjs` still drives the old request
shape and will be updated with the review-fetch work (exit criterion G)"*. The update never
happened, and the section's own conclusion — that the step was a bounded cost of the
application — was drawn from the stale shape.

### What now prevents a repeat

`scripts/bench/mcp-double.mjs` holds both doubles and honours both bounds, and
`apps/api/test/bench-double.test.ts` drives the same `get_session_review` call through the
benchmark's double **and** through the real `createToolRegistry` over the verified store double,
asserting the two return the same event window and the same assessment window for seven
different bound combinations. Against the pre-fix double, nine of its ten cases fail.

## Reproducing

```bash
npm run bench
```

The command builds the API first, so the benchmark always measures current compiled
output rather than a stale `dist/`. Run it before and after a change to a hot path;
compare p50 and p95 for the affected case, and re-check the scaling table for a step.

To compare against a recorded run:

```bash
npm run bench -- --json before.json     # on the baseline commit
npm run bench -- --json after.json      # after the change
```

`scripts/bench/run-bench.mjs` writes the environment, every case, the ingest-scaling rows, the
memory figures **and the per-tool call counts** into the JSON, so a comparison can state what
it was comparing — and can check that a case made the calls it claims to make.

## The review-list read: before and after

`GET /api/v1/sessions` issues one `get_session_review` per session. Each one used to ask for
the default, which is **up to 500 micro-events plus every risk assessment** — so the work
grew with each session's *history* rather than with the number of sessions, and every
document it carried was then discarded.

Nothing in those events was load-bearing. Every counter the route re-derived from them is
already durable on the session document, written on every ingest with `$max`, so it is
monotonic and hydrated across a restart. The one genuinely event-derived field was a display
timestamp, and the durable `updatedAt` answers the same question from a trustworthy source.

The read now asks for `eventsLimit: 0` — the query is skipped outright — and
`assessmentsLimit: 1`, because a single `riskScore` needs only the newest assessment.

### The measurement

Deterministic, and asserted in `apps/api/test/review-list-bounds.test.ts`:

| Corpus | Event documents carried | Assessments carried |
| --- | --- | --- |
| Before | 20 sessions × 500 events → **10 000** | 20 sessions × 3 → **60** |
| After | **0** | **20** |

The "before" figure is exact rather than estimated: it is `sessions × min(500, events)`,
because 500 is the store's own documented default cap in `MongoStore.getSessionEvents`. The
numbers are asserted rather than timed, because a duration depends on the machine and on a
test double — and this document already records two occasions when this script's own double
produced a *false* finding.

### The latency shape

`npm run bench`, which seeds history behind the list before measuring it, with the corrected
double:

```
case                                         n      req/s   p50 ms   p95 ms
GET /api/v1/sessions                      1000       9514     0.09     0.19
GET /api/v1/sessions (20×200 history)      300       1823     0.51     0.75
```

The second row used to read **10.32 ms p50 / 13.30 ms p95**, and the previous revision
concluded from it that *"with 20 sessions the route makes 20 sequential round trips to the
persistence adapter, and those dominate"*. That was wrong twice over: the route makes **one
batched query** for the page, not twenty, and the 10.32 ms was 20 × 500 event documents the
double returned and the route discarded.

With the double corrected the cost is **0.51 ms** — a 20× reduction that required no change to
the route at all. The remaining difference between the two rows is the reconciliation work over
20 sessions, not 20 round trips.

## The live-surface reconciliation: a real before/after

The `v0.5.0` cycle made the live list and the live detail reconcile against durable truth on
every request. That is work added to two hot paths, and until this measurement existed the
repository had **no baseline to compare it with** — the maturity plan recorded a current number
and stated honestly that no before/after existed.

**This section was re-measured after the double was corrected, and the previous revision's
conclusion does not survive.** It is kept here in full rather than replaced, because the way it
was wrong is more useful than the number it got.

### How it was produced, and why it is a fair comparison

| Aspect | Value |
| --- | --- |
| **Before** | `v0.4.0`, tag target `ed14728f9dfeaace841474b909ecfba15cd6feb3` |
| **After** | `main`, the commit that corrected the benchmark's MCP double |
| Machine | the same physical machine, back to back |
| CPU | AMD Ryzen 5 5600G, 12 logical CPUs |
| OS | `win32/x64` |
| Node | `v24.19.0` for both |
| MongoDB | **not involved** — see below |
| Dataset | whatever the benchmark's own stub seeds, identically for both |
| Samples | the benchmark's own counts: 1 000 for the live list and live detail, with its 10 % warmup |

Three things make this a comparison rather than two unrelated numbers:

1. **The same benchmark code ran against both builds.** The current
   `scripts/bench/run-bench.mjs`, `bench-config.mjs` and `mcp-double.mjs` were copied into a
   disposable `v0.4.0` worktree and pointed at that build's `dist`. Same cases, same doubles,
   same sample counts, same warmup.
2. **The two live-surface cases were added by this cycle**, because the nine existing ones
   measure the *review* surfaces and ingestion — **not** the live ones. Without them there was
   nothing to compare.
3. **MongoDB is not in the loop.** The benchmark drives the app in-process with the persistence
   adapter stubbed, so it measures the *application's* work. That is exactly why it **cannot**
   price the durable read: a "durable read" here is a function call plus a JSON round trip.

### The result, with the corrected double

| Case | `v0.4.0` p50 | `main` p50 | Δ p50 | `v0.4.0` p95 | `main` p95 |
| --- | --- | --- | --- | --- | --- |
| Live detail | 0.04 ms | **0.10 ms** | +0.06 ms | 0.09 ms | 0.16 ms |
| Live list | 1.57 ms | **2.41 ms** | +53 % | 3.23 ms | 3.51 ms |
| Review detail `GET /api/v1/sessions/:id` | 1.82 ms | 2.06 ms | +13 % | 2.80 ms | 3.22 ms |
| `GET /api/v1/sessions` (20×200 history) | 0.70 ms | 0.51 ms | −27 % | 1.52 ms | 0.75 ms |
| `POST /guardian/ingest` (1 KEYSTROKE) | 0.29 ms | 0.20 ms | −31 % | 0.57 ms | 0.38 ms |
| `POST /guardian/ingest` (50 events) | 0.60 ms | 0.57 ms | −5 % | 1.01 ms | 0.93 ms |
| `POST /guardian/ingest` (analysis) | 0.50 ms | 0.49 ms | −2 % | 1.18 ms | 0.74 ms |
| `GET /api/v1/sessions` (401) | 0.09 ms | 0.08 ms | −11 % | 0.19 ms | 0.18 ms |
| `GET /api/v1/sessions` | 0.08 ms | 0.09 ms | +13 % | 0.16 ms | 0.19 ms |
| `POST /guardian/ingest` (oversized 413) | 0.08 ms | 0.08 ms | 0 % | 0.14 ms | 0.15 ms |
| `GET /health` | 0.04 ms | 0.05 ms | +25 % | 0.09 ms | 0.10 ms |

### What it says

**The previous revision's headline — "the live detail is the whole story, and the story is 38×" —
was a measurement of the benchmark's own double.** It reported `v0.4.0` at 0.09 ms against
`main` at 3.49 ms p50. With the double corrected, the same case is **0.04 ms against 0.10 ms**:
a difference of **0.06 milliseconds**, which is the entire route-local cost of the durable read
in this harness.

That is the correct reading, and it is unsurprising: in this harness the durable read is a
function call. A benchmark whose persistence layer is a closure **cannot** price a database
round trip, and the 3.4 ms it reported was 500 micro-event documents being serialised per
request — see §"The double ignored the read bounds".

**The live list is the surface that moved**, at +53 % p50 and +9 % p95. It is the one read path
where the reconciliation work is real work in this harness: it builds the local view, merges it
against the durable page, and repairs the cache, all of which happens in-process. It is a real
cost and it is bounded.

**The sub-0.2 ms rows are noise.** Repeated runs on this machine put the live detail anywhere
between 0.04 and 0.11 ms p50 and health between 0.04 and 0.05 ms, so the ±25 % movements in the
cheap rows are not changes. The ingest rows moving *negative* is the same noise from the other
direction.

**The real cost of the durable read is measured somewhere else.** Against a real MongoDB, with a
real driver and a real round trip, the live detail is **1.36 ms p50 / 1.96 ms p95** and the live
list **1.59 ms / 2.34 ms** — see [read-path-performance.md](read-path-performance.md). That is
the number a cache would have to beat, and it is roughly 14× the 0.10 ms this harness can see.

### What this does not establish

- **Not a production figure.** No TCP, no TLS, no HTTP server parsing, no MongoDB, no model
  latency. The benchmark's own `env.note` says so in every JSON run.
- **Not a throughput claim.** These are single-request latencies from an in-process
  `app.request()` loop with no concurrency.
- **Not a price for the durable read at all.** The persistence layer is a double; the round trip
  it does not make is the thing the read-path cycle was about.
- **Not a comparison across machines.** Both runs were back to back on one machine, and no
  number here may be compared with a figure taken anywhere else.

### The benchmark itself was broken, and that is how this was found

Running it to produce the "before" number surfaced a defect worth recording: `benchConfig()`
never gained the `log` field that `createApp` reads unconditionally, so `npm run bench` — the
command this document calls the reproducible way to produce the baseline — threw
`Cannot read properties of undefined` **before a single case ran**. It had been broken from
`v0.4.0` onward, through four releases, and nothing noticed because no test ran it and no gate
named it.

That is a worse failure than a slow path: the document went on describing a baseline nobody
could reproduce, and every figure in it silently stopped being comparable. Two things now
prevent a repeat. `benchConfig()` carries the fields, and
`apps/api/test/bench-config.test.ts` asserts the literal covers **every** top-level key
`makeConfig()` produces — in both directions, with a third case asserting the extraction is not
empty so the check cannot pass vacuously.

**The same class of failure then recurred inside the double, which is the larger lesson.** The
config literal was guarded; the double's *behaviour* was not. It is now:
`scripts/bench/mcp-double.mjs` is a module and `apps/api/test/bench-double.test.ts` compares it
against the real tool registry for seven bound combinations, failing nine of its ten cases
against the pre-fix double.

The two live-surface cases were added at the same time, which is what makes this section
possible at all.
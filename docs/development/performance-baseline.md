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

The same mistake has appeared twice elsewhere in this repository's history: a review
route that assumed a sort order the real store does not provide, and a test double
that did not deduplicate events the way the unique index does. **A double that does
not match the real store's bounds measures the double.** Both the event cap and the
memory isolation below are now explicit in the script, with comments saying why.

## Environment

| | |
| --- | --- |
| Node | v24.19.0 |
| Platform | win32 / x64 |
| CPU | AMD Ryzen 5 5600G, 12 logical cores |
| Run | `npm run bench` (full), `--expose-gc` for the memory figure |

Absolute numbers are machine-specific. **The shape and the ratios are the durable
part**, and they are what a future run should be compared against.

## Results

### Request handling

| Case | n | req/s | p50 ms | p95 ms | p99 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /health` | 2000 | 33 681 | 0.03 | 0.04 | 0.07 | 0.55 |
| `POST /guardian/ingest` (oversized → 413) | 300 | 29 290 | 0.03 | 0.05 | 0.07 | 0.14 |
| `GET /api/v1/sessions` (401, unauthenticated) | 2000 | 26 615 | 0.03 | 0.07 | 0.11 | 0.88 |
| `GET /api/v1/sessions` | 1000 | 13 656 | 0.07 | 0.11 | 0.16 | 0.78 |
| `POST /guardian/ingest` (analysis) | 300 | 2 010 | 0.44 | 0.75 | 1.24 | 1.79 |
| `POST /guardian/ingest` (50 replayed events) | 300 | 1 982 | 0.47 | 0.56 | 1.30 | 3.10 |
| `POST /guardian/ingest` (1 KEYSTROKE) | 1000 | 837 | 1.25 | 1.86 | 2.65 | 3.28 |
| `POST /guardian/ingest` (50 events) | 300 | 582 | 1.59 | 1.95 | 4.91 | 6.45 |
| `GET /api/v1/sessions/:id` | 500 | 466 | 1.81 | 3.93 | 6.85 | 9.62 |

### Ingest cost against session size

The same single-event request, against sessions holding different amounts of history:

| Events already held | n | req/s | p50 ms | p95 ms | p99 ms |
| --- | --- | --- | --- | --- | --- |
| 0 | 200 | 1 733 | 0.53 | 0.89 | 1.56 |
| 100 | 200 | 1 347 | 0.67 | 1.06 | 2.06 |
| 500 | 200 | 618 | 1.40 | 2.32 | 4.39 |
| 1 000 | 200 | 690 | 1.29 | 1.63 | 5.66 |
| 2 500 | 200 | 720 | 1.27 | 1.63 | 5.90 |
| 5 000 | 200 | 611 | 1.44 | 2.41 | 4.34 |

**The cost plateaus.** It rises from 0.53 ms to about 1.3–1.4 ms between an empty
session and one holding 500 or more events, then stays flat from 500 to 5 000. That
is the shape of a bounded cost, not a growing one.

The step is the review fetch: `get_session_review` returned up to 500 events, so an
ingest against a session with history carried that response while one against a fresh
session carried nothing. **It was a real, bounded cost and a real optimisation
opportunity** — ingest does not need 500 events to decide whether to analyse — but it
is a constant, not a scaling problem.

**That opportunity has since been taken.** `get_session_review` gained optional
`eventsLimit` and `includeAssessments` arguments, and ingest now passes `0` and
`false`: it consults only the session document, so the response no longer carries the
session's history at all. The step in the table above is the *pre-change* shape and is
kept as the record of what was measured; the benchmark in
`scripts/bench/run-bench.mjs` still drives the old request shape and will be updated
with the review-fetch work (exit criterion G), which also covers the per-session fetch
on the list path.

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
oversized-body rejection all sit at 26 000–34 000 req/s with p99 under 0.11 ms. The
body limit rejects before buffering, which is why a 9 MiB claim costs 0.03 ms.

**The dedup fast path is ~3.4× faster than a fresh batch** (1 982 vs 582 req/s for 50
events). A replayed batch is cheap as well as correct, which is what the idempotency
work was aiming for.

**A request that triggers analysis is not the slowest ingest path** (2 010 req/s vs
837 for a plain keystroke). The difference is session size, not the analysis: the
analysis case runs against a fresh session each time, so it carries no review
response.

**`GET /api/v1/sessions/:id` is the most expensive read** at 1.81 ms p50, because it
assembles the timeline and the risk summary from the same bounded review fetch.

## What this baseline found, honestly

One real defect, and one wrong finding that the baseline itself was corrected for.

**Real:** `session.events` and `session.keystrokeDeltas` had no bound, so a live
session's memory grew for its lifetime and every consumer that scanned those arrays
got slower as it did. `hasAnomalousKeystrokes` scanned the entire keystroke history on
every single event, and `computeKeystrokeMetrics` used `Math.max(...deltas)`, which
throws `RangeError: Maximum call stack size exceeded` past roughly 100 000 entries.
Both are fixed, and the fix is proved by a length assertion rather than a heap figure.

**Wrong, and corrected:** the quadratic ingest cost reported by the first version of
this benchmark was an artifact of a stub that did not match the real store's event
cap. The corrected measurement plateaus. The error is recorded here rather than quietly
removed, because the failure mode — a double that measures itself — has now appeared
three times in this repository and is worth recognising on sight.

## Reproducing

```bash
npm run bench
```

The command builds the API first, so the benchmark always measures current compiled
output rather than a stale `dist/`. Run it before and after a change to a hot path;
compare p50 and p99 for the affected case, and re-check the scaling table for the
plateau.

To compare against a recorded run:

```bash
npm run bench -- --json before.json     # on the baseline commit
npm run bench -- --json after.json      # after the change
```

`scripts/bench/run-bench.mjs` writes the environment, every case, and the memory
figures into the JSON, so a comparison can state what it was comparing.

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

`npm run bench`, which now seeds history behind the list before measuring it:

```
case                                         n      req/s   p50 ms   p95 ms   p99 ms    max ms
GET /api/v1/sessions                      1000      11901     0.08     0.13     0.22      0.83
GET /api/v1/sessions (20×200 history)      300         93    10.32    13.30    15.71     28.17
```

The second row is the honest current shape, and it is **not** a regression the amplification
fix was meant to remove: with 20 sessions the route makes 20 sequential round trips to the
persistence adapter, and those dominate. What the fix removed is the part that grew with a
session's history — the 10 000 event documents — not the per-session round trip, which is
inherent to a route that lists sessions.

So the remaining cost is `O(sessions)` with a constant per session, rather than
`O(sessions × history)`. The first row is the same route with nothing to list, which is why
it is two orders of magnitude faster.

## The live-surface reconciliation: a real before/after

The `v0.5.0` cycle made the live list and the live detail reconcile against durable truth on
every request. That is work added to two hot paths, and until this measurement existed the
repository had **no baseline to compare it with** — the maturity plan recorded a current number
and stated honestly that no before/after existed. This closes that, and the answer is large
enough to be worth stating plainly.

### How it was produced, and why it is a fair comparison

| Aspect | Value |
| --- | --- |
| **Before** | `v0.4.0`, tag target `ed14728f9dfeaace841474b909ecfba15cd6feb3` |
| **After** | `main` at the time of measurement |
| Machine | the same physical machine, back to back |
| CPU | AMD Ryzen 5 5600G, 12 logical CPUs |
| OS | `win32/x64` |
| Node | `v24.19.0` for both |
| MongoDB | **not involved** — see below |
| Dataset | whatever the benchmark's own stub seeds, identically for both |
| Samples | the benchmark's own counts: 1 000 for the live list and live detail, with its 10 % warmup |

Three things make this a comparison rather than two unrelated numbers:

1. **The same benchmark code ran against both builds.** The current
   `scripts/bench/run-bench.mjs` was copied into a disposable `v0.4.0` worktree and pointed at
   that build's `dist`. Same cases, same stub, same sample counts, same warmup.
2. **The two new cases were added by this cycle**, because the nine existing ones measure the
   *review* surfaces and ingestion — **not** the live ones. Without them there was nothing to
   compare.
3. **MongoDB is not in the loop.** The benchmark drives the app in-process with the persistence
   adapter stubbed, so it measures the *application's* work. That makes the ratio trustworthy
   and the absolute numbers not: a real deployment adds a database round trip to every case.

### The result

```
case                                      before p50   after p50   delta     before p95   after p95   delta
GET /guardian/sessions (live list)             2.93        3.39    +16 %          4.29        5.14   +20 %
GET /guardian/sessions/:id (live detail)       0.09        3.49  +3588 %          0.15        6.80 +4298 %
GET /api/v1/sessions (401)                     0.07        0.08    +19 %          0.16        0.18   +13 %
GET /api/v1/sessions                           0.08        0.09     +4 %          0.15        0.16    +8 %
GET /api/v1/sessions (20x200 history)         15.02       14.70     -2 %         20.77       20.41    -2 %
POST /guardian/ingest (1 KEYSTROKE)            1.98        2.26    +14 %          3.09        3.55   +15 %
POST /guardian/ingest (50 events)              3.11        3.24     +4 %          3.93        4.20    +7 %
POST /guardian/ingest (50 replayed)            0.92        0.91     -1 %          1.11        1.13    +2 %
POST /guardian/ingest (analysis)               0.78        0.85     +9 %          1.02        1.16   +14 %
GET /api/v1/sessions/:id                       3.57        3.26     -9 %          4.73        5.65   +20 %
POST /guardian/ingest (oversized 413)          0.17        0.17     -1 %          0.25        0.24    -4 %
GET /health                                    0.08        0.08     -1 %          0.13        0.13    +3 %
```

### What it says

**The live detail is the whole story, and the story is 38x.** At `v0.4.0` it answered from this
process's in-memory state — 0.09 ms, because it did not read anything. At `main` it reads the
durable session document on every request, which is 3.49 ms p50 and 6.80 ms p95. That is the
**cost of the correctness the `v0.5.0` cycle bought**: before, a session another replica had
terminated was reported `active` here, and the number was fast because it was wrong.

Two things make the size of that ratio unsurprising rather than alarming. The old path was pure
memory, so its denominator is near zero and a large ratio follows from any work at all. And the
case is measured with an **in-process** persistence stub, where a "durable read" is a function
call plus JSON serialisation — the 3.4 ms is the route's own work around it. Against a real
MongoDB the absolute figure would be dominated by the round trip, and the *ratio* would be
smaller.

**The live list moved 16 % at p50 and 20 % at p95**, which is the honest figure for a surface
that already issued one batched durable query and now issues a differently-shaped one. It is
not free and it is not dramatic.

**Everything else is inside run-to-run noise.** The largest non-live movement is the
1-KEYSTROKE ingest at +14 % p50, and the benchmark's own repeated runs vary by more than that
on a desktop-class machine with a shared CPU. Two cases moved *negative* (the 20x200 history
list at -2 %, the review detail at -9 % p50), which is the same noise from the other direction
and is the reason no other row is read as a change.

### What this does not establish

- **Not a production figure.** No TCP, no TLS, no HTTP server parsing, no MongoDB, no model
  latency. The benchmark's own `env.note` says so in every JSON run.
- **Not a throughput claim.** These are single-request latencies from an in-process
  `app.request()` loop with no concurrency.
- **Not a comparison across machines.** Both runs were back to back on one machine, and no
  number here may be compared with a figure taken anywhere else — including the earlier figures
  in this document, which were taken on this machine at other times and are quoted where they
  were produced rather than merged into this table.

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

The two live-surface cases were added at the same time, which is what makes this section
possible at all.
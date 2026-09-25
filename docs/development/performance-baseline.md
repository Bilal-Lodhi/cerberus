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

## Environment

| | |
| --- | --- |
| Node | v24.19.0 |
| Platform | win32 / x64 |
| CPU | AMD Ryzen 5 5600G, 12 logical cores |
| Run | `npm run bench` (full), `--expose-gc` for the memory figure |

Absolute numbers are machine-specific. **The ratios and the shape are the durable
part**, and they are what a future run should be compared against.

## Results

### Request handling

| Case | n | req/s | p50 ms | p95 ms | p99 ms | max ms |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /health` | 2000 | 33 841 | 0.03 | 0.04 | 0.06 | 1.44 |
| `POST /guardian/ingest` (oversized → 413) | 300 | 29 260 | 0.03 | 0.05 | 0.06 | 0.10 |
| `GET /api/v1/sessions` (401, unauthenticated) | 2000 | 26 678 | 0.03 | 0.06 | 0.11 | 1.06 |
| `GET /api/v1/sessions` | 1000 | 13 909 | 0.07 | 0.11 | 0.16 | 0.95 |
| `POST /guardian/ingest` (50 replayed events) | 300 | 1 902 | 0.48 | 0.56 | 1.59 | 5.46 |
| `POST /guardian/ingest` (1 KEYSTROKE) | 1000 | 603 | 1.57 | 2.77 | 4.95 | 9.20 |
| `GET /api/v1/sessions/:id` | 500 | 249 | 3.44 | 7.45 | 13.74 | 19.84 |
| `POST /guardian/ingest` (50 events) | 300 | 45 | 21.28 | 41.02 | 46.65 | 47.37 |

### Ingest cost against session size

**This is the finding that matters.** The same single-event request, against sessions
holding different amounts of history:

| Events already held | n | req/s | p50 ms | p95 ms | p99 ms |
| --- | --- | --- | --- | --- | --- |
| 0 | 200 | 2 263 | 0.44 | 0.65 | 0.69 |
| 100 | 200 | 1 452 | 0.69 | 0.92 | 1.00 |
| 500 | 200 | 576 | 1.58 | 2.18 | 5.87 |
| 1 000 | 200 | 339 | 2.67 | 3.98 | 9.45 |
| 2 500 | 200 | 150 | 6.02 | 11.27 | 13.14 |
| 5 000 | 200 | 78 | 11.53 | 19.95 | 22.54 |

Throughput falls by a factor of **29** and p50 rises by a factor of **26** between an
empty session and one holding 5 000 events. The growth is linear in the events
already held, which makes the total cost of a session quadratic in its length.

A 5 000-event session is an ordinary day of telemetry for one monitored operator.
At that point a single keystroke costs 11.5 ms of server time, and the console sends
one event per request.

### Memory

2 000 further events ingested into one session, measured with `--expose-gc`:

```
heap 34.7 MiB -> 37.3 MiB   (+2.6 MiB, 1365 B/event)
```

Roughly **1.4 KiB per event held in memory**, and `SessionState.events` has no
per-session cap: `MAX_EVENTS_PER_BATCH` bounds one request, not a session's
lifetime. A 5 000-event session therefore holds about 7 MiB, and the cost is per
live session.

This is not a leak test — a leak needs hours. It answers the narrower question a
baseline can honestly answer: does a sustained burst grow the heap without bound?

## Reading the numbers

**The cheap paths are genuinely cheap.** Health, an unauthenticated rejection, and
an oversized-body rejection all sit in the 26 000–34 000 req/s range at p99 under
0.11 ms. The body limit in particular rejects before buffering, which is why a
9 MiB claim costs 0.03 ms.

**The dedup fast path is ~45× faster than a fresh batch** (1 902 vs 45 req/s). The
durable identity check makes a replayed batch cheap rather than merely correct,
which is the outcome the idempotency work was aiming for.

**A request that triggers analysis is not slower than one that does not** (2 423 vs
603 req/s) — because it runs against a *fresh* session each time, so it does not pay
the per-session growth the single-session case does. That contrast is what first
pointed at session size as the variable.

**The two findings above are the actionable ones.** Both are the same shape: work
proportional to how much a session already holds. Neither is visible from a
throughput figure taken on a fresh database, which is exactly why the scaling case
exists.

## Reproducing

```bash
npm run bench
```

The command builds the API first, so the benchmark always measures current compiled
output rather than a stale `dist/`. Run it before and after a change to a hot path;
compare p50 and p99 for the affected case, and re-check the scaling table.

To compare against a recorded run:

```bash
npm run bench -- --json before.json     # on the baseline commit
npm run bench -- --json after.json      # after the change
```

`scripts/bench/run-bench.mjs` writes the environment, every case, and the memory
figures into the JSON, so a comparison can state what it was comparing.

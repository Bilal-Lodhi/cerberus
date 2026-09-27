# Read-path freshness checkpoint

The record of the **read-path performance, cache coherence and freshness-contract** cycle: what
it asked, what it found, what it changed, what it deliberately did not change, and how each exit
criterion was answered.

The contract itself is [live-read-freshness-policy.md](live-read-freshness-policy.md). The
measurements are [read-path-performance.md](read-path-performance.md) (real MongoDB) and
[performance-baseline.md](performance-baseline.md) (stubbed). The client behaviour is
[console-polling-audit.md](console-polling-audit.md).

## 1. The question

> Can Cerberus preserve the correctness guarantees introduced in `v0.5.0` while reducing the cost
> of live session reads, and if so, what exact freshness/staleness contract should the API expose?

The premise it started from was a number: the live detail reported **3.49 ms p50 / 6.80 ms p95**
against `v0.4.0`'s **0.09 ms**, a ratio of about **38×**, attributed to the durable read the
`v0.5.0` cycle added.

## 2. What it found, in the order it found it

### 2.1 The premise was wrong — the benchmark's double measured itself

`get_session_review` in the benchmark's in-process MCP double ignored the `eventsLimit` and
`includeAssessments` arguments the API sends, and returned `all.slice(-500)`. The real store,
given `eventsLimit: 0`, **skips the events query entirely**; the API sends exactly that on every
ingest, every live-detail read and every review-list row. So the double made those paths carry up
to 500 micro-event documents the real store never returns, and the API discarded all of them.

Same machine, back to back, only the double changed:

| Case | Published | Corrected | Ratio |
| --- | --- | --- | --- |
| Live detail | 1.21 ms p50 | **0.10 ms** | 12× |
| Ingest (1 KEYSTROKE) | 1.36 ms | **0.20 ms** | 7× |
| Ingest (50 events) | 2.10 ms | **0.57 ms** | 4× |
| Review list (20×200 history) | 10.28 ms | **0.51 ms** | 20× |

Re-run against a disposable `v0.4.0` worktree with the corrected double, the live-surface
comparison is **0.04 ms against 0.10 ms** — a difference of 0.06 ms, which is the entire
route-local cost of the durable read in a harness where a durable read is a function call.

This is the fifth occurrence of the same class in this repository. The previous four were each
fixed by *editing the double*; this one is fixed by making the double checkable
(`apps/api/test/bench-double.test.ts`, which fails nine of its ten cases against the pre-fix
double). `performance-baseline.md` keeps the superseded figures, because the error is the
finding.

### 2.2 The durable read is cheap, bounded, and flat

Against a real MongoDB through a real driver — the instrument the stubbed benchmark cannot be:

| Case | p50 | p95 | persistence calls/request |
| --- | --- | --- | --- |
| Live detail (process holds the session) | 1.36 ms | 1.96 ms | **1.00** |
| Live detail (after restart) | 1.13 ms | 1.61 ms | **1.00** |
| Live list (20 sessions) | 1.59 ms | 2.34 ms | **1.00** |
| Review detail | 6.55 ms | 8.73 ms | **1.00** |

One bounded round trip per request, no N+1, and one process serves ~1 850 live-detail requests
per second at its best concurrency (8 in flight).

### 2.3 The client does not poll the surface in question

The console's only periodic mechanism is a 5-second loop, and the endpoint it reads is the
**review detail**; the live detail is a **fallback** for when the primary does not answer. The
live list is not polled at all. Steady state is **12 requests/minute**, all to the review detail.

### 2.4 The surface that does not scale is the live list

| Stored sessions | Live rows | Live list p50 | Live detail p50 |
| --- | --- | --- | --- |
| 20 | 20 | 2.53 ms | 1.45 ms |
| 520 | 120 | 10.21 ms | 1.17 ms |
| 5 020 | 1 020 | **75.58 ms** | **0.98 ms** |

`MongoStore.listSessions` is `find({})` with no filter and no limit. The live detail is flat; the
live list is linear in the store. This is a **query-shape** problem, not a staleness one, and the
answer to it is a bounded query at zero staleness rather than a cache.

### 2.5 A race gate failed for a correct system

`terminate racing auto-lock: exactly one applies` asserted `lock.status === 200` in a
`Promise.all` race while its own comment said "whichever order they landed in". When the
terminate landed first the ingest was correctly refused with `409 SESSION_TERMINATED`. It passed
on one pull request and failed on the next with `409 !== 200`. Fixed by asserting the invariant
instead of a winner, and by adding a deterministic test that forces the interleaving which used
to fail.

## 3. The decision

**No cache is introduced. The live detail keeps its durable read per request and the freshness
contract stays `DURABLE_CURRENT` — zero staleness — on every surface.**

The reasoning is [live-read-freshness-policy.md](live-read-freshness-policy.md) §9:

1. The cost is one bounded round trip, flat in the size of the store.
2. The console does not poll this surface; its steady-state load on the live detail is zero.
3. The capacity headroom is four orders of magnitude.
4. The one surface that does not scale needs a bounded query, not a TTL.
5. The complexity a cache adds is not local: a second answer to "what is this session's status",
   a declared staleness bound, bounded memory, deterministic eviction, and a cross-replica
   convergence property that cannot beat the TTL because no shared invalidation channel is
   proposed.

The charter permits this outcome explicitly — *"A maturity cycle may conclude that no cache is
the right answer. That is a valid success."* — and §8 of the policy states, unchanged, the gate a
future bounded cache would have to pass.

## 4. The exit criteria

| | Criterion | State |
| --- | --- | --- |
| A | A real-Mongo baseline exists for list/detail latency | **Met** — `scripts/bench/run-read-path-bench.mjs`, `read-path-performance.md` §4 |
| B | Current durable-read cost measured under realistic local Mongo | **Met** — 1.00 persistence calls/request; 1.36 ms p50 detail, 1.59 ms p50 list, loopback `mongod` 7.0.43 |
| C | A freshness policy documented **before** implementation | **Met** — `live-read-freshness-policy.md`, committed before any read-path code changed |
| D | Any cache introduced has an explicit maximum staleness bound | **N/A** — no cache. The contract's maximum staleness is stated per surface: 0 ms |
| E | Terminal states cannot be incorrectly served as active beyond the bound | **Met trivially** — bound is 0; `terminated` is read from the document on every request. The invariant is asserted by `multi-process.test.ts` and `live-detail-reconciliation.test.ts` |
| F | A local transition invalidates or updates the relevant cache immediately | **N/A** — no cache. The local transition *is* the durable write, and the read path repairs its in-memory status toward the document (`reconcileStatus`) |
| G | Another replica's transition becomes visible within the declared bound | **Met** — immediately, because every read reconciles against the store. Proved by `multi-process.test.ts` |
| H | Stale cache cannot overwrite newer durable truth | **Met** — repairs are one-directional (`reconcileStatus`, never the document), and transitions write through an `expectedStatuses` predicate |
| I | Process restart semantics remain truthful | **Met** — measured: live detail after restart 1.13 ms p50, and `multi-process.test.ts` "a restart of one process does not disturb the other's view" |
| J | Store-unavailable semantics remain truthful | **Met** — measured against a genuinely disconnected driver: `200` labelled `process-local`, `503 SESSION_STORE_UNAVAILABLE`, and `reconciled: false` on the list. Never a false `404` |
| K | Source/freshness metadata remains accurate | **Met** — `statusSource`, `reconciled`, `source`, `ephemeralStateAvailable` unchanged and still accurate; no new field added |
| L | High-cardinality cache growth is bounded | **N/A** — no cache. The unbounded thing that was found is the *durable list query*, recorded in §5 |
| M | Cache eviction is deterministic enough to test | **N/A** — no cache |
| N | Cache TTL config, if added, is fail-closed and documented | **N/A** — no TTL config added. The four benchmark variables that were added are documented and censused |
| O | List/detail/review semantics remain mutually consistent within their freshness model | **Met** — all three are `DURABLE_CURRENT`; the agreement is asserted by `read-model-consistency.test.ts` and `multi-process.test.ts` |
| P | Two-process integration proves cross-replica convergence | **Met** — `multi-process.test.ts` and `multi-process-idempotency.test.ts` run against a real MongoDB in CI, and CI asserts **0 skipped** |
| Q | Before/after latency measured on the same machine/configuration | **Met** — `v0.4.0` worktree at `ed14728f…` against `main`, back to back, same benchmark code and doubles; `performance-baseline.md` §"The live-surface reconciliation" |
| R | Query count measured before/after | **Met** — persistence calls per request are reported per case in both benchmarks; `run-bench.mjs --json` now writes the per-tool call counts |
| S | Cache hit/miss measurable without leaking sensitive data | **N/A** — no cache, so no hit/miss. The benchmark's tool-call counts are the equivalent measurement and carry no payload |
| T | No P0/P1 correctness/security defect remains | **Met** — see §6 |
| U | `v0.6` idempotency guarantees remain intact | **Met** — the full suite, including the two-process paid-route races and migration 0004, is green and unskipped; no paid-route file was touched |
| V | CI/release harness remain green | **Met** — see §7 |
| W | Published tags remain immutable | **Met** — see §8 |
| X | A coherent next release candidate can be described | **Met** — [release/v0.6.1-release-notes.md](../release/v0.6.1-release-notes.md). Prepared as a `v0.7.0` candidate and published as **`v0.6.1`**: nothing a client can observe changed, so it is a patch |

## 5. Deliberately not done

**The bounded live-list query.** It is designed, measured and costed, and it is not landed. The
reasons are in [maturity-plan.md](maturity-plan.md) §"What it found that it did not fix"; the
short version is that the obvious filter is **not** exactly equivalent to the reconciler's rule,
and the difference is a session that silently disappears from the live list:

- `normalizeStatus` maps **any** unrecognised status, and a missing one, onto `active`, so
  "monitored" is `$ne: "terminated"` — not index-friendly, and any conservative `$or` branch
  covering the legacy values forces the collection scan the change exists to remove;
- `isExpired` treats a missing or unparseable timestamp as **not expired**, deliberately, so a
  recency bound would exclude documents the current code lists.

The fix is a bounded query **plus** a normalisation migration that makes the vocabulary total,
with an index and an equivalence proof. Landing a partial bound would have made a number smaller
and the read path less trustworthy, which is the trade this cycle exists to refuse.

**The console's polling defects.** No visibility guard, no in-flight guard, two concurrent
identical detail requests per session selection, and `stopStreaming` not awaiting cancellation.
All are recorded in [console-polling-audit.md](console-polling-audit.md); none is a server
concern, and the audit found no over-polling that a server change would be masking.

## 6. Defects

**Fixed in this cycle**

| Defect | Class | Found by |
| --- | --- | --- |
| The benchmark's MCP double ignored `eventsLimit`/`includeAssessments`, inflating every ingest and live-detail figure | P2 — measurement integrity | Reading the double against the tool registry while building the real-Mongo benchmark |
| The published 38× live-detail ratio and the "ingest plateaus because of the review fetch" explanation were artifacts of that double | P2 — documentation accuracy | Re-running the stubbed benchmark after correcting the double |
| `terminate racing auto-lock` asserted a specific winner in a `Promise.all` race and failed for a correct system | P2 — a gate that lies | CI: passed on #87, failed on #88 with `409 !== 200` |
| The attribution guard assumed `origin/main` exists, so the manual release drill was red for a reason unrelated to attribution | P2 — a release gate that could not run | Running `npm run verify:release` through its own `workflow_dispatch`, which is the shape CI does not use |

**Found and not fixed** (recorded above and in the maturity plan): the unbounded durable list
query.

**An environment incident, not a product defect.** The `v0.4.0` worktree used for the before/after
comparison had `node_modules` linked into it as a Windows junction. Removing the worktree followed
that junction, and then npm's workspace junctions inside it, and deleted both workspaces' source
trees and `node_modules`. Everything was recovered — the tracked files from the index, the
dependencies with `npm ci` — and the suite was re-run afterwards: 1 135 + 21 tests, 0 failed, 0
skipped. It is recorded because the setup is a plausible thing to do again, and the maturity plan
now says not to.

**Verified not to be defects.** Two hypotheses were tested and rejected, and are recorded because
the negative result is worth as much as the positive:

- *"The durable `updatedAt` is a BSON `Date` and the reconciler's string-only reader discards
  it."* The store does write a `Date` — but the MCP adapter serialises it with
  `JSON.stringify`, so the API receives an ISO string and the reader is correct. Verified by
  driving the real tool registry and inspecting the wire representation.
- *"`deployedAt` is never written by `create_session`."* It is not, and `readDurableSessionView`
  falls back to `createdAt`, which is written at insert. The value reported is right; the field
  name is aspirational. Recorded as a coupling, not a defect.

## 7. Verification at the checkpoint

| | |
| --- | --- |
| `npm run verify:release` (local, real MongoDB) | **19 passed, 0 failed, 0 skipped** |
| `Release verification` `workflow_dispatch` | **19 passed, 0 failed, 0 skipped** — after the attribution-guard defect above was fixed. The first run was 18/1, and that is how the defect was found |
| `npm test` with `CERBERUS_TEST_MONGODB_URI` set | **1 140 API + 21 MCP, 0 failed, 0 skipped** |
| `flutter test` | **55 passed** |
| CI on every pull request | green |

Every gate with its result is in [release/v0.6.1-checklist.md](../release/v0.6.1-checklist.md).

## 8. Tag immutability

`v0.1.0` through `v0.6.0` were verified unchanged at the start of the cycle and again at the
checkpoint. The exact objects are in the checklist. No tag was moved, no history was rewritten,
and no published commit was amended.

## 9. What the next cycle inherits

1. **The bounded live-list query**, with its migration, its index and its equivalence proof.
2. **The console's polling model**, recorded and unfixed.
3. **The `updatedAt` reader asymmetry** — correct only because the adapter serialises dates on the
   wire. Not a live defect; a coupling worth removing.

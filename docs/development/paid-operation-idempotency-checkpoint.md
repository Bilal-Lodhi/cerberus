# The paid-operation idempotency checkpoint

The record of the **durable idempotency and side-effect safety** cycle: what it set out to do,
what it found, what it shipped, and what it deliberately did not.

Nothing is published. No tag, no npm package, no container image, no hosted deployment.

## 1. What the cycle was for

The `v0.5.0` cycle made Cerberus tell the truth when more than one API process serves the same
session. It left one boundary unresolved, and recorded it as a **decision** rather than a defect:

> What exactly happens when a caller retries a paid operation after an ambiguous response,
> especially when two API processes receive the same request at nearly the same time?

[idempotency-model.md](../development/idempotency-model.md) answered it with a measured exposure
and a designed mechanism that was not built. The exposure was real and stated: `POST /scenarios`
spent twice per accepted request, `POST /auditor/query` spent twice, and a retry after a lost
response spent again. This cycle built the mechanism.

## 2. The merged pull requests

| PR | What it did |
| --- | --- |
| #74 | The paid-operation state model, and the auditor call-count correction |
| #75 | The `operation_claims` collection, its two indexes, and migration `0004` |
| #76 | The `Idempotency-Key` contract, the canonical fingerprint, the claim protocol, and `/scenarios` |
| #77 | `/auditor/query`, and the truthful failed read it required |
| #78 | The two-process race and replay harness against a real MongoDB |
| #79 | A failed completion write no longer leaves a claim `pending` |
| #80 | The database-free idempotency guard, and a named harness step |
| #81 | An alert per stored assessment, and the reconciliation latency baseline |

## 3. The defects it found

Recorded because "no known P0/P1 remains" is a claim about defects, and a claim without the list
is not checkable.

| Defect | Severity | How it was found |
| --- | --- | --- |
| The recorded paid-call count for `/auditor/query` was wrong: **two**, not one. The route builds a pipeline and then summarises, with a durable read between them | P2 — a documentation defect, but it understated the cost of a duplicate by half | Revalidating the recorded model against the source, which is the first task of the cycle |
| A completion write that failed left the claim `pending`, so a retry after the lease **spent a second time** on an operation the provider had already completed | **P1** — the exact duplicate spend the mechanism exists to prevent, reachable by a store blip | Writing the failure-injection suite and asking what the record said, not only what the caller was told |
| `POST /api/v1/auditor/query` answered a database outage with a fabricated audit finding: a `200` and a summary over an empty record set | **P1** once responses were recorded for replay — the fabricated answer would replay for the whole retention window | The same suite, asking what would be remembered |
| A second alert was sent for an incident whose evidence was already durable: the route discarded `inserted` from `store_risk_assessment` | P1 — a duplicate operator alert, and the one duplicate that *is* cheaply closable | The notification review, which also established that the obvious anchor does not work |
| `npm run bench` had been broken since `v0.4.0`, through four releases: its config literal never gained the `log` field the application reads unconditionally | P1 — the documented reproducible baseline could not be produced, so every figure in it silently stopped being comparable | Trying to run it, which is how the "before" number was produced |
| Three documentation claims were false: "a re-analysis writes one row per incident", the notification "awaited before the durable evidence is written", and notifications simply "undeduplicated" | P2 | The notification review, comparing the documents against the code |
| A flaky assertion in the race suite: `[201, 409]` is not the invariant, because the loser may replay when the winner has already finished | P2 — a flaky test teaches a maintainer to re-run rather than to read | Writing it, then running it more than once |

Two further defects were found in the tooling written for this cycle and fixed in the same pull
request: a `notifications()` helper that closed over a replaced stub and counted the wrong one, and
a config-literal extractor that stripped `//` comments before string literals — cutting
`"http://127.0.0.1:1"` at its `//` and taking the closing brace with it.

## 4. The design, in one page

**One collection, `operation_claims`, one document per attempt.** The mutual exclusion is a
**unique index** on `(routeFamily, sha256(key))`. That is the whole of it: no lock service, no
Redis, no replica set, no transaction. Two processes racing one key both attempt the insert, the
index refuses the second, and the loser reads the winner's record instead of calling the provider.

**Reclaim is one `findOneAndUpdate` whose filter carries the whole predicate** — fingerprint,
status and lease expiry. Two processes reclaiming together produce exactly one winner, because
MongoDB applies one and the loser's predicate no longer matches. The fingerprint is in the filter
so a stale record belonging to a *different* request cannot be taken.

**Completion and failure are conditional on the claim id**, so a process whose lease expired
cannot overwrite a record a reclaimer owns. A completion that matches nothing is reported rather
than swallowed, because that is the one state in which a second execution exists.

**The lease is derived** from `OPENAI_REQUEST_TIMEOUT_MS`
(`clamp(2 × timeout + 30 s, 60 s, 30 min)`), because a lease shorter than a provider call would
let a second process reclaim a *healthy* operation and spend again.

**Failures are two kinds.** A provider outage or a cancellation produced nothing usable, so a
same-key retry re-executes. A failure where Cerberus observed the provider succeed is recorded
non-retryable with the failure to replay, so a retry answers from the record instead of spending
again.

## 5. The exit criteria

| # | Criterion | State |
| --- | --- | --- |
| A | `/scenarios` supports durable idempotency | Met |
| B | `/auditor/query` supports durable idempotency | Met |
| C | Same key + same request replays without a second provider call | Met — counted at the stub |
| D | Same key + different request is rejected deterministically | Met |
| E | Two replicas racing one key permit one provider execution | Met — two real processes, one real MongoDB |
| F | Restart after a completed operation preserves replay | Met |
| G | Stale pending operations have defined recovery semantics | Met |
| H | Death before the provider call is distinguishable from death after claim | Met |
| I | Death after provider success is documented as ambiguous | Met — documented **and** asserted |
| J | No exactly-once billing claim is made | Met |
| K | Retention is bounded | Met |
| L | Storage cannot grow forever | Met |
| M | Unique + TTL indexes exist and are guarded as critical | Met — both directions, real store, and after every restore |
| N | Migration from a `v0.5.0` state is tested | Met |
| O | Backup/restore includes the records and indexes | Met — the restored database is asserted to refuse a duplicate claim |
| P | Rate limiting and idempotency do not conflict | Met |
| Q | Request logging does not leak keys or fingerprints | Met |
| R | Notification duplication is measured and reduced or re-accepted | Met, both — reduced where a durable anchor exists, re-accepted where none does |
| S | Reconciliation latency baseline is closed | Met — `v0.4.0` against this release, same benchmark code, one machine |
| T | The `v0.5.0` multi-writer guarantees remain intact | Met |
| U | No known P0/P1 defect remains | Met — the four P1s in §3 are fixed with regression tests |
| V | Docs, threat model and compatibility match implementation | Met |
| W | CI and release verification remain green | Met |
| X | Published tags remain immutable | Met — §6 |
| Y | A coherent next release candidate can be described | Met — prepared, **not published** |

## 6. Verification at the checkpoint

| Gate | Result |
| --- | --- |
| `npm run build` / `typecheck` / `typecheck:tests` | clean |
| `npm test` with a real MongoDB 7 | **1 121 API + 21 MCP tests, 0 failures, 0 skipped** |
| `npm run verify:release` steps run individually | all pass; the harness gained a database-free `idempotency-guard` step |
| `npm run verify:backup` | 11 checks, 0 failures |
| `npm run test:migrations` | `v0.2.0`, `v0.3.0` and `v0.5.0` shapes all upgrade |
| Flutter `analyze` / `format` / `test` | clean; 55 tests |
| `npm run check:docs` | 0 broken links or anchors |
| Two-process race suite | run 4 consecutive times, all green |
| `npm run bench` at `v0.4.0` and at `main` | both full runs; the live detail moved 0.09 ms → 3.49 ms p50 |

### Published-tag immutability

| Tag | Tag object | Target |
| --- | --- | --- |
| `v0.1.0` | `55329b5e378cb890c9b9775647396ea57fd7bdc7` | `ef98f962530fb62340cf213b408f1cd715755c01` |
| `v0.2.0` | `c987767494f4d1c624005f6f498334e658d2c1bc` | `a355f310eefb5345ddafe8af53cfec805eb21c64` |
| `v0.3.0` | `af22236626019352bddebe8798a659151af7ec4f` | `95b57836b4d8797666ad94953323ce5811f50041a` |
| `v0.4.0` | `78fdce26c517ee65cb2bf77fceb379306d36dc30` | `ed14728f9dfeaace841474b909ecfba15cd6feb3` |
| `v0.5.0` | `a635862e7a726f6362029e3aa711d630551a757f` | `000ac1a7ddd837d35790a434a22969d3f6073189` |

Verified against `origin`, not only locally, and unchanged. No history was rewritten: no rebase of
a merged branch, no force-push to `main`, no amend of a published commit, no retag. The synthetic
co-author trailers recorded in [operability-checkpoint.md](operability-checkpoint.md) are left in
place, and the attribution guard remains **prospective**.

## 7. What was published

**Nothing.** No `v0.6.0` tag, no npm package, no container image, no hosted deployment, and nothing
marked stable or latest. [v0.6.0-release-notes.md](../release/v0.6.0-release-notes.md) and
[v0.6.0-checklist.md](../release/v0.6.0-checklist.md) are prepared and their publication steps are
recorded as **not run**.

## 8. Limitations accepted rather than fixed

1. **The crash window between provider success and the record write.** A process that dies inside
   it leaves an operation whose outcome is unknown, and a retry after the lease may spend again.
   Closing it needs provider-side idempotency, which the provider does not offer. Stated in the
   state model §11 and asserted by a test.
2. **The residual window when the store refuses both writes.** If the completion write fails and
   the failure write fails too, the record stays `pending` and a retry after the lease executes
   again. Asserted, not merely described.
3. **Two alerts for one incident across replicas.** The assessment id is model-supplied, so two
   replicas mint different ids. A durable dedupe needs a durable *incident* identity, which is a
   product decision rather than an engineering one. No outbox is built.
4. **The 38× live-detail cost.** Measured and published rather than removed. A deployment that
   cannot afford a durable read per live-detail request has a real trade to make.
5. **Rate limiting is still per-process**, so N replicas enforce up to N times the limit. A replay
   is deliberately **not** exempted from it.
6. **The console embeds the operator key**, unchanged, and still a consequence of the single-key
   model.
7. **Backups still have no scheduling, off-host storage, encryption or point-in-time recovery.**
8. **The shared operator key still means no per-user attribution.** A claim identifies a request,
   not a person.
9. **The notification review is not a delivery guarantee.** Best-effort, unchanged, and now stated
   precisely rather than as a blanket "duplicates can happen".
10. **No exactly-once claim of any kind**, anywhere.

## 9. What the next cycle inherits

The measured 38× live-detail cost, and the question it raises: is a durable read on every live
detail request the right trade, or does the surface want a short-lived cache with a stated
staleness bound? That is a design question with a number attached now, which is what this cycle
was for.

# Multi-writer trust-boundary checkpoint

The record of the **multi-writer consistency and trust-boundary** cycle: the eight merged pull
requests, the five defects tracing them found, the exit criteria with their state, the verification
at the checkpoint, the immutability proof for the four published tags, and what remains accepted.

**Nothing was published in this cycle.** No npm package, no container image, no tag, no release.

## 1. What the cycle was for

The `v0.4.0` cycle made Cerberus **inspectable**. It never asked what happens when two API
processes serve the same session at once, because the system had only ever run as one, and it
recorded the consequence as an accepted limitation: *"the live surfaces report the status this
process holds in memory."*

The question this cycle asked, of every state path:

> If process A and process B handle requests for the same session at the same time, does Cerberus
> still tell the truth?

The answer was **yes for transitions and no for reads**, and the reads were the bulk of the work.

## 2. The merged pull requests

| PR | Subject | What it established |
| --- | --- | --- |
| [#63](https://github.com/Bilal-Lodhi/cerberus/pull/63) | A private-package guard, and the release drill in CI | `packages/mcp-mongodb` had shipped without `"private": true` through four releases; every workspace package is now unpublishable by construction. The release-verification workflow had **never run**; it now runs the full harness on `workflow_dispatch` against a real `mongo:7` |
| [#64](https://github.com/Bilal-Lodhi/cerberus/pull/64) | The multi-writer state model, and the freshness contract | Every session concept classified, the six multi-writer questions answered per field, and the four places the implementation broke the invariant |
| [#65](https://github.com/Bilal-Lodhi/cerberus/pull/65) | The live session list reconciles against durable truth | One batched durable query per request, always — the query had run only when local memory was empty |
| [#66](https://github.com/Bilal-Lodhi/cerberus/pull/66) | The live session detail reconciles against durable truth | The document is read on every request; the route had never read it when it held the session |
| [#67](https://github.com/Bilal-Lodhi/cerberus/pull/67) | The terminal transition that applied owns `terminalContent` | The write moved after the transition, gated on the status the transition produced |
| [#68](https://github.com/Bilal-Lodhi/cerberus/pull/68) | Counters are a batch delta applied with `$inc` | `$max` on an absolute total lost a concurrent writer's events; plus a two-process harness against a real MongoDB |
| [#69](https://github.com/Bilal-Lodhi/cerberus/pull/69) | The paid-route idempotency decision | The duplicate-spend exposure measured from the source and **re-accepted**, with the design that would close it |
| [#70](https://github.com/Bilal-Lodhi/cerberus/pull/70) | Running more than one replica, and the threat model for it | The rate-limiting decision, the rolling key-rotation rule, and the boundaries the cycle did not move |

## 3. The defects tracing them found

Each is stated with its consequence rather than as a general warning. All five are **fixed**, and
each has a test that fails if the fix is removed.

### 3.1 The live list consulted MongoDB only when its own memory was empty

`GET /api/v1/guardian/sessions` was built from `sessionStore` and `activeSessions`, and the durable
query was gated on `allSessions.length === 0`. Two false statements followed, and the second is
worse than the first:

- a session another process **terminated** kept being reported `active` until its TTL elapsed, a
  transition happened to run through this process, or it restarted — while the review surfaces,
  which read MongoDB, said `terminated` about the same session;
- a session another process had deployed or ingested was **absent from the page entirely**. Not
  misreported: missing.

**Fixed** by one batched durable query per request and a merge that prefers durable.

### 3.2 The live detail never read the document when it held the session

`GET /api/v1/guardian/sessions/:sessionId` answered from `sessionStore` whenever it had the
session. With one process that was free, because the process holding the session was also the only
writer. With two, it reported `active` for a session another process had terminated.

The repository's own test suite **asserted that division and called it deliberate** — which is why
it was recorded as an accepted limitation rather than as a defect. That test now asserts the
reconciled behaviour, and the reason is written where the old assertion was.

**Fixed** by reading the document on every request and merging.

### 3.3 `terminalContent` had no ownership rule

`terminate` preserved the workspace **before** the status transition, and
`update_session_terminal_content` was an unconditional `$set`. Two processes terminating the same
session both wrote, and the last writer won — with whichever process happened to hold the **staler**
reconstruction. The field is one fact, "the workspace as monitoring ended", and it had no single
owner.

**Fixed** by moving only the *write*: the transition is the atomic claim, and the content is written
afterwards, gated on the status the transition produced. A terminate that did not claim the session
may only repair an empty field.

### 3.4 The aggregate counters lost a concurrent writer's events

The counters were sent as **absolute totals** and applied with `$max`:

```
A hydrates eventCount: 10, accepts 5 events, writes $max 15
B hydrates eventCount: 10, accepts 3 events, writes $max 13
durable = max(15, 13) = 15          true total = 10 + 5 + 3 = 18
```

Neither process ever saw the other's batch, so the aggregate converged to the largest single
process's total rather than the sum, and the missing counts were never recovered. The counters gate
the analysis triggers and appear on the review panel.

**Fixed** by sending the batch **delta** and applying it with `$inc`.

### 3.5 `packages/mcp-mongodb` was publishable by accident

It shipped without `"private": true` through four releases, so the only thing between this tree and
a published `@cerberus/mcp-mongodb` was nobody happening to type the command. Every other mistake
in this repository is recoverable by a later commit; a registry upload is not.

**Fixed** by `"private": true` plus `npm run verify:packages`, whose refusals are asserted over
disposable fixture trees.

## 4. Two things found that are not defects in the product

- **The release-verification workflow had never run.** It existed, was correct, and had zero runs —
  so the release drill was still a command a maintainer ran on their own machine. Found by asking
  GitHub for its run history rather than by reading the file.
- **The durable live-list branch had no test at all.** No suite stubbed `list_sessions`, which is
  part of why 3.1 went unnoticed: the code path that would have been correct was never executed.

## 5. The exit criteria

| # | Condition | State |
| --- | --- | --- |
| A | Live session reads reconcile against durable lifecycle state | **Met** — both live surfaces |
| B | Stale in-memory status cannot override newer durable status on read | **Met** — including once the store stops answering, because the previous read repaired the cache |
| C | Two processes can safely observe/transition the same session under supported flows | **Met** — asserted against a real MongoDB with two real processes |
| D | Stale process caches are detected and reconciled deterministically | **Met** — one-directional repair, which does not move the cached activity instant |
| E | Live-list semantics stay bounded and performant after durable reconciliation | **Met** — one query per request regardless of session count; no N+1 |
| F | Route-level multi-writer behaviour is documented | **Met** — `multi-writer-model.md` §4 |
| G | Paid-route duplicate-spend risk reduced or explicitly re-accepted with stronger evidence | **Re-accepted**, with the exposure measured per route from the source and the design recorded |
| H | Any idempotency mechanism is durable, race-safe and bounded | **Not applicable** — none introduced; the design and its retention bound are documented |
| I | Per-process rate limiting honestly scoped, or a safe next-step boundary documented | **Met** — the N-replica multiplier, the decision to keep it local, and where per-caller limiting belongs |
| J | Shared-key lifecycle risks bounded without inventing accounts | **Met** — the rolling rule, the per-replica check, and an explicit refusal to invent a generation id |
| K | `@cerberus/mcp-mongodb` hardened against accidental publication | **Met** — `private: true` plus a tested guard |
| L | Full release verification runnable through CI, not only a developer machine | **Met** — `workflow_dispatch`, and it ran green |
| M | Docker-dependent release evidence reproducible in CI/manual workflow | **Met** — same workflow, real `mongo:7`, real container build |
| N | Live-state reconciliation has measured cost, no pathological query amplification | **Partially met** — the query count is bounded and pinned by a test, and a **current** latency measurement was taken at release prep; there is no before/after baseline, and none is claimed |
| O | No known P0/P1 correctness or security defect remains | **Met for the session state paths.** The paid routes' duplicate-spend exposure is re-accepted with its cost measured, which is G's own alternative |
| P | Docs, threat model and compatibility docs match implementation | **Met** — the enforcement table in `multi-writer-model.md` §6 marks each rule enforced or not, and §8b of the threat model records what did not move |
| Q | Published tags remain immutable | **Met** — see §6 |
| R | A coherent next release candidate can be described | **Met** — see [v0.5.0-release-notes.md](../release/v0.5.0-release-notes.md) |

**One criterion is partially met and is stated as such rather than rounded up.** N asks for
*measured* cost. Two things were measured, and the third was not:

- **Query count, bounded by construction and pinned by a test.** One `get_session_review` per
  live-detail request, one `list_sessions` per live-list request regardless of how many sessions are
  in memory, and `session-detail-fallback.test.ts` pins the detail at **exactly one** store call.
- **Current latency, measured at release prep** — real MongoDB, in-process HTTP, one process,
  50 sessions seeded, 200 samples each after a 20-request warm-up:

  | Surface | p50 | p95 | mean | max |
  | --- | --- | --- | --- | --- |
  | `GET /api/v1/guardian/sessions` | 4.01 ms | 5.90 ms | 4.2 ms | 8.76 ms |
  | `GET /api/v1/guardian/sessions/:sessionId` | 1.78 ms | 2.42 ms | 1.8 ms | 3.87 ms |

  Nothing pathological: the list — which now pays a durable query it previously skipped — is a few
  milliseconds at 50 sessions, and the detail is cheaper than the list.
- **A before/after baseline was not taken**, because the pre-change code is no longer in the tree.
  The numbers above are therefore a **current** measurement, not a comparison, and criterion N is
  left partial rather than closed with a figure nobody could reproduce.

## 6. Published-tag immutability

The four published tags are annotated tag objects, and each object and target is **unchanged** from
what the charter recorded at the start of this cycle:

| Tag | Tag object | Target commit | Matches remote |
| --- | --- | --- | --- |
| `v0.1.0` | `55329b5e378cb890c9b9775647396ea57fd7bdc7` | `ef98f962530fb62340cf213b408f1cd715755c01` | Yes |
| `v0.2.0` | `c987767494f4d1c624005f6f498334e658d2c1bc` | `a355f310eefb5345ddafe8af53cfec805eb21c64` | Yes |
| `v0.3.0` | `af22236626019352bddebe8798a659151af7ec4f` | `95b57836b4d879766ad94953323ce5811f50041a` | Yes |
| `v0.4.0` | `78fdce26c517ee65cb2bf77fceb379306d36dc30` | `ed14728f9dfeaace841474b909ecfba15cd6feb3` | Yes |

Nothing in this cycle rewrote history, retagged anything, or touched the eleven historical synthetic
co-author trailers. The repository still has exactly four GitHub releases, all pre-releases.

## 7. Verification at the checkpoint

| Gate | Result |
| --- | --- |
| API suite, **real MongoDB** | **969 tests, 969 pass, 0 fail, 0 skipped** |
| API suite, no database | 884 tests, 878 pass, 0 fail, 6 skipped with a stated reason |
| MCP suite | 10 tests, 10 pass, 0 fail |
| Flutter console | `dart format` 34 files, 0 changed; `flutter analyze` **No issues found**; `flutter test` **55 pass** |
| Build, typecheck, test-tree typecheck | Pass |
| Documentation | 48 markdown files, 325 file links, 30 anchors, **0 broken** |
| Version census | 6 declarations agree; changelog has both sections |
| Configuration census | 34 variables read, 35 described — both directions agree |
| Secret guards | 4 passed |
| Private-package guard | Both workspace packages unpublishable by construction |
| Release-verification workflow | **Ran green in CI** (3m57s) on `workflow_dispatch` against a real `mongo:7` |
| CI per pull request | All six jobs green on every one of the eight pull requests |

The zero-skip real-MongoDB run is the one that matters most: the store contract suite ran against
**both** the in-process double and a real `MongoStore`, and the two-process harness ran two real API
processes against one real database.

## 8. Accepted limitations

Stated rather than implied. Each has a reason, and none is hidden behind the word "known".

1. **The two paid routes are not idempotent.** A retry after a lost response executes the provider
   call again. The exposure is measured per route (`POST /scenarios` spends **twice**) and the
   design that would close it is recorded; see
   [idempotency-model.md](../development/idempotency-model.md).
2. **Rate limiting is per process.** The ceiling multiplies by the replica count. Kept local on
   purpose; see [multi-replica.md](../operations/multi-replica.md) §2.1.
3. **Operator identity handles are per-process** and are deliberately not credentials. A handle
   presented to another replica is unknown there.
4. **Notification delivery is best-effort and undeduplicated.** Two replicas can each notify for one
   incident. A durable outbox would be the mechanism and is not built.
5. **Reconciliation latency was measured once, with no baseline.** A current figure was taken at
   release prep (see §5, criterion N); the wall-clock **cost relative to the previous release** is
   not claimed.
6. **The console embeds the operator key in its bundle.** Unchanged, and a documented consequence of
   the single-key model.
7. **Backups still have no scheduling, off-host storage, encryption or point-in-time recovery.**
   Out of scope for this cycle.
8. **No endpoint agent, no accounts, no tenancy, no compliance claim.** Unchanged and deliberate.

## 9. What the next cycle inherits

In order of value:

1. **Durable idempotency on the two paid routes**, per the design in `idempotency-model.md`,
   including the two index guarantees it names for `critical-indexes.json`.
2. **A before/after latency baseline for the reconciliation**, so criterion N can be closed rather
   than partially met. A current figure now exists; what is missing is the comparison.
3. **Per-caller rate limiting at the proxy**, which needs no product change and is documented as the
   operator's lever.
4. **A durable notification outbox**, if duplicate notifications are judged to matter.

## 10. Publication

**Published as a GitHub pre-release on 2026-09-26.** Annotated tag `v0.5.0`, tag object
`a635862e7a726f6362029e3aa711d630551a757f`, target
`000ac1a7ddd837d35790a434a22969d3f6073189`.

| Fact | Value |
| --- | --- |
| Tag | `v0.5.0`, annotated tag object, unsigned (as `v0.1.0`–`v0.4.0` are; no signing key is configured) |
| Tag object | `a635862e7a726f6362029e3aa711d630551a757f` |
| Target commit | `000ac1a7ddd837d35790a434a22969d3f6073189` — the commit the harness and the workflow both verified |
| Release | GitHub **pre-release**, draft `false`, prerelease `true` |
| Flags | No `stable`, no `latest`, no custom assets |
| Version surfaces | All six declarations at `0.5.0`; lockfile synced |
| Migration | **None.** The ledger holds `0001`–`0003`; nothing ships |
| Harness | 18 passed, 0 failed, **0 skipped** — locally (302.1 s) and in CI (191.7 s) on the frozen target |
| Workflow | `release-verification` run `36250007872`, success, 4m10s, `headSha` `000ac1a7…` |
| Two-process verification | 8 flows green against one real MongoDB |
| Criterion N | **Partially met** — a current latency figure was recorded; no before/after baseline exists |

**Nothing else was published.** No npm package (the registry answers `404` for both workspace
packages), no container image (no workflow contains a push step and the repository has no configured
secrets), and no hosted deployment. The four earlier tags are unchanged, and the eleven historical
synthetic co-author trailers are untouched.

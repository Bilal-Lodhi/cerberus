# Architecture-integrity checkpoint

The record of the third standing charter: what it set out to do, what it found, what
changed, and what remains. Written from the merged history rather than from intent.

**Status: the checkpoint is reached, and the release is published.** Every exit criterion
is met or explicitly rejected with a reason. **`v0.3.0` was published on 2026-09-26** as a
GitHub pre-release — annotated tag `v0.3.0`, tag object
`af22236626019352bddebe8798a659151af7ec4f`, target
`95b57836b4d879766ad94953323ce5811f50041a`. **No npm package, no container image and no
hosted deployment were published**, and nothing is marked stable or latest.

Four release-blocking defects were found by running the gates rather than reading the code,
and are recorded in the checklist: four console files were not `dart format` clean, the
operator identity gate claimed a Google Cloud Identity Platform integration the project does
not have, the corpus panel described the retired read-ceiling behaviour, and the backup
script both failed on any database with an empty collection and recorded a manifest that made
the restore's count comparison vacuous.

| | |
| --- | --- |
| Starting `main` | `ccfcead5385e3097f1a3a8fdd3382a9b3d915fc6` |
| `main` when this record was written | `72cbe3ee516bdaa1e499eb7d25d0e2bce8e5f4fc` — the state the checkpoint was assessed at. This document is the last change of the cycle, so the tip after it merges is one commit later |
| Merged pull requests | 11 (PRs #32–#42), plus this record |
| `v0.1.0` tag | unchanged — annotated tag object `55329b5e378cb890c9b9775647396ea57fd7bdc7`, commit `ef98f962530fb62340cf213b408f1cd715755c01` |
| `v0.2.0` tag | unchanged — annotated tag object `c987767494f4d1c624005f6f498334e658d2c1bc`, commit `a355f310eefb5345ddafe8af53cfec805eb21c64` |
| Published by this cycle | **nothing** |

## What the cycle set out to do

Advance Cerberus from *operationally durable experimental system* to *architecturally
coherent experimental system*: centralized session transitions, explicit partial-failure
semantics, truthful domain vocabulary, concurrency-safe state mutation, bounded read/write
paths, and deterministic behaviour under retry, restart and dependency failure.

## The merged changes

| PR | Change |
| --- | --- |
| [#32](https://github.com/Bilal-Lodhi/cerberus/pull/32) | The state-transition model, the failure-semantics map, and the test-double audit. Tracing the source produced one confirmed **P1** and five P2 findings the 481-test suite could not see |
| [#33](https://github.com/Bilal-Lodhi/cerberus/pull/33) | One faithful store double replacing four divergent ones, plus a 42-case contract suite run against both it and a real MongoDB |
| [#34](https://github.com/Bilal-Lodhi/cerberus/pull/34) | A compare-and-set status predicate, and bounded `get_session_review` reads |
| [#35](https://github.com/Bilal-Lodhi/cerberus/pull/35) | The central session transition boundary, and the P1 fix: a terminated session is terminal |
| [#36](https://github.com/Bilal-Lodhi/cerberus/pull/36) | Durable evidence written before side effects, and honest ingest/delete responses |
| [#37](https://github.com/Bilal-Lodhi/cerberus/pull/37) | Durable risk-assessment identity, with migration `0002` |
| [#38](https://github.com/Bilal-Lodhi/cerberus/pull/38) | The reference-corpus ceiling enforced at the store, with an atomic claim |
| [#39](https://github.com/Bilal-Lodhi/cerberus/pull/39) | The focus-loss vocabulary correction, with migration `0003` |
| [#40](https://github.com/Bilal-Lodhi/cerberus/pull/40) | Terminal content given one owner, written on terminate |
| [#41](https://github.com/Bilal-Lodhi/cerberus/pull/41) | The session-list read bounded by sessions, not by their history |
| [#42](https://github.com/Bilal-Lodhi/cerberus/pull/42) | A real-MongoDB integration suite, and a bounded CI job that runs it |

## The defects this cycle found

Recorded because a claim about defects without the list is not checkable. Four of these
were invisible to the suite that existed at the start, for the same reason each time: **a
test double that did not match the real store.**

| Defect | Severity | How it was found |
| --- | --- | --- |
| A **terminated session was not terminal**: ingest checked only TTL expiry, never the status, so a terminated session accepted telemetry, advanced its counters, and on a high-risk batch was moved to `locked` | **P1** | Tracing the ingest preconditions for the transition model; reproduced against a store double |
| A terminated session was still returned by the **live session list**, with `liveness: "active"` | P1 | The transition-table tests |
| Status writes were **last-writer-wins**; terminate racing auto-lock was decided by arrival order | P2 | The transition table |
| The durable status write's **result was not inspected** on auto-lock, auto-clear or terminate, so a failed write returned `200 success: true` | P2 | Write-ordering trace |
| Auto-clear's precondition read the **cache**, so a durably `locked` session could never be auto-cleared after a restart | P2 | Write-ordering trace |
| A failed `ingest_micro_events` was **indistinguishable from success** in the response | P2 | Failure-window trace |
| The risk assessment was persisted **after** the notification and the status write | P2 | Failure-window trace |
| The `guardian.ts` header claimed four dedup layers; layer 1 was never implemented and `risk_assessments` had no unique index on `riskAssessmentId` | P2 | Header-versus-code comparison |
| The **reference-corpus ceiling was a read ceiling**: a 201st document was stored and then never listed or compared against | P2 | The corpus-management audit |
| `WINDOW_BLUR` incremented the **fullscreen-exit** counter, so the field name described one of the two events that produced it | P2 | The session-state inventory |
| The session list fetched up to **500 events per session and discarded them** | P2 | The performance baseline |
| Two bugs **in the new code**, caught by the tests written for it: a counter reconcile that discarded in-flight reservations (two concurrent creates passed the ceiling), and a positional-argument mismatch that wrote the request id as the terminal workspace | P2 | The concurrency test, and the terminal-content tests |

**Four defects were found in tooling rather than product code**: an inline docs link
checker whose shell escaping produced four false broken-anchor reports; the same checker
passing vacuously over zero files; a CRLF-related heading-scan failure that made every
anchor look broken; and a `persistence-naming` assertion that pinned an exact method
signature and a fixed 300-character window.

## The exit criteria

| # | Criterion | State |
| --- | --- | --- |
| A | Session transitions centralized or proven unnecessary | **Done** — `services/session-transition.ts`, one order for every action |
| B | Partial-failure semantics documented and tested | **Done** — `failure-semantics.md`, and each window has regression tests |
| C | Status cannot silently diverge on supported paths | **Done** — the durable document is the authority, the write is predicate-checked, the result inspected, the caches repaired from the durable outcome |
| D | Terminal-content ownership coherent | **Done** — one owner, written on terminate; two documented fallbacks for different facts |
| E | Focus-loss/fullscreen semantics truthful | **Done** — `focusLossCount`, migration `0003`, no score change |
| F | Corpus hard ceiling consistent between store, read and console | **Done** — a store-side rejection with a stable code, verified at 199/200/201 and under concurrency |
| G | Review-fetch amplification reduced or justified with measurement | **Done** — 10 000 event documents → 0 for 20 sessions of 500 events, asserted deterministically |
| H | State mutations concurrency-tested | **Done** — deterministic interleaving, no sleeps, in-process and against a real server |
| I | Route-level retry/idempotency contracts documented | **Done** — `api-errors.md` §11, including why no `Idempotency-Key` was added |
| J | Stale-cache/newer-DB behaviour deterministic | **Done** — three tests, and a refusal reconciles the cache |
| K | Migrations cover any schema/status changes | **Done** — `0002` and `0003`, plus the ledger hardening |
| L | API/MCP compatibility preserved where reasonably possible | **Done** — every MCP change is an added optional argument; deprecated aliases kept where cheap |
| M | No P0/P1 correctness/security issue remains | **Done** — the P1s are fixed with regression tests; the remaining items are P2 |
| N | Test doubles audited against real-store behavior | **Done** — one shared double, verified against a real MongoDB, plus a fidelity guard |
| O | One real-Mongo integration suite protects the highest-risk state flows | **Done** — eleven flows through the real routes, the real registry and the real driver, in CI |
| P | Docs, threat model and compatibility docs match implementation | **Done** — and a link/anchor checker now gates it in CI |
| Q | CI green | Green on every pull request; six jobs, including a real-MongoDB integration job |
| R | `v0.1.0` and `v0.2.0` tags unchanged | **Verified** — see the table at the top |
| S | A coherent next release candidate can be described | **Done** — [release/v0.3.0-release-notes.md](../release/v0.3.0-release-notes.md) |

## Verification at the checkpoint

| Gate | Result |
| --- | --- |
| `npm run build` | clean |
| `npm run typecheck` | clean |
| `npm test` with `CERBERUS_TEST_MONGODB_URI` set | **699 API tests, 699 pass, 0 skipped, 0 failed**; 10 MCP tests |
| `npm test` without a database | 644 API tests, 641 pass, **3 skipped** — each with a stated reason |
| `npm run check:docs` | 34 markdown files, 191 file links, 26 anchors, **0 broken** |
| `flutter analyze` / `flutter test` | clean; **49 tests** |
| `dart format` | clean |
| CI | six jobs green, including `Integration (real MongoDB)` |
| `v0.1.0` / `v0.2.0` | unchanged |

## What remains, and is accepted

Named rather than omitted. None is P0 or P1.

| Item | Why it is accepted |
| --- | --- |
| No endpoint agent | An owner decision, not an engineering backlog item |
| Single shared operator key; no accounts, RBAC or tenancy | Explicitly out of scope |
| The console's API key is embedded in its web bundle | A consequence of `--dart-define`; the mitigation is documented |
| Rate limiting is a per-process backstop | Not DDoS protection, and documented as such |
| `GET /guardian/sessions/:id` has no durable fallback | It reads memory only; the review route is durable. Recorded in the transition model |
| A partial deletion is reported as complete | `deleteSession` removes three collections under one `Promise.all`, and the MCP tool reports only the session's `deletedCount`. Needs a per-collection report |
| `cleared` has no producer | A vocabulary decision, recorded in the transition model |
| A session created by ingest has no live-registry entry until its first transition | A shape difference, narrowed by the boundary |
| A deploy against an existing id is a silent no-op | `$setOnInsert` cannot fire; recorded |
| No backup automation | The mechanism is MongoDB's; the scripts are verified and the gaps are documented |
| No durable outbox for notifications, and no generic job system | The evidence does not require either; both decisions are recorded in `failure-semantics.md` |
| No `Idempotency-Key` on the paid routes | Deliberate; the reasoning and the condition that would change it are in `api-errors.md` §11.1 |

## What the next cycle should consider

Not a commitment — the next charter decides.

1. **A durable operation record for the paid paths**, if a second consumer of the API
   appears that cannot see the console. That is the condition `api-errors.md` §11.1 names.
2. **The per-collection delete report**, so a partial deletion stops being reported as
   complete.
3. **A durable read for `GET /guardian/sessions/:id`**, closing the last read-path gap the
   transition model records.
4. **The `cleared` vocabulary decision**, which needs a producer or a removal and is a
   compatibility change either way.
5. **Observability**: structured logs and a request-scoped trace, which nothing in this
   cycle addressed.

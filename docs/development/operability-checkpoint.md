# Operability checkpoint

The record of the **operability, read-integrity and release-automation** cycle: what it
changed, the defects tracing the system found, the exit criteria with their state, the
verification at the checkpoint, and what remains accepted rather than fixed.

**Nothing was published.** No tag, no release, no package, no image, no deployment. The
`v0.1.0`, `v0.2.0` and `v0.3.0` tags are untouched — see §6.

## 1. Where the cycle started and ended

| | |
| --- | --- |
| Starting `main` | `d85c6bfc104446e4a699cb52a1c8964a3b86e501` |
| Ending `main` | `34566634189a5be599c7f315a50d17a364a7f791` |
| Merged pull requests | ten |
| Defects found and fixed | fourteen, listed in §4 |
| Product behaviour changed | yes, in four places — see §3 |
| Schema changed | **no.** No migration ships with this cycle |
| Tests, with a real MongoDB | 864, all passing, **nothing skipped** |
| Tests, without a database | 797, 792 passing, 5 skipped with a stated reason |
| MCP adapter suite | 10, all passing |
| Runtime dependency advisories | **0** (`npm audit --omit=dev`) |

The starting point was an *architecturally coherent* experimental system: one canonical
transition boundary, explicit partial-failure semantics, deterministic behaviour under
retry and restart. What it could not do was be **inspected**. A request could not be
traced; a log line could not be joined to the request that produced it; a session detail
answered `404` for a session that existed; a partial deletion was reported as complete; and
the release gates lived in a session rather than in a command.

That is what this cycle is about: not new capability, but the ability to see and re-run
what the system already does.

## 2. The ten merged pull requests

| PR | What it delivered |
| --- | --- |
| #49 | `docs/development/operability-model.md` — every request path mapped against nine operability columns — and the logging threat model. Found the correlation-id defect. |
| #50 | The structured logger, one request/correlation id per request, and the two-layer secret-redaction guarantee with its regression tests. |
| #51 | The durable read fallback for session detail: `sessionStore` → durable document → live registry, with `503` rather than `404` when the store cannot be reached. |
| #52 | One lifecycle vocabulary across the four read surfaces, one shared durable reader, and the counters and `disposition` on the review detail. |
| #53 | The per-component deletion report and `PARTIAL_DELETE`, with the session record removed **last** so a partial failure orphans nothing. |
| #54 | The `cleared` vocabulary resolved: removed, with a repair path for a document that still holds it. |
| #55 | `npm run verify:release` — the non-publishing harness — plus the version and configuration censuses and a typecheck for the test tree. |
| #56 | The upgrade gate: a published release's database, migrated by this build, against a real MongoDB. |
| #57 | The backup/restore drill, critical-index verification, and the stale-image defence. |
| #58 | The repeatable browser smoke, and the two couplings it found by failing. |

## 3. What changed for a client

Four observable changes. Each is recorded in
[`compatibility.md`](../compatibility.md) §3.1 where it is a public-surface change.

1. **`correlationId` now matches the response headers on every route.** It did not for four
   of five route groups: `index.ts` set one `X-Correlation-Id` per response while
   `guardian`, `review`, `reference` and `auditor` each minted their own `randomUUID()`.
   `X-Request-Id` is now accepted (bounded, validated, replaced if invalid) and carries the
   same value. The authentication rejection still carries no `correlationId`, because its
   two responses must stay byte-identical.
2. **`SessionReviewResponse.status` is the lifecycle status on every surface**, and the
   derived value moved to a new `disposition` field. A client that branched on `status` for
   `flagged` must read `disposition`.
3. **`cleared` is gone** from the vocabulary. A document still holding it — or `flagged`, or
   `investigating` — normalises to `active` on read and is repaired on its next transition.
   No data migration is required.
4. **`PARTIAL_DELETE` (500) is new**, and a session delete now reports per-component
   outcomes. `SESSION_NOT_FOUND` is returned by every surface that can report it, and
   `REFERENCE_NOT_FOUND` (404) is new. A session detail can now answer
   `SESSION_STORE_UNAVAILABLE` (503) — a read that cannot verify existence says so rather
   than claiming `404`.

## 4. The fourteen defects

Every one was found by tracing the source or by a check written in this cycle, and every
one has a regression test.

| # | Defect | How it was found |
| --- | --- | --- |
| 1 | The documented `correlationId` promise was false for four of five route groups | Tracing the request paths for the operability model |
| 2 | There was no request log line at all outside development mode | Same |
| 3 | The log line recorded the concrete path, putting a session id in the logs | Same |
| 4 | The first redactor classified keys only inside a nested object, so `logger.info("x", { currentCode })` emitted the workspace verbatim | The logger's own test suite |
| 5 | Logging a 200 KB field took **32 seconds**, because the private-key pattern scanned it quadratically | The logger's own bounded-output test |
| 6 | Session detail answered `404` for a session that exists, immediately after a restart | Tracing the read paths (open item D4) |
| 7 | A durable detail answer reported `liveness: "active"` for a session whose durable window had closed | This cycle's own fallback suite |
| 8 | The review detail reported `flagged` under `status` while the review list reported `active` — and the console displayed such a session as LOCKED | Comparing the four surfaces |
| 9 | The durable `peakRiskScore` lagged one batch, so `alertTriggered` was `false` after a restart for a session that scored 98 | Comparing the four surfaces |
| 10 | The review detail reported an empty `auditId` for a document holding only `matrixId` | Comparing the four surfaces |
| 11 | The detail route's registry branch reported zero for every counter | Comparing the four surfaces |
| 12 | A partial deletion was reported as a complete one, and the session record was removed **first** — orphaning its telemetry | Tracing the delete path; already recorded as open in `failure-semantics.md` |
| 13 | `cleared` had no producer, and a document holding a retired value could never be transitioned at all | Resolving the vocabulary decision |
| 14 | No test file was typechecked by anything: `tsconfig.json` excludes `test/` and `tsx` strips types without checking them | The new `typecheck:tests` step |

Three more were found by the new checks themselves and are worth naming, because they are
what the checks are for:

- **`schema_migrations.migrationId` was missing from the critical-index list.** The
  both-directions assertion found it on its first run.
- **The console must be served from an origin the API's CORS allow-list permits.** Served
  from anywhere else, the browser blocks the call and the identity gate reports *"Failed to
  connect to identity service"* — which looks like an API outage.
- **A default Flutter release build fetches CanvasKit from `gstatic.com`.** Without it the
  canvas never renders, and the first version of the browser smoke **passed while writing
  five blank screenshots**.

## 5. Exit criteria

| Criterion | State | Evidence |
| --- | --- | --- |
| A. Structured request logging exists and is safe | **Met** | `apps/api/src/observability/`; `observability-logger.test.ts` |
| B. Every request has a request/correlation id | **Met** | `request-id.test.ts` |
| C. Ids propagate through internal error and log paths | **Met** | Ambient context; MCP, provider, notification and transition lines |
| D. Logs emit no secrets or full telemetry by default | **Met** | `logging-secrets.test.ts`, `observability-redaction.test.ts` |
| E. Session detail has a deterministic durable fallback | **Met** | `session-detail-fallback.test.ts`; real-MongoDB flows |
| F. List/detail/review semantics are consistent | **Met** | `read-model-consistency.test.ts`; `read-model.md` |
| G. Session deletion reports per-component outcomes | **Met** | `session-deletion-report.test.ts`; `store-contract.test.ts` |
| H. A partial deletion is not reported as complete | **Met** | `PARTIAL_DELETE`; the drill's tampered-manifest check |
| I. `cleared` is resolved coherently | **Met** | Removed; `compatibility.md` §3.1; `state-transition-model.md` §1.1 |
| J. Migration/restart/backup checks are repeatable | **Met** | `verify:release` steps; the upgrade gate; the drill |
| K. A stale image or version mismatch is detected | **Met** | `verify:image`; the version census |
| L. The backup/restore gate is non-vacuous and repeatable | **Met** | `verify:backup`, 8 checks, including index verification |
| M. The browser smoke catches stale operator-facing claims | **Met, with a stated limit** | `verify:console-smoke` asserts render, console and overflow; the terminology pass is a human reading screenshots |
| N. Diagnostics distinguish liveness/readiness/dependency/request failure | **Met** | `/health`, `/ready`, the request log line, `source`/`ephemeralStateAvailable` |
| O. No known P0/P1 defect remains | **Met** | §4: every finding is P2 or lower and fixed |
| P. Docs match reality | **Met** | The version and config censuses; the docs checker; four documents corrected against the source |
| Q. CI remains green | **Met** | Six jobs green on every pull request |
| R. Published tags remain immutable | **Met** | §6 |
| S. A coherent next release candidate can be described | **Met** | [`../release/v0.4.0-release-notes.md`](../release/v0.4.0-release-notes.md) |

## 6. Immutability of the published tags

Read at the checkpoint, and unchanged from the state recorded before the cycle began:

| Tag | Tag object | Target |
| --- | --- | --- |
| `v0.1.0` | `55329b5e378cb890c9b9775647396ea57fd7bdc7` | `ef98f962530fb62340cf213b408f1cd715755c01` |
| `v0.2.0` | `c987767494f4d1c624005f6f498334e658d2c1bc` | `a355f310eefb5345ddafe8af53cfec805eb21c64` |
| `v0.3.0` | `af22236626019352bddebe8798a659151af7ec4f` | `95b57836b4d879766ad94953323ce5811f50041a` |

`v0.3.0`'s object and target match the values recorded when it was published. No tag was
moved, recreated or force-updated; no published commit was amended or rewritten; no
force-push was performed.

## 7. Verification at the checkpoint

Recorded in full in [`../release/v0.4.0-checklist.md`](../release/v0.4.0-checklist.md).
The short form:

| Check | Result |
| --- | --- |
| `npm run typecheck` / `typecheck:tests` | clean |
| `npm test` (no database) | passes; the real-database halves skip |
| `npm test` with a real MongoDB | all tests pass, **nothing skipped** |
| `npm run verify:backup` | 8 checks passed |
| `npm run verify:image` | 8 checks passed |
| `npm run verify:console-smoke` | 10 checks passed, 5 screenshots written |
| `npm run verify:version` | every declaration agrees with `package.json` |
| `npm run verify:config` | every variable read is documented, and the reverse |
| `npm run verify:secrets` | 4 guards passed |
| `npm run check:docs` | every relative link and anchor resolves |
| Flutter `analyze` / `format` / `test` | clean, clean, all passing |
| CI | six jobs green on every pull request |

## 8. What remains accepted

Not fixed, not hidden, and each with the reason it is accepted rather than closed.

| Limitation | Why it is accepted |
| --- | --- |
| **Rate limiting is per-process.** N replicas enforce up to N times the limit. | Unchanged by this cycle. Per-caller limiting needs per-caller identity, which the single-shared-key model does not have; it belongs at the reverse proxy. |
| **The two paid routes remain non-idempotent.** A retry after a lost response re-spends. | Unchanged. The condition that would justify an idempotency-key store is named in `api-errors.md` §11.1. |
| **The console embeds the operator key in the built bundle.** | Unchanged. Serve it to trusted operators only, or front it with a proxy that injects the credential. |
| **Backups have no scheduling, off-host storage, encryption or point-in-time recovery.** | Unchanged. The drill verifies the procedure, not the policy; `operations/backup-restore.md` states the gaps. |
| **The live surfaces report the status this process holds in memory.** A status changed durably by another writer is visible on the review surface immediately and on the live surfaces once a transition reconciles the cache. | Deliberate, and now stated in `operability-model.md` §9.1 and asserted. Reading the durable status on every live read would cost a persistence call on the paths a console polls continuously. |
| **The terminology pass in the browser smoke is a human reading screenshots.** | Flutter web renders into a canvas, so the page's text is not in the DOM. The machine-verifiable half is the widget suite, which CI runs; the smoke states the split rather than implying coverage it does not have. |
| **No endpoint agent, no hosted deployment, no accounts, no RBAC, no tenancy.** | Owner decisions, unchanged. |
| **`GET /health` does not report the commit.** | Deliberate: it is public and unauthenticated, and publishing the exact commit a deployment runs tells an attacker which build to look up. The provenance is in the image's labels and environment. |

## 9. Related documents

- [`operability-model.md`](operability-model.md) — every request path, what each surface
  reports, and what must never be logged.
- [`read-model.md`](read-model.md) — the four surfaces, the three vocabularies, and the six
  read-integrity defects comparing them found.
- [`console-smoke.md`](console-smoke.md) — the browser pass, what it automates and what only
  a human can judge.
- [`../release/verification-harness.md`](../release/verification-harness.md) — the harness
  and its sixteen steps.
- [`../release/v0.4.0-release-notes.md`](../release/v0.4.0-release-notes.md) — the release
  candidate. **Prepared, not published.**
- [`../release/v0.4.0-checklist.md`](../release/v0.4.0-checklist.md) — the gates, with the
  result of each.

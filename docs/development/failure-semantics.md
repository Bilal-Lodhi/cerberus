# Partial-failure semantics

What every multi-step operation in Cerberus guarantees when one of its steps
fails — and, where it guarantees nothing, that it guarantees nothing.

Written from the source. A guarantee that is not enforced by code is recorded as
absent rather than assumed, because the point of this document is to make the
difference visible before a design change claims to have removed it.

Companion documents:

- [state-transition-model.md](state-transition-model.md) — the lifecycle
  mutations this document reasons about.
- [test-double-contract.md](test-double-contract.md) — why a failure path that
  looks tested may not be.

## 1. The ordering rule, and how the code actually orders things

The intended shape for an operation that spends money, writes state and produces
side effects is:

1. validate;
2. do irreversible or paid work **only when necessary**;
3. persist durable truth;
4. refresh the cache from the durable result;
5. perform optional side effects **last**.

The ingest analysis path **now follows it**:

| Step | Action | Kind |
| --- | --- | --- |
| 1 | `ingest_micro_events` | durable truth (telemetry) |
| 2 | `update_session_counts` | durable truth (counters) |
| 3 | `load_reference_documents` | read |
| 4 | `analyzeRisk()` | **paid** |
| 5 | `recommendIncidentActions()` | **paid**, only when the score warrants a lock |
| 6 | `store_risk_assessment` | **durable truth (the evidence)** |
| 7 | `lockSession()` / `unlockSession()` | durable truth (status), through the transition boundary |
| 8 | `notifySlack` + `sendEmail` | **optional side effect, last** |
| 9 | HTTP response | — |

**The order changed, and this is why.** It used to be: paid analysis → paid
recommendation → notification → status → **assessment**. Steps 6 and 7 preceded the
assessment, so the optional side effect ran before the durable evidence existed and
the status change ran before the assessment that justifies it. A process death between
them left a durably `locked` session with a delivered alert and no recorded
justification. Steps 6–8 are now ordered evidence → state → alert, and a failed
assessment write skips both of the later steps rather than locking without evidence.

Every failure window is analysed in §3.

## 2. Inventory

| # | Operation | Steps that can fail independently |
| --- | --- | --- |
| O1 | Ingest a telemetry batch | events write, counters write, corpus read, paid analysis, paid recommendation, assessment write, status write, notification |
| O2 | Deploy a session | session upsert, cache write |
| O3 | Auto-lock / auto-clear | durable status write, cache repair |
| O4 | Reactivate | durable status write, cache repair |
| O5 | Terminate | durable status write, cache eviction |
| O6 | Delete | durable session delete, durable event delete, durable assessment delete, cache eviction |
| O7 | Author a threat scenario | paid classify, paid generate, durable scenario write |
| O8 | Auditor query | paid pipeline build, in-process apply, paid summary |
| O9 | Review list | N per-session durable reads, in-process merge |
| O10 | Terminal-content write | durable write only |
| O11 | Readiness probe | MCP health check, cache of the result |

O3, O4 and O5 are now one implementation — the transition boundary — so their windows
are the boundary's windows, analysed in §4. They are listed separately because they
are separate routes.

## 3. O1 — Ingest, window by window

The batch of events is durable from step 1 onward. Everything after it is
decorative with respect to *telemetry*, and load-bearing with respect to
*interpretation*. That distinction is what makes the windows below non-obvious:
the request can report success while the session's status and its evidence
disagree permanently.

### 3.1 Persistence unavailable for the events write

`callMcpTool` never throws — it resolves `{ok: false}`. So a failed
`ingest_micro_events` is not an error path in the code; it simply produces no
`acceptedEventIds`.

The route's response to that is documented in a comment and is deliberate: with no
report, `acceptedSet` is `null` and **every event is applied in memory**, on the
stated grounds that dropping telemetry is worse than a possible over-count in a
session whose events were never stored.

| Outcome | Value |
| --- | --- |
| HTTP | `200 success: true` |
| `acceptedCount` | the batch size (the fallback `acceptedIds?.length ?? processedCount`) |
| `duplicateCount` | `0` |
| Telemetry durable? | **no** |
| Counters durable? | the next step writes counters derived from memory, so yes — counters advance for events that were never stored |
| Guarantee | **`telemetryPersisted: false`, and the counts are omitted.** No longer indistinguishable from success. |

**Was the largest honesty gap in the operation:** a caller could not tell from the
response whether its telemetry was stored, because `acceptedCount === processedCount`
and `duplicateCount === 0` meant both "stored, all new" *and* "the store never
answered".

**Closed.** The response carries `telemetryPersisted`, and `acceptedCount` /
`duplicateCount` are **omitted** when the store did not answer — a number the server
knows is unverified is worse than no number. `processedCount` keeps its meaning (the
batch size the caller sent), so nothing is lost and a caller can now distinguish the
two cases.

### 3.2 DB succeeds, cache update fails

There is no separate cache-update step that can fail: `hydrateSessionFromDurable`
and `processEvent` are synchronous in-process mutations with no failure mode. So
this window does not exist for ingest. It **does** exist for O3, O4 and O5, where
the cache mutation and the durable write are independent and ordered differently
per route (see [state-transition-model.md](state-transition-model.md) §3.2, D1).

### 3.3 Cache changes, DB fails

Applies to the counters write. `update_session_counts` uses `$max`, so a failed
counters write is recoverable by the next successful one: the durable value is a
lower bound and the in-memory value is monotonic, so the next batch sends a value
at least as high. **The counters are self-healing; the status is not.**

### 3.4 Provider succeeds, persistence fails

> **Closed by the write-order change.** This section describes the window as it was.
> The order is now paid analysis → paid recommendation → **assessment write** → status
> transition → notification, and a failed assessment write skips both the status change
> and the notification. See §3.4.1 for the behaviour as it stands.

The paid analysis completes, the payload is enriched and blended, and then
`store_risk_assessment` fails (MCP unreachable, timeout, or the write itself
erroring). The failure was caught by the enclosing `catch (analysisError)`, which
logged `AI analysis failed (non-fatal)` — **a message that was wrong**: the analysis
succeeded and the *persistence* failed.

| Already happened by then | State |
| --- | --- |
| Paid analysis | spent, unrecoverable |
| Paid recommendation (if score ≥ 75) | spent, unrecoverable |
| Notifications (if score ≥ 75) | **delivered** |
| Status write (if score ≥ 75) | **durable `locked`** |
| Assessment | **not stored** |
| HTTP | `200 success: true`, `riskPayload` populated |

So the caller was told the operation succeeded and received a risk payload that
existed only in the response body and in `sessionStore.lastRiskPayload`. After a
restart, the review surface showed a `locked` session with an empty
`riskSummary` and `finalRiskScore` falling back to a payload that was now gone —
**a lock with no recorded justification**.

#### 3.4.1 As it now stands

| Step | Outcome when the assessment write fails |
| --- | --- |
| Paid analysis | spent, unrecoverable — unchanged |
| Paid recommendation (if score ≥ 75) | spent, unrecoverable — unchanged |
| Assessment | **not stored**, and reported: `assessmentPersisted: false` |
| Status write | **not attempted.** No durable evidence means no lock. |
| Notification | **not attempted.** An alert describing an incident with no review record is worse than no alert. |
| Telemetry | durable, unchanged — the batch is not failed |
| HTTP | `200 success: true`, `riskPayload` populated, `assessmentPersisted: false` |

The telemetry is already durable, so the next batch with a changed workspace retries
the whole path. The caller is told plainly that the payload it received is not stored.

### 3.5 Process dies between writes

The step numbers below are the **new** order.

| Dies after | Durable state | Consequence |
| --- | --- | --- |
| step 1 (events) | telemetry only | no counters, no status, no evidence. Client retry is safe (events dedup by `eventId`). |
| step 2 (counters) | telemetry + counters | as above; counters are consistent with telemetry. |
| step 4 (paid analysis) | + paid spend | money spent, nothing recorded. Retry re-pays unless `lastAnalyzedCodeHash` survived — and it is in-memory only, so **a restart re-pays**. |
| step 5 (paid recommendation) | + second paid spend | two paid calls lost. |
| step 6 (assessment) | **complete evidence, no status change** | consistent: the review surface has the assessment, the session is still `active`, and the next batch re-locks it. |
| step 7 (status) | + durable `locked` | consistent: the assessment that justifies it is already durable. **This is the window the reordering closed** — before it, this row left a lock with no evidence. |
| step 8 (notification) | complete except the alert | the operator is not notified; the durable state is correct and reviewable. |

### 3.6 Response lost after durable success

The client sees a timeout and retries the same batch.

- `micro_events`: `$setOnInsert` on `(sessionId, eventId)` inserts nothing and
  reports the events as duplicates, so counters are not inflated.
- Analysis: dedup layer 2 (code hash) suppresses re-analysis **when the code is
  unchanged and the process did not restart**. After a restart
  `lastAnalyzedCodeHash` is `""`, so the retry re-pays.
- Assessment: **fixed.** `risk_assessments` carries a unique index on
  `riskAssessmentId` and `storeRiskAssessment` is idempotent on it, so a re-analysis
  writes one row per incident. See §3.9.

### 3.7 Retry arrives after an ambiguous response

Covered by §3.6. The net guarantee is:

| Property | Guaranteed? |
| --- | --- |
| An event is stored at most once | **yes** — unique `(sessionId, eventId)` |
| Counters are not inflated by a retry | **yes** — only newly-inserted events are applied |
| A retry does not re-spend on analysis | **only within one process and only if the workspace is unchanged** |
| A retry does not duplicate the assessment | **yes** — unique `riskAssessmentId`, with the duplicate-key path handled rather than pre-checked |
| A retry does not re-notify | **no** — the notification has no dedup key |

### 3.8 Optional notification fails

`notifySlack` and `sendEmail` swallow every error and log it. `Promise.all`
therefore never rejects on their behalf, and a notification outage cannot fail the
ingest. This is correct and is the documented contract.

The inversion is that the notification is **awaited before the durable evidence is
written**, so a healthy notification can be delivered for an assessment that is
then never persisted (§3.4). The notification cannot corrupt durable telemetry
state — it is fire-and-forget with respect to correctness — but it can describe a
state that does not durably exist.

### 3.9 Documented-but-absent dedup layer — **now implemented**

The module header of `apps/api/src/routes/guardian.ts` listed four deduplication
layers, and layer 1 — "identical risk-assessment id from the AI provider" — **was not
implemented**. Nothing in the ingest path compared `riskAssessmentId`, and
`risk_assessments` carried no unique index on it:

```
riskAssessments.createIndex({ sessionId: 1, generatedAt: -1 })
riskAssessments.createIndex({ employeeId: 1 })
```

**Fixed.** `risk_assessments` now carries a unique index on `riskAssessmentId` and
`storeRiskAssessment` is idempotent on it, so a re-analysis of one incident stores one
row. Migration `0002-dedupe-risk-assessment-identity` removes any pre-existing
duplicates first — the same ordering constraint as migration 0001, because the index
cannot be created while duplicates exist. The header claim is restored, now that it is
true.

Two properties of the fix are worth stating:

- **The duplicate-key path is handled rather than pre-checked.** A read-then-insert
  would race: two concurrent analyses of one incident would both see nothing and both
  insert. The unique index is the arbiter, and a duplicate-key error is the *expected*
  outcome of a retry — so it is caught and reported as `inserted: false`, not as a
  failure. `isDuplicateKeyError` classifies it from the driver's error code (11000)
  rather than by matching a message, which is localised and version-dependent.
- **An assessment with no `riskAssessmentId` still gets one.** There is no identity to
  be idempotent on, so a retry stores a second row — the pre-existing behaviour for that
  shape. `parseRiskAssessment` always supplies an id at the provider boundary, so this
  is a fallback rather than a supported shape, and the contract suite asserts it
  explicitly.

## 4. The remaining operations

### O2 — Deploy

| Failure | Behaviour |
| --- | --- |
| Durable upsert fails | Logged, `mongoDocumentId` becomes `"local-only"`, the cache is written anyway, HTTP `201 success: true`. |
| Cache write fails | Impossible — a synchronous `Map.set`. |
| Process dies after the upsert, before the response | Session exists durably; the caller retries and gets an identical `201` (`$setOnInsert` is a no-op). Safe. |
| Deploy against a `terminated` id | Upsert cannot fire; HTTP `201 success: true` and nothing changes. The caller's intent is silently dropped. |

### O3 — Auto-lock / auto-clear

Cache first, durable second, durable result not inspected.

| Failure | Behaviour |
| --- | --- |
| Durable write fails | HTTP still `200`. The cache says `locked`; MongoDB says `active`. The API reports the cache value, so **the divergence is invisible until a restart**, at which point the lock disappears. |
| Process dies between cache and durable | Same as above, permanently. |
| Both writes succeed | Consistent. |

There is no rollback and no reconciliation pass. Nothing ever re-reads the durable
status to repair the cache.

### O4 — Reactivate

Durable first, cache second, durable result not inspected.

| Failure | Behaviour |
| --- | --- |
| Durable write fails | HTTP `200 success: true`, `reactivatedAt` populated. The cache is rebuilt as `active` and `lastActivityAt` is stamped, so **the session is treated as live by this process** while MongoDB still says `terminated`. A restart reverts it. |
| Session missing durably but present in cache | The durable write matches nothing; the cache is still rebuilt and the response claims success. |

### O5 — Terminate

**Closed.** Terminate goes through the transition boundary: read durable → validate →
write durably with a predicate → repair the caches. The durable write happens before
either cache is touched.

| Failure | Behaviour |
| --- | --- |
| Durable write fails | `503 SESSION_STORE_UNAVAILABLE` and **no cache is changed**. The session stays in the live registry, which is correct: it is still durably `active`. |
| Status changed between read and write | `409 SESSION_CONFLICT` and no cache is changed. |
| Already terminated | A legal no-op: `200`, no durable write, and the live registry is still evicted. |
| Process dies after the durable write, before the response | The session is durably `terminated`; the client retries and gets a no-op `200`. Safe. |

### O6 — Delete

**Partly closed.** The durable deletion is now attempted **first** and its answer
decides the response.

| Failure | Behaviour |
| --- | --- |
| The store does not answer | **`503 SESSION_STORE_UNAVAILABLE`, and nothing is changed** — not the durable state, not the caches. Clearing the caches would hide a session that is still durable, which is the divergence this ordering removes. |
| Durable delete matched nothing, but a cache held the session | `200`. A session that only ever existed in memory is deleted from this process's point of view; there is nothing durable to remove. |
| Durable delete matched nothing and no cache held it | `404`. |
| `deleteOne` succeeds, the two `deleteMany` calls fail | **Open.** The session document is gone and its `micro_events` / `risk_assessments` are orphaned. `deleteSession` runs the three under `Promise.all`, and the MCP tool reports only the session's `deletedCount`, so a partial deletion is reported as a complete one. |
| Second call | `404` — not idempotent in its response code, though idempotent in effect. |

### O7 — Threat scenario authoring

| Failure | Behaviour |
| --- | --- |
| Classifier unavailable | `503 CLASSIFIER_UNAVAILABLE`, fail-closed, `retryable: true`. No generation spend. Correct. |
| Generation fails | `503 AI_UNAVAILABLE` or `500 SCENARIO_GENERATION_FAILED`, classified by substring-matching the error text. |
| Persistence fails | **Explicitly reported**: `persisted: false` alongside the matrix. The paid artefact is returned to the caller even though it was not stored. This is the one paid path that tells the truth about a persistence failure. |
| Process dies after generation, before persistence | The matrix is lost and the spend is not recoverable. |

### O8 — Auditor query

No durable writes at all. A failure at any step is `500 AUDITOR_QUERY_FAILED`.
There is nothing to reconcile, and a retry re-spends both paid calls with no
dedup. Bounded by the rate limiter.

### O9 — Review list

Read-only, so there is no partial write. The failure mode is amplification rather
than inconsistency: `GET /api/v1/sessions` issues one `get_session_review` per
session, and each returns up to 500 micro-events plus every risk assessment. The
route uses the events only to re-derive counters that are already durable on the
session document. Measured in
[performance-baseline.md](performance-baseline.md); bounded in the
review-fetch work.

### O10 — Terminal content

A single `$set`. A write for a nonexistent session reports `{success: true}` —
`updateSession` matches nothing and the tool does not inspect `matchedCount`.
Nothing else can fail.

### O11 — Readiness

`/ready` asks the MCP adapter for `health_check` under a 1 500 ms timeout and
caches the answer. A failure is reported as not-ready with `503`; the probe never
throws. No paid call is involved. There is no notion of a *pending migration*
affecting readiness — the adapter runs migrations during `connect()`, so a
database with a pending migration is either not yet serving or already migrated.

## 5. Guarantees this system can honestly state

> **Updated twice.** The transition boundary gave the status rows a real guarantee, and
> the write-order change moved the assessment ahead of the side effects. The
> assessment-storage row is now narrower than it was, and the two rows that remain
> unqualified are named as the next items in §6.

| Operation | Guarantee |
| --- | --- |
| Telemetry storage | **At-most-once per `(sessionId, eventId)`.** Durable. |
| Telemetry-write outcome | **Reported.** `telemetryPersisted` says whether the store answered, and the accepted/duplicate counts are omitted when it did not, so a caller can distinguish "stored, all new" from "the store never answered". |
| Counter advancement | **Monotonic.** `$max` at the storage layer, so no caller and no restart can lower a durable total. |
| Status change | **Durable-first, validated and predicate-checked.** The durable status is read, the transition is validated against the table, the write applies only while the stored status is one it is legal from, and the caches are repaired from the durable outcome. A write that did not match is `SESSION_CONFLICT`; a store that did not answer is `SESSION_STORE_UNAVAILABLE`. **No cache can assert a status MongoDB does not hold.** |
| Status-change refusal | **The durable status is never changed and the requested change is never applied.** The cache *is* reconciled to the durable value the refusal read, so a divergence is corrected rather than reported. |
| Assessment storage | **Written before any side effect, reported, and idempotent on `riskAssessmentId`.** A failed write means no status change and no notification, so a lock always has recorded evidence, and a retry cannot write a second row for one incident. |
| Notification | **Best effort, and last.** Not durable, not retried, not ordered, no dedup key. It cannot affect the durable state, and it is no longer sent for an assessment that was not stored. |
| Scenario authoring | **Honest reporting.** The response states whether persistence succeeded. |
| Deletion | **Reported when the store does not answer** (`503`, nothing changed). A partial deletion — the session document removed but its events or assessments not — is still reported as complete, because the MCP tool reports only the session's `deletedCount`. |

## 6. What this cycle will change

Ordered by the value of the outcome. Each is a code change with a regression test,
not a documentation change.

1. **Status transitions become a durable-first, precondition-checked,
   result-inspected operation.** **Done** — the transition boundary. This closed
   §3.4's lock-without-evidence window for the status half, §3.5's step-7 window, and
   O3/O4/O5's silent divergence.
2. **`terminated` becomes a precondition on ingest.** **Done** — closes the confirmed
   P1 in [state-transition-model.md](state-transition-model.md) §3.1.
3. **`terminate` reports a durable failure rather than success.** **Done** — O5's
   guarantee.
4. **The assessment write moves ahead of the notification and the status write.**
   **Done** — §3.4.1 and §3.5. A failed assessment write now skips both later steps.
5. **The events-write failure becomes visible in the response.** **Done** —
   `telemetryPersisted`, with the counts omitted rather than guessed at.
6. **`delete` reports a durable failure rather than success.** **Done** for an
   unreachable store (`503`, nothing changed). A *partial* deletion is still reported as
   complete; that needs the MCP tool to report per-collection counts, and is open.
7. **The assessment write becomes idempotent on `riskAssessmentId`.** **Done** — closes
   §3.6's duplicate-row window and makes the documented dedup layer 1 real. Migration
   0002 removes pre-existing duplicates; the contract suite verified the gap by
   *characterising* it and now verifies the fix, so neither could land silently.
8. **A partial deletion is reported as complete.** Open. `deleteSession` removes the
   session, its events and its assessments under one `Promise.all`, and the MCP tool
   reports only the session's `deletedCount`. Fixing it needs the tool to report
   per-collection counts.

Not planned, and why:

- **No durable outbox for notifications.** Product correctness does not require
  ordered, exactly-once alerting; it requires that a notification failure cannot
  corrupt telemetry state, which already holds. Recorded as best-effort in the
  threat model and in [operations/](../operations/).
- **No generic job system or operation record for the paid path.** The evidence in
  §3 does not require one. Moving the assessment ahead of the side effects removed the
  failure window that would have justified it: there is no longer a state in which paid
  work produced a durable side effect without a durable record. If a future change adds
  a *second* durable artefact to the paid path, this decision is revisited with that
  evidence.
- **No distributed lock or transaction.** Every divergence identified here is
  closable with a single-document atomic predicate on `monitored_sessions`. MongoDB
  transactions would require a replica set, which the documented single-node
  deployment does not have.
- **No rollback of a completed paid analysis when persistence fails.** The spend is
  already gone; inventing a compensating action would be fake rollback. The response
  reports the truth instead, and the next batch retries.

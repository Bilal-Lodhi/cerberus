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

The ingest analysis path does not follow it. Its actual order is:

| Step | Action | Kind |
| --- | --- | --- |
| 1 | `ingest_micro_events` | durable truth (telemetry) |
| 2 | `update_session_counts` | durable truth (counters) |
| 3 | `load_reference_documents` | read |
| 4 | `analyzeRisk()` | **paid** |
| 5 | `recommendIncidentActions()` | **paid** |
| 6 | `notifySlack` + `sendEmail` | **optional side effect** |
| 7 | `lockSession()` / `unlockSession()` | durable truth (status), cache written first |
| 8 | `store_risk_assessment` | **durable truth (the evidence)** |
| 9 | HTTP response | — |

Steps 6 and 7 both precede step 8. So the optional side effect runs before the
durable evidence exists, and the status change runs before the assessment that
justifies it. Every failure window between 6 and 9 is analysed in §3.

## 2. Inventory

| # | Operation | Steps that can fail independently |
| --- | --- | --- |
| O1 | Ingest a telemetry batch | events write, counters write, corpus read, paid analysis, paid recommendation, notification, status write, assessment write |
| O2 | Deploy a session | session upsert, cache write |
| O3 | Auto-lock / auto-clear | cache write, durable status write |
| O4 | Reactivate | durable status write, cache write |
| O5 | Terminate | cache delete, cache mutate, durable status write |
| O6 | Delete | cache deletes, durable session delete, durable event delete, durable assessment delete |
| O7 | Author a threat scenario | paid classify, paid generate, durable scenario write |
| O8 | Auditor query | paid pipeline build, in-process apply, paid summary |
| O9 | Review list | N per-session durable reads, in-process merge |
| O10 | Terminal-content write | durable write only |
| O11 | Readiness probe | MCP health check, cache of the result |

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
| Guarantee | **none.** The response is indistinguishable from a fully successful ingest. |

This is the largest honesty gap in the operation: a caller cannot tell from the
response whether its telemetry was stored. `acceptedCount === processedCount` and
`duplicateCount === 0` mean "stored, all new" *and* "the store never answered".

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

The paid analysis completes, the payload is enriched and blended, and then
`store_risk_assessment` fails (MCP unreachable, timeout, or the write itself
erroring). The failure is caught by the enclosing `catch (analysisError)`, which
logs `AI analysis failed (non-fatal)` — **a message that is wrong**: the analysis
succeeded and the *persistence* failed.

| Already happened by then | State |
| --- | --- |
| Paid analysis | spent, unrecoverable |
| Paid recommendation (if score ≥ 75) | spent, unrecoverable |
| Notifications (if score ≥ 75) | **delivered** |
| Status write (if score ≥ 75) | **durable `locked`** |
| Assessment | **not stored** |
| HTTP | `200 success: true`, `riskPayload` populated |

So the caller is told the operation succeeded and receives a risk payload that
exists only in the response body and in `sessionStore.lastRiskPayload`. After a
restart, the review surface shows a `locked` session with an empty
`riskSummary`, `finalRiskScore` falling back to the in-memory payload — which is
now gone — and therefore **a lock with no recorded justification**.

### 3.5 Process dies between writes

| Dies after | Durable state | Consequence |
| --- | --- | --- |
| step 1 | telemetry only | no counters, no status, no evidence. Client retry is safe (events dedup by `eventId`). |
| step 2 | telemetry + counters | as above; counters are consistent with telemetry. |
| step 4 | + paid spend | money spent, nothing recorded. Retry re-pays unless `lastAnalyzedCodeHash` survived — and it is in-memory only, so **a restart re-pays**. |
| step 5 | + second paid spend | two paid calls lost. |
| step 6 | + notification delivered | operator alerted about an incident with no durable record and no lock. |
| step 7 | + durable `locked` | **a lock whose evidence was never written.** |
| step 8 | complete | consistent. |

### 3.6 Response lost after durable success

The client sees a timeout and retries the same batch.

- `micro_events`: `$setOnInsert` on `(sessionId, eventId)` inserts nothing and
  reports the events as duplicates, so counters are not inflated.
- Analysis: dedup layer 2 (code hash) suppresses re-analysis **when the code is
  unchanged and the process did not restart**. After a restart
  `lastAnalyzedCodeHash` is `""`, so the retry re-pays.
- Assessment: `storeRiskAssessment` is a plain `insertOne` with **no unique index
  on `riskAssessmentId`** and no dedup in the route, so a re-analysis writes a
  **second assessment row** for the same incident.

### 3.7 Retry arrives after an ambiguous response

Covered by §3.6. The net guarantee is:

| Property | Guaranteed? |
| --- | --- |
| An event is stored at most once | **yes** — unique `(sessionId, eventId)` |
| Counters are not inflated by a retry | **yes** — only newly-inserted events are applied |
| A retry does not re-spend on analysis | **only within one process and only if the workspace is unchanged** |
| A retry does not duplicate the assessment | **no** |
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

### 3.9 Documented-but-absent dedup layer

The module header of `apps/api/src/routes/guardian.ts` lists four deduplication
layers:

```
 *   1. identical risk-assessment id from the AI provider
 *   2. code-hash equality — skip re-analysis when the workspace is unchanged
 *   3. micro-event fingerprint ring (last 128) — suppress replayed batches
 *   4. behavioural counter blend — repeated violations amplify the score
```

Layer 1 **is not implemented.** Nothing in the ingest path reads
`riskAssessmentId` for comparison, and `riskAssessments` carries no unique index
on it:

```
riskAssessments.createIndex({ sessionId: 1, generatedAt: -1 })
riskAssessments.createIndex({ employeeId: 1 })
```

So the header overstates the deduplication the code performs. Layers 2, 3 and 4
exist and are exercised; layer 1 is a claim with no implementation behind it. It is
either implemented or the header is corrected — and since the assessment write is
the one durable artefact of the paid path, implementing it is the more valuable of
the two.

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

Cache first (including `activeSessions.delete`), durable second, durable result
used only to decide `found`.

| Failure | Behaviour |
| --- | --- |
| Durable write fails | `found` is already `true` from the cache mutations, so HTTP `200 success: true` and `"Session terminated (data preserved)"`. MongoDB still says `active`. **A restart resurrects a session the operator terminated.** |
| Process dies after the cache delete | Same, and the session is gone from the live list for this process only. |

### O6 — Delete

| Failure | Behaviour |
| --- | --- |
| Durable delete fails | HTTP `200 success: true`. The cache is cleared, so the session is invisible until a restart, then returns. |
| `deleteOne` succeeds, the two `deleteMany` calls fail | The session document is gone and its `micro_events` / `risk_assessments` are orphaned. `deleteSession` runs them under `Promise.all`, so a rejection there propagates — but `callMcpTool` never rejects, so a partial deletion is reported as a complete one. |
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

| Operation | Guarantee |
| --- | --- |
| Telemetry storage | **At-most-once per `(sessionId, eventId)`.** Durable. |
| Counter advancement | **Monotonic.** `$max` at the storage layer, so no caller and no restart can lower a durable total. |
| Status change | **No guarantee.** Cache and durable status can disagree; the write is not atomic with the cache and its result is not inspected. |
| Assessment storage | **No guarantee.** A paid analysis can complete with no durable record, and a retry can duplicate one. |
| Notification | **Best effort.** Not durable, not retried, not ordered, no dedup key. |
| Scenario authoring | **Honest reporting.** The response states whether persistence succeeded. |
| Deletion | **No guarantee** that a deleted session stays deleted across a restart if the durable delete failed. |

## 6. What this cycle will change

Ordered by the value of the outcome. Each is a code change with a regression test,
not a documentation change.

1. **Status transitions become a durable-first, precondition-checked,
   result-inspected operation.** This closes §3.4's lock-without-evidence window
   for the status half, §3.5's step-7 window, and O3/O4/O5's silent divergence.
2. **`terminated` becomes a precondition on ingest.** Closes the confirmed P1 in
   [state-transition-model.md](state-transition-model.md) §3.1.
3. **The assessment write moves ahead of the notification and the status write.**
   Restores the ordering rule for the one durable artefact of the paid path.
4. **The assessment write becomes idempotent on `riskAssessmentId`.** Closes §3.6's
   duplicate-row window and makes the documented dedup layer 1 real, or removes
   the claim from the header.
5. **The events-write failure becomes visible in the response.** §3.1 is the
   largest honesty gap; the fix is a field that distinguishes "the store reported
   these as new" from "the store did not answer", without changing
   `processedCount`'s meaning.
6. **`terminate` and `delete` report a durable failure rather than success.** O5 and
   O6 currently claim an outcome that did not durably happen.

Not planned, and why:

- **No durable outbox for notifications.** Product correctness does not require
  ordered, exactly-once alerting; it requires that a notification failure cannot
  corrupt telemetry state, which already holds. Recorded as best-effort in the
  threat model and in [operations/](../operations/).
- **No generic job system or operation record for the paid path.** The evidence in
  §3 does not yet require one. Making the assessment write idempotent and moving it
  ahead of the side effects removes the failure window that would justify it. If a
  future change adds a second durable artefact to the paid path, this decision is
  revisited with that evidence.
- **No distributed lock or transaction.** Every divergence identified here is
  closable with a single-document atomic predicate on `monitored_sessions`. MongoDB
  transactions would require a replica set, which the documented single-node
  deployment does not have.

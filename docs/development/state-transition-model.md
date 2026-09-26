# Session state-transition model

Every lifecycle mutation a monitored session can undergo, what initiates it, what
it writes, and what it does when a step fails.

This document is a map written from the source, not from intent. It exists
because the phase goal is a **single canonical transition boundary**, and you
cannot design one until you know how many there currently are.

> **Status: the boundary now exists.** §2 and §3.2 are the **historical record** —
> what the five independent paths did and how they disagreed — and are kept because
> they are the specification the boundary was built to satisfy. §3.1's defect and
> every divergence in §3.2 except the last are **fixed**; §4 states what the boundary
> owns and §5 records what remains open. The enforced model is the table in §3, read
> as "what the boundary permits" rather than "what the code happened to do".

Companion documents:

- [session-state-model.md](session-state-model.md) — the *fields*, their class and
  their durable home.
- [failure-semantics.md](failure-semantics.md) — what each multi-step operation
  guarantees when a step fails.
- [test-double-contract.md](test-double-contract.md) — why the existing suite did
  not catch the divergence recorded below.
- [api-errors.md](../api-errors.md) — the codes a refused transition returns.

## 1. Status vocabulary

Three vocabularies are in play, and only the first is durable.

| Vocabulary | Where | Values |
| --- | --- | --- |
| Durable session status | `SESSION_STATUSES`, `packages/mcp-mongodb/src/tool-names.ts` | `active`, `locked`, `terminated` |
| Review-facing status | `SessionReviewResponse["status"]`, `apps/api/src/types.ts` | `active`, `flagged`, `investigating`, `cleared`, `locked`, `terminated` |
| Live-registry status | `ActiveSession["status"]`, `apps/api/src/types.ts` | `active`, `flagged`, `investigating`, `cleared`, `locked` — **no `terminated`** |

`PERSISTED_SESSION_STATUSES` in `apps/api/src/routes/guardian.ts` is the union of
the first two and is used by exactly one function, `normalizeStatus()`, which maps
anything unrecognised onto `active`.

**Only `active`, `locked` and `terminated` are ever written.** `flagged`,
`investigating` and `cleared` are derived at read time in
`apps/api/src/routes/review.ts` and are never persisted:

- `flagged` — the newest assessment scored above 50;
- `investigating` — a `SUBMIT` event exists and the session is not flagged;
- `cleared` — a member of the review vocabulary with **no producer at all**. It is
  reachable only if a document already contains it, which nothing writes. It is
  accepted by `normalizeStatus()` and by the review response type, so it is a
  legal value that the system cannot produce.

`set_session_status` rejects anything outside `active | locked | terminated`, so a
fourth persisted value is not merely discouraged — it is refused at the adapter.

## 2. The five mutation paths

> **Historical.** This section describes the five independent paths as they were before
> the boundary. It is the specification the boundary was built to satisfy; the enforced
> behaviour is §3 and §4.

`sessionStore` and `activeSessions` are the two in-memory maps created by
`createGuardianRouter()` and shared with the review router (see
[session-state-model.md](session-state-model.md) §1). Both are per-process and
both are empty after a restart.

### T1 — Deploy: create a monitored session

| | |
| --- | --- |
| Route | `POST /api/v1/guardian/deploy` |
| Precondition | `employeeUid`, `sessionId`, `matrixId`, `targetSystem` all non-empty after trim |
| Durable source of truth | `monitored_sessions` (upsert) |
| Cache source | `activeSessions` |
| Durable writes | `create_session` → `updateOne({sessionId}, {$setOnInsert: {status: "active", …, createdAt, updatedAt}}, {upsert: true})` |
| Cache writes | `activeSessions.set(sessionId, {status: "active", deployedAt, riskIndex: 0, lastActivityAt: deployedAt})` |
| Ordering | **durable, then cache** |
| Side effects | none |
| AI involvement | none |
| Retry | idempotent. `$setOnInsert` means a second deploy inserts nothing and does **not** overwrite an existing status. The response is identical either way. |
| Idempotency key | `sessionId` (the unique index on `monitored_sessions.sessionId`) |
| Terminal behaviour | A deploy for a session id that is already `terminated` **succeeds and does nothing to the status** — `$setOnInsert` cannot fire. The response reports success, so a caller cannot tell that its deploy was a no-op against a terminal session. |
| Failure behaviour | A failed `create_session` is swallowed: `mongoDocumentId` becomes the literal `"local-only"` and the cache is written anyway. The session is live in memory and absent from MongoDB, and the response is `201 success: true`. |
| Restart | Memory is lost; the session is recovered from `monitored_sessions` by the `LIST_SESSIONS` path only when both maps are empty. |
| Concurrency | Two concurrent deploys for the same id: one `$setOnInsert` wins, both return `201`. `activeSessions.set` is last-writer-wins, so the two `deployedAt` values can differ between cache and document. |

### T2 — Ingest: create a session as a side effect of telemetry

| | |
| --- | --- |
| Route | `POST /api/v1/guardian/ingest`, via `ensureMongoSession()` |
| Precondition | `events` non-empty, ≤ `MAX_EVENTS_PER_BATCH`, every event has a non-empty `eventId`, first event has a `sessionId` |
| Durable source of truth | `monitored_sessions` |
| Cache source | `sessionStore` (never `activeSessions`) |
| Durable writes | `get_session_review` to probe; if absent, `create_session` with `status: "active"` |
| Cache writes | **none.** `ensureMongoSession` does not touch `activeSessions`. The session reaches `sessionStore` later, through `hydrateSessionFromDurable` + `processEvent`. |
| Ordering | probe, then create |
| Retry | idempotent (`$setOnInsert`) |
| Failure behaviour | A failed create is non-fatal: it logs and returns `null`, so hydration is skipped and the in-memory counters start at zero. The batch still returns `200 success: true`. |
| **Divergence** | A session created by ingest is present in `sessionStore` but **absent from `activeSessions`**. `GET /api/v1/guardian/sessions/:id` therefore reports it from the `session` branch with `matrixId: activeSession?.matrixId ?? session.auditId` and `targetSystem: ""`, while a deployed session reports both from the registry. The same session id has two different shapes depending on how it was created. |

### T3 — Auto-lock

| | |
| --- | --- |
| Initiator | `ingest`, inside the analysis block, when the blended `overallRiskScore >= AUTO_LOCK_THRESHOLD` (75) |
| Precondition | **score only.** There is no check on the session's current status or liveness. |
| Durable source of truth | `monitored_sessions.status` |
| Durable writes | `set_session_status(sessionId, "locked", reason)` |
| Cache writes | `activeSessions.status = "locked"`, `sessionStore.status = "locked"` |
| Ordering | **cache, then durable** — and the durable result is not inspected |
| Side effects | `notifySlack` + `sendEmail`, awaited via `Promise.all` **before** the lock is written |
| AI involvement | `recommendIncidentActions()` — a second paid call — runs before the notifications and the lock |
| Retry | **not idempotent in effect.** `set_session_status` has no precondition, so re-running it re-writes `locked` and bumps `updatedAt`, which extends the TTL window. |
| Idempotency key | none |
| Terminal behaviour | **Violated.** See §3. |
| Failure behaviour | If the durable write fails, the cache still says `locked`. `GET /api/v1/guardian/sessions/:id` prefers `activeSession.status`, so the API reports `locked` while MongoDB says `active`. The divergence is invisible until a restart. |
| Restart | The cache is lost and the durable status wins, so a lock whose write failed **silently disappears** across a restart. |

### T4 — Auto-clear

| | |
| --- | --- |
| Initiator | `ingest`, inside the analysis block, when `overallRiskScore < AUTO_CLEAR_THRESHOLD` (25) |
| Precondition | `activeSessions.get(sessionId)?.status === "locked"` — **the cache, not the durable document** |
| Durable writes | `set_session_status(sessionId, "active")` |
| Cache writes | both maps set to `active` |
| Ordering | cache, then durable |
| Failure behaviour | Same shape as T3: cache says `active`, database may say `locked`. |
| **Divergence** | The precondition reads the cache, so a session that is durably `locked` but whose cache entry was lost by a restart **cannot be auto-cleared**. A restart permanently freezes a locked session until an operator reactivates it explicitly. |

### T5 — Reactivate

| | |
| --- | --- |
| Route | `POST /api/v1/guardian/sessions/:sessionId/reactivate` |
| Precondition | The session exists in `sessionStore`, `activeSessions` or MongoDB, **and** its status is not `terminated` |
| Durable source of truth | `monitored_sessions.status` |
| Durable writes | `set_session_status(sessionId, "active")` |
| Cache writes | `sessionStore.status = "active"` + `touchSession`; `activeSessions.set(...)` rebuilt from whichever sources exist |
| Ordering | **durable, then cache** — the opposite of T3/T4 |
| Retry | idempotent for a live session; refused with `409 SESSION_TERMINATED` for a terminal one |
| Terminal behaviour | Correct: the only path in the system that explicitly refuses a transition out of `terminated`. |
| Failure behaviour | If the durable write fails, the cache is still rebuilt as `active`, so the API reports `active` while MongoDB says `terminated`. `reactivatedAt` is derived from the injected clock, so the response claims a reactivation that did not durably happen. |
| Concurrency | Two concurrent reactivations both write `active` and both return `200`. |

### T6 — Terminate

| | |
| --- | --- |
| Route | `POST /api/v1/guardian/sessions/:sessionId/terminate` |
| Precondition | **none** — the route does not check the current status |
| Durable writes | `set_session_status(sessionId, "terminated")` |
| Cache writes | `activeSessions.delete(sessionId)`; `sessionStore.status = "terminated"`, `sessionStore.endedAt = now`, `touchSession` |
| Ordering | **cache first (including a delete), then durable** |
| Retry | idempotent. A second terminate finds no cache entries, but `set_session_status` still matches the document and reports `updated: true`, so `found` is true and the response is `200`. `endedAt` is re-stamped. |
| Terminal behaviour | `terminated` is treated as irreversible by `reactivate` and by the restart-recovery path (`isMonitored()`). It is **not** irreversible by `ingest` — see §3. |
| Failure behaviour | If the durable write fails, the cache has already dropped the session from `activeSessions` and marked it `terminated` in `sessionStore`. `found` is therefore still true and the response is `200 success: true`, while MongoDB still says `active`. A restart resurrects the session. |
| Concurrency | Terminate racing auto-lock: both write `set_session_status` with no precondition, so the **last writer wins** and the outcome depends on arrival order. Nothing detects the conflict. |

### T7 — Delete

| | |
| --- | --- |
| Route | `DELETE /api/v1/guardian/sessions/:sessionId` |
| Precondition | none |
| Durable writes | `delete_session` → `deleteOne(sessions)` **plus** `deleteMany(micro_events)` and `deleteMany(risk_assessments)` |
| Cache writes | `activeSessions.delete`, `sessionStore.delete` |
| Ordering | cache, then durable |
| Retry | The first call returns `200`; a second returns `404` (nothing matched). So delete is **not** idempotent in its response code, though it is in effect. |
| Failure behaviour | If the durable delete fails, the cache is already cleared and the response is `200 success: true`. A restart recovers the session from MongoDB — an operator who deleted a session sees it come back. |
| Concurrency | Delete racing ingest: the ingest may re-create the session through `ensureMongoSession` after the delete removed it, leaving orphaned `micro_events` for a session document that no longer exists (the events are written by `sessionId` with no referential check). |

### T8 — Terminal content update

| | |
| --- | --- |
| Initiator | **None in the API.** `MCP_TOOL_NAMES.UPDATE_SESSION_TERMINAL_CONTENT` is published by the MCP server and is callable by any MCP client; no route calls it. |
| Durable writes | `store.updateSession(sessionId, {terminalContent})` → `$set {terminalContent, updatedAt}` |
| Cache writes | none |
| Precondition | none — `updateSession` matches on `sessionId` and silently matches nothing for an unknown session. The tool returns `{success: true}` either way. |
| Retry | idempotent (a `$set` of the same value) |
| Failure behaviour | A write for a nonexistent session reports success. |
| Ownership | The review route reads `session.terminalContent` first, then the in-memory `currentCode`, then the newest assessment's `codeSnapshot`. So there are **three candidate sources for one concept**, and the durable session field — the one the published tool writes — is authoritative only because nothing writes it. |

## 3. The transition table

**This is now the enforced table.** It is implemented once, in
`apps/api/src/services/session-transition.ts`, and every allowed transition, every
refused one, a repeated transition and the terminal state are asserted through the
real routes in `apps/api/test/session-transition.test.ts`.

`→` is a legal transition. `⊘` is a transition the boundary refuses. `✗` marks a
transition that was performed before the boundary existed and is now refused — the
column records history, not current behaviour.

| From | To | Initiator | Legal? | Evidence |
| --- | --- | --- | --- | --- |
| *(absent)* | `active` | deploy | yes | T1 |
| *(absent)* | `active` | ingest | yes | T2 |
| `active` | `locked` | ingest auto-lock | yes | T3 |
| `locked` | `locked` | ingest auto-lock | yes — legal no-op | T3, idempotent |
| `locked` | `active` | ingest auto-clear | yes | T4 |
| `active` | `active` | ingest auto-clear | yes — legal no-op | T4 |
| `active` | `active` | reactivate | yes — legal no-op | T5, idempotent |
| `locked` | `active` | reactivate | yes | T5 |
| `active` | `terminated` | terminate | yes | T6 |
| `locked` | `terminated` | terminate | yes | T6 |
| `terminated` | `terminated` | terminate | yes — legal no-op | T6, idempotent |
| `terminated` | `active` | reactivate | **⊘ refused** | `409 SESSION_TERMINATED` |
| `terminated` | `active` | ingest auto-clear | **⊘ refused** | `409 SESSION_TERMINATED` |
| `terminated` | `locked` | ingest auto-lock | **⊘ refused** | was ✗ performed; see §3.1 |
| `terminated` | *(counters advanced)* | ingest | **⊘ refused** | was ✗ performed; see §3.1 |
| `flagged` / `investigating` / `cleared` | any | — | **⊘ refused** as `INVALID_SESSION_TRANSITION` | never persisted, so a document holding one is a data-integrity problem |

A legal no-op is not a refusal: the session was already in the target state, so
nothing is written and the result reports `applied: false`. That is what makes a
retried `terminate` a `200` rather than an error.

### 3.1 Confirmed defect: ingest resurrects a terminated session — **fixed**

`POST /ingest` checked exactly one precondition on the session's state — whether
its monitoring window had expired — and never checked the status. A `terminated`
session that had not yet exceeded `SESSION_TTL_SECONDS` therefore passed that gate,
and the rest of the path ran normally:

- `ingest_micro_events` stores the batch — `micro_events` has no referential check
  against the session's status;
- `update_session_counts` advances the durable counters;
- if the batch triggers analysis and the blended score reaches
  `AUTO_LOCK_THRESHOLD`, `lockSession()` runs and **writes
  `set_session_status(sessionId, "locked")`** — because `lockSession` has no
  precondition either.

Observed against the in-process double, on a session terminated moments earlier,
**before the fix**:

```
durable status after terminate:      "terminated"
ingest after terminate:              200
durable status after that ingest:    "locked"
micro_events stored for the session: 2
```

So a terminated session was not terminal. Telemetry continued to accumulate
against it, and a high-risk batch moved it to `locked` — a state the operator
never chose, on a session they explicitly stopped. `reactivate` refused exactly
this transition (`terminated → active`) with `409 SESSION_TERMINATED`, so the two
paths disagreed about whether `terminated` was reversible.

**Why this was P1.** It is a correctness violation of the one irreversible
lifecycle guarantee the system documents
(`apps/api/src/services/session-liveness.ts`, [maturity-plan.md](maturity-plan.md),
the threat model), reachable by any caller
holding the operator key, and it silently un-does an explicit operator action.

**Why the suite missed it.** `set_session_status` in three of the four MCP doubles
returned `{success: true, updated: true}` without persisting anything, and the
fourth (`session-lifecycle.test.ts`) persisted it but was never driven through
terminate-then-ingest. See [test-double-contract.md](test-double-contract.md).

**The fix.** Ingest refuses a terminated session with `409 SESSION_TERMINATED`
before any write, gating on the durable document it has already read, through the
boundary's own `acceptsTelemetry` rule. The auto-lock path is the second line of
defence: `autoLock` is not in the transition table for a terminated session, so even
if telemetry were admitted the lock could not fire. Regression tests live in
`apps/api/test/session-transition.test.ts` under "a terminated session is terminal".

### 3.2 Other divergences in the table

Every divergence below except **D5** and **D6** is closed by the transition boundary.
They are kept as the record of what the boundary was built to fix, and as the list a
future path must not reintroduce.

| # | Divergence | State |
| --- | --- | --- |
| D1 | T3/T4 order writes cache-first; T5 orders them durable-first; T6/T7 are cache-first with a delete | **Closed.** Every action now reads durable → validates → writes durably → repairs caches, in that order, from one implementation. |
| D2 | T3, T4 and T6 ignore the durable write's result | **Closed.** The result decides the outcome: a write that did not match is `SESSION_CONFLICT` or `SESSION_STORE_UNAVAILABLE`, never `200 success: true`. |
| D3 | T4's precondition reads the cache | **Closed.** The precondition is the durable status, read on every transition. A durably `locked` session can be auto-cleared after a restart. |
| D4 | T6 has no precondition and no terminal guard | **Closed.** `terminate` is in the table for every durable status and is idempotent, so a repeat is a legal no-op rather than an unvalidated write. |
| D5 | T2 leaves `activeSessions` unpopulated | **Open.** A session created by ingest has no live-registry entry until something creates one — which the boundary now does on its first transition. It remains a shape difference, recorded in §5. |
| D6 | T1 reports success for a deploy against a `terminated` session | **Open.** `$setOnInsert` cannot fire, so the caller's intent is silently ignored. Recorded in §5. |
| D7 | `set_session_status` has no compare-and-set | **Closed.** The tool accepts an optional `expectedStatuses` predicate, and the boundary passes the statuses it read. Verified against a real MongoDB. |
| D8 | No transition validates the *current* durable status | **Closed.** Every action validates against the table before writing, and a status outside the durable vocabulary is `INVALID_SESSION_TRANSITION`. |

## 4. What the boundary owns

**Built.** `apps/api/src/services/session-transition.ts`, with the vocabulary in
`apps/api/src/services/session-status.ts`. Derived from §2 and §3 rather than from a
template, it is responsible for:

1. **Loading the durable current state** and treating it as the authority. A cache is
   read only to decide whether the cache needs repairing, never to decide whether
   a transition is legal.
2. **Validating the requested transition** against the table in §3, returning a
   stable outcome rather than performing it. Domain actions, not `setStatus`:
   `terminate`, `autoLock`, `autoClear`, `reactivate`, `updateTerminalContent`.
3. **Applying the durable write with an atomic predicate** on the status it read, so a
   concurrent transition is detected rather than overwritten. `set_session_status`
   accepts an optional `expectedStatuses` list, and the contract suite verifies it
   against a real MongoDB.
4. **Returning a canonical result** that distinguishes *applied*, *already in that
   state* (a legal no-op), *refused by the transition table*, and *conflict with a
   concurrent transition*.
5. **Repairing both caches from the durable result**, not from the caller's intent, so
   a failed durable write cannot leave a cache asserting a status MongoDB does not
   hold. A refusal that read the durable status also reconciles the cache to what it
   read, so a divergence is corrected rather than reported.
6. **Exposing stable error codes** — `INVALID_SESSION_TRANSITION`,
   `SESSION_TERMINATED`, `SESSION_CONFLICT`, `SESSION_NOT_FOUND`,
   `SESSION_STORE_UNAVAILABLE` — without internal detail. See
   [api-errors.md](../api-errors.md) §4.

Explicitly **not** the boundary's job: telemetry validation, counter arithmetic,
AI analysis, notifications, or persistence of anything other than session
lifecycle state. Centralising unrelated logic into one service would trade five
small divergences for one large coupling.

The cache is reached through a `SessionTransitionCache` interface rather than by
importing the two maps, so the service does not import a route module — which would be
a layering inversion and a runtime import cycle. `routes/guardian.ts` implements it.

### 4.1 What adoption changed

| Path | Before | After |
| --- | --- | --- |
| `terminate` | cache mutated first, durable result used only to compute `found`; a failed write returned `200 success: true` | durable-first, result-inspected; `503` when the store did not answer, `409 SESSION_CONFLICT` when the status moved |
| `reactivate` | durable-first, but the registry rebuild lived in the route and the write's result was ignored | boundary-owned; the rebuild is part of the cache adapter |
| `auto-lock` / `auto-clear` | cache-first, result ignored, precondition read from the cache | boundary-owned; precondition is the durable status |
| ingest | checked TTL only | also refuses a terminated session, through the boundary's own rule |
| `GET /guardian/sessions` | TTL was the only filter on the in-memory path; the recovery path guarded the registry but still listed terminated sessions | all three paths exclude a non-monitored session |

### 4.2 Status changes this cycle will require

| Change | Kind | Migration |
| --- | --- | --- |
| `terminated` becomes a precondition on ingest | **done** — behaviour fix, no schema change | none |
| Status writes gain a compare-and-set predicate | **done** — behaviour fix, no schema change | none |
| `cleared` loses its membership of the persisted vocabulary, or gains a producer | vocabulary decision | none if no document holds it; a status rewrite if one does |
| `focusLossCount` replaces `fullscreenExitCount` as the truthful name | **field rename** — see [session-state-model.md](session-state-model.md) §5.7 | a migration if the durable field is renamed |

Only the last is a schema change, and it is decided separately with the WINDOW_BLUR
work.

## 5. What remains open

1. **Is `cleared` a status the system should be able to reach?** Nothing produces
   it. Either a producer is added (an operator action that clears a session
   without a low score) or it is removed from the vocabulary. Removing a value from
   a published response type is a compatibility change, so this needs a decision
   recorded in [compatibility.md](../compatibility.md).
2. **Should a deploy against an existing session id be a conflict rather than a
   silent no-op?** `$setOnInsert` makes it a no-op today (D6).
3. **Should a session created by ingest get a live-registry entry?** It does not
   today (D5), so one session id has two response shapes depending on how it was
   created. The boundary now creates the entry on its first transition, which narrows
   the window but does not remove the difference.
4. **`GET /api/v1/guardian/sessions/:sessionId` has no durable fallback.** It reads
   the two maps only, so immediately after a restart it answers `404` for a session
   that exists until the live list is called, which is the path that rebuilds the
   registry. The review route is durable and unaffected.

### 5.1 Answered

- **Should `terminated` block ingest with its own error code, or reuse
  `SESSION_TERMINATED`?** Reused. One code, one meaning — the session has ended — and
  a client handles the same condition once. Recorded in
  [api-errors.md](../api-errors.md) §4.

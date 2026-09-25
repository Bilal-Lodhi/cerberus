# Session state model

Every piece of session state Cerberus holds, where its authority actually lives,
and what happens to it across a restart.

This is an inventory written from the source, not from intent. Where a field is
lost on restart, that is stated rather than implied. It exists because the
durability work in this phase needs a map: you cannot decide what MongoDB should
own until you know what is currently owned by a `Map` in one process.

## 1. The two in-memory maps

`createGuardianRouter()` in `apps/api/src/routes/guardian.ts` creates two maps,
and hands both to the review router:

| Map | Holds | Populated by |
| --- | --- | --- |
| `sessionStore: Map<string, SessionState>` | Full live state for sessions that have ingested telemetry | `processEvent()` on the first accepted event |
| `activeSessions: Map<string, ActiveSession>` | The deployment registry, so a session appears in listings before any event arrives | `POST /deploy`, and durable recovery |

Both are per-process. Both are empty after a restart.

## 2. Classification

Each field is one of:

- **A — Durable authority.** MongoDB is the source of truth. Memory is a cache of
  it, and losing the cache loses nothing that matters.
- **B — Reconstructable cache.** Not stored directly, but derivable from
  something that is. Losing it costs work, not evidence.
- **C — Ephemeral only.** Deliberately or accidentally in memory only. Losing it
  changes behaviour, and this document says how.
- **D — Derived view.** Computed at read time from other fields; never stored.

## 3. `SessionState` field by field

Defined at `apps/api/src/routes/guardian.ts`. "Durable home" names the collection
and field that holds the authoritative value, if any.

| Field | Class | Durable home | Written by | Read by | After restart |
| --- | --- | --- | --- | --- | --- |
| `sessionId` | A | `monitored_sessions.sessionId` | deploy, ingest, reactivate | everything | Preserved |
| `employeeId` | A | `monitored_sessions.employeeId` | deploy, `ensureMongoSession` | review, list, notifications | Preserved |
| `auditId` | A | `monitored_sessions.auditId` | deploy, `ensureMongoSession` | review, list | Preserved |
| `events` | B | `micro_events` (one document per event) | `ingest_micro_events` | review timeline, `collectPasteContents`, analysis triggers | Reconstructed on read from `micro_events`; the in-memory array starts empty and refills only as new batches arrive |
| `currentCode` | B | `risk_assessments.codeSnapshot` (latest assessment) | rebuilt in memory only | risk analysis, review `terminalContent` | **Lost from the session document.** The review route falls back to the latest assessment's `codeSnapshot` |
| `pasteCount` | A | `monitored_sessions.pasteCount` | `update_session_counts` per ingest | analysis triggers, review, list | Preserved |
| `keystrokeDeltas` | C | — (derived metrics are durable in `risk_assessments.keystrokeMetrics`) | `applyEventToSession` | keystroke metrics, anomaly detection | Lost. Rebuilt only from new events; the durable metrics recorded at each analysis survive |
| `tabSwitchCount` | A | `monitored_sessions.tabSwitchCount` | `update_session_counts` | analysis triggers, review, list | Preserved |
| `fullscreenExitCount` | A | `monitored_sessions.fullscreenExitCount` | `update_session_counts` | analysis triggers, `fullscreenPenalty`, `behavioralContext`, incident summary | Preserved (see §5 for the history) |
| `copyAttemptCount` | A | `monitored_sessions.copyAttemptCount` | `update_session_counts` | analysis triggers, review, list | Preserved |
| `lastRiskPayload` | B | `risk_assessments` (latest by `generatedAt`) | `store_risk_assessment` | session detail, review, notifications | Reconstructed on read; the in-memory copy is empty until the next analysis |
| `eventCount` | A | `monitored_sessions.eventCount` | `update_session_counts`, from the hydrated lifetime total | list, review | Preserved. Hydrated from the durable document and incremented per accepted event |
| `status` | A | `monitored_sessions.status` | `set_session_status` | list, review, auto-lock decisions | Preserved |
| `lastAnalyzedCodeHash` | C | — | in memory only | skips re-analysis of an unchanged workspace | Lost. Costs at most one extra analysis after a restart, and cannot lose evidence |
| `recentEventFingerprints` | C | — | in memory only | suppresses replayed batches | Lost. A batch replayed after a restart is re-ingested; see §5 |
| `endedAt` | D | — (derivable from `status: "terminated"` and `updatedAt`) | terminate | nothing currently | Lost, and not needed: `status` is the durable signal |
| `lastActivityAt` | A | `monitored_sessions.updatedAt` | every accepted batch and lifecycle transition | TTL expiry | Preserved via `updatedAt`, which the persistence layer bumps on every write |

## 4. `ActiveSession` field by field

| Field | Class | Durable home | After restart |
| --- | --- | --- | --- |
| `sessionId`, `employeeId`, `matrixId`, `targetSystem` | A | `monitored_sessions` | Preserved |
| `status` | A | `monitored_sessions.status` | Preserved |
| `deployedAt` | A | `monitored_sessions.deployedAt` | Preserved |
| `riskIndex` | A | `monitored_sessions.peakRiskScore` | Preserved |
| `lastActivityAt` | A | `monitored_sessions.updatedAt` | Preserved |

## 5. Known gaps, and what each one costs

These are the reasons this phase exists. Each is stated with its actual
consequence rather than as a general warning.

### 5.1 `fullscreenExitCount` was never persisted — fixed

The counter was incremented in memory and read by four things (the analysis
trigger, the `fullscreenPenalty`, `behavioralContext.totalFullscreenExits` and the
incident summary) but was **absent from the `update_session_counts` payload**, so
MongoDB never learned it. After a restart the counter read 0, which meant a
fullscreen exit no longer forced an analysis and no longer contributed its
penalty. The per-assessment `behavioralContext` captured the value at the moments
analysis ran, so the evidence survived; the *session-level counter* did not.

Now written, read back, and exposed on both session-list paths.

### 5.2 `currentCode` is not in the session document — fixed on the read path

`update_session_terminal_content` exists as an MCP tool and **no route calls it**,
so `monitored_sessions.terminalContent` is always absent. The review route's
`session.terminalContent ?? memSession?.currentCode ?? ""` therefore resolved to
`""` after a restart, even though the latest risk assessment holds the identical
content in `codeSnapshot`.

The evidence was never lost; the review view was. The read path now falls back to
the newest assessment's `codeSnapshot`, which needs no new write and cannot
disagree with the assessment it came from.

### 5.3 The review route assumed a sort order the store does not provide — fixed

`getRiskAssessments()` in `packages/mcp-mongodb/src/mongo-client.ts` sorts
`{ generatedAt: -1 }` — **newest first**. The review route read
`reports[reports.length - 1]` as "the last report", which against MongoDB is the
**oldest** one. Two consequences, both wrong in production:

- `finalRiskScore` reported the first assessment ever recorded rather than the
  latest;
- the derived `flagged` status was decided from the oldest score.

The in-process test stub returned assessments in insertion order, so the suite
agreed with the route and disagreed with the database. The route now sorts the
assessments itself, by `generatedAt`, rather than depending on the store's
ordering — and the tests use a stub that orders the way MongoDB does.

### 5.4 A restart used to reset the durable counters — fixed

`update_session_counts` was applied with `$set`, so the durable totals were
whatever the API happened to hold in memory. A restarted process held counters
starting at zero, so its first write **replaced** the durable totals with the
post-restart ones: a session with 40 events and 20 pastes came back as 1 and 1.
The old comment claimed the write existed "so the console session list stays
accurate after a restart"; it did the opposite.

Two independent fixes, so neither the caller nor the database is a single point of
failure:

1. **Hydration.** Before any event is applied, a session entering `sessionStore`
   for the first time in this process is seeded from its durable document —
   counters and identity only. The event array, the reconstructed workspace and
   the risk payload are deliberately *not* copied: they are rebuilt on read from
   `micro_events` and `risk_assessments`, so copying them here would create a
   second, staler copy.
2. **`$max` at the storage layer.** Counters are applied with `$max`, never
   `$set`. None of them can legitimately decrease, so the storage layer refuses to
   let one regress even when the caller sends a lower value.

Verified across a real process restart against real MongoDB: five events before,
one after, and the durable `eventCount` reads **6**, with `tabSwitchCount` and
`fullscreenExitCount` intact. Before the fix the same sequence produced **1**.

`SessionState.eventCount` now means "events accepted for this session, including
before this process started" — it was previously declared, initialised to zero and
never read.

### 5.5 The dedup fingerprint ring does not survive a restart

`recentEventFingerprints` is a 128-entry `Set` in memory. A batch replayed after a
restart is re-ingested: counters inflate and the events are written a second time.
Within one process the ring works, which is why this was not visible.

### 5.6 The fingerprint ignores `eventId`

`computeEventFingerprint()` builds its key from the event type and a slim payload
view — **not** from `eventId`. Two genuinely distinct events with identical
payloads are therefore treated as one, and the second is dropped. For `KEYSTROKE`
that is wrong in principle: two keystrokes with the same inter-key delay are two
keystrokes, not a replay.

It also means the fingerprint is not an idempotency key and cannot become one
without including the client-supplied identifier — which raises the question of
how much that identifier can be trusted, since the monitored client supplies it.

Recorded, not changed here: this is the replay and idempotency workstream, and the
fix has to decide what a duplicate *is*, not only where the ring lives.

### 5.7 `lastAnalyzedCodeHash` does not survive a restart

Costs at most one redundant paid analysis per session after a restart. It cannot
lose or corrupt evidence, so it is recorded here rather than prioritised.

### 5.8 `WINDOW_BLUR` increments the fullscreen-exit counter

`applyEventToSession()` treats `WINDOW_BLUR` and `FULLSCREEN_EXIT` identically.
The counter therefore means "focus was lost", not "fullscreen was exited", which
is why `behavioralContext` reports it as `totalFullscreenExits` and the summary
says "fullscreen exit detected" for what may have been a window blur.

Recorded, not changed: the scoring and the console's wording both depend on the
current meaning, and renaming it is a contract change rather than a durability
fix. It belongs with the telemetry-contract work, not here.

## 6. What MongoDB owns today

Authoritative, and safe to treat as the source of truth:

| Collection | Owns |
| --- | --- |
| `monitored_sessions` | Identity, matrix association, target system, status, aggregate counters, `createdAt` / `updatedAt`, `deployedAt` |
| `micro_events` | The full telemetry record, one document per event |
| `risk_assessments` | Every risk payload, including `codeSnapshot`, `pasteSnippets`, `behavioralContext`, `keystrokeMetrics` and `recommendedActions` |
| `reference_documents` | The operator-managed similarity corpus |

Not authoritative, and never was: everything in §3 classified B, C or D.

## 7. Consistency rules this document implies

1. **A field classified A must never be read from memory when a durable value
   exists.** Memory may be newer only between the mutation and the write.
2. **A route must not depend on the store's ordering.** Sort explicitly at the
   point of use, so a change in a projection or an index cannot silently reverse
   a decision.
3. **Recovery reads evidence from where it was actually written.** The session
   document is not the only durable home; `risk_assessments` carries content the
   session document never had.
4. **A restart must not resurrect a terminal session.** Enforced today by
   `isMonitored()` and the expiry predicate on the recovery path.
5. **A restart must not make a session look more recent than it is.** `updatedAt`
   is the durable activity signal; nothing in memory may override it with a
   client-supplied value.
6. **A counter is monotonic.** Counters are hydrated before use and applied with
   `$max`, so neither a restart nor a caller's bookkeeping can lower a durable
   total.

## 8. What is still open

Tracked in [maturity-plan.md](maturity-plan.md) against the phase exit condition:

- replay handling that survives a restart (§5.5), and what a duplicate *is*
  (§5.6);
- a single central transition path, so status cannot diverge between
  `sessionStore`, `activeSessions` and MongoDB;
- partial-failure semantics for a session-changing operation whose persistence
  succeeds but whose cache update does not, and the reverse.

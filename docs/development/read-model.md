# The session read model

Four surfaces answer questions about one session, and they must not disagree about it.

| Surface | Route | What it is for |
| --- | --- | --- |
| **A** live list | `GET /api/v1/guardian/sessions` | Which sessions are being monitored right now. Excludes what is no longer live. |
| **B** live detail | `GET /api/v1/guardian/sessions/:id` | One session, for the dashboard's drill-in. |
| **C** review list | `GET /api/v1/sessions` | Every session that has ever existed, including expired and terminated ones. |
| **D** review detail | `GET /api/v1/sessions/:id` | One session's evidence: timeline, assessments, terminal content. |

This document states what each one owns, what they must agree on, and the two differences
that are deliberate. Written from the source, and asserted by
`apps/api/test/read-model-consistency.test.ts`.

## 1. Three vocabularies, deliberately not conflated

Conflating these is the root cause of every inconsistency this document exists to
prevent, so they are named apart.

| Vocabulary | Values | Where it lives | Written by |
| --- | --- | --- | --- |
| **Lifecycle status** | `active`, `locked`, `terminated` | `monitored_sessions.status` | The transition boundary, and nothing else |
| **Review disposition** | `flagged`, `investigating`, `none` | Nowhere — derived at read time | The review detail route |
| **Liveness** | `active`, `expired` | Nowhere — derived at read time | Every surface, from the activity instant and `SESSION_TTL_SECONDS` |

- **Lifecycle status** is the one durable lifecycle fact. `set_session_status` accepts
  these three values and nothing else, so a predicate that matched `flagged` would be
  asking the store to match a status it can never hold. See
  [state-transition-model.md](state-transition-model.md).
- **Review disposition** is what the evidence suggests: `flagged` when the latest
  assessment scored above the alert threshold, `investigating` when the session has a
  submission and no assessment above it, `none` otherwise. It is a property of the
  *evidence*, not of the *lifecycle*: a terminated session can be flagged.
- **Liveness** is whether the monitoring window is still open. Expiry stops monitoring;
  it never hides evidence, which is why A excludes an expired session and B, C and D still
  serve it with `liveness: "expired"`.

`flagged`, `investigating` and `cleared` are members of `PERSISTED_SESSION_STATUSES` only
so a **legacy** document holding one is mapped onto something known rather than
propagated. Nothing in this build writes them; `cleared` has never had a producer at all.

## 2. The shared reader

Every surface that answers from a durable session document reads it through
`apps/api/src/services/session-read-model.ts`:

```ts
readDurableSessionView(document, sessionId): DurableSessionView
```

One reader means one answer. Every field goes through a tolerant reader, so a document
holding a legacy field name — `fullscreenExitCount`, `auditId` — or an unusable value is
reported the same way wherever it is read, and the **larger** of two aliases wins so a
document holding both cannot lose the higher total.

`deployedAt` falls back to `createdAt` and then to the current instant. A document with
neither is malformed — `create_session` always writes one — and a plausible instant is a
smaller problem than a missing one on a display surface.

## 3. What must agree, and what each surface reports

| Field | A | B | C | D |
| --- | --- | --- | --- | --- |
| `status` (lifecycle) | yes | yes | yes | yes |
| `liveness` | yes | yes | yes | yes |
| `employeeId`, `auditId`, `matrixId` | yes | yes | yes | `employeeId`, `auditId` |
| `eventCount` | yes | yes | yes | yes |
| `pasteCount`, `tabSwitchCount`, `focusLossCount`, `copyAttemptCount` | yes | yes | yes | yes |
| `fullscreenExitCount` (deprecated alias) | yes | yes | yes | yes |
| `peakRiskScore` | yes | yes | yes | yes |
| `finalRiskScore` | — | — | — | yes (latest assessment) |
| `targetSystem`, `deployedAt` | yes | yes | `createdAt`/`startedAt` | `startedAt` |
| `disposition` | — | — | — | yes |
| `terminalContent`, `timeline`, `riskSummary` | — | — | — | yes |
| `source`, `ephemeralStateAvailable` | — | yes | — | — |
| `timelineTruncated` | — | — | — | yes |

**`finalRiskScore` is not `peakRiskScore`.** `finalRiskScore` is the *latest* assessment's
score, so it can be lower than the peak when a later analysis scored lower. `peakRiskScore`
is the durable monotonic maximum, maintained with `$max`, and it is what A, B and C report.
The suite asserts `finalRiskScore <= peakRiskScore` and that `finalRiskScore` equals the
last entry of `riskSummary`.

## 4. The two deliberate differences

1. **A excludes what is no longer live; B, C and D do not.** A is the live list: an
   expired or terminated session is not live, so it is not in it. The other three are the
   surfaces that keep evidence readable, and they report `liveness: "expired"` or
   `status: "terminated"` instead of hiding the session.
2. **D reports `disposition`; nothing else does.** It is the only surface with the timeline
   and the assessments in hand, so it is the only one that can tell a submission from a
   high score. C reports `alertTriggered`, which is a threshold crossing, not a disposition.

## 5. The staleness this model accepts

A, B and C report the lifecycle status this process holds in memory. D reads the durable
document. A status changed durably by **another** writer is therefore visible on D
immediately and on A, B and C once a transition reconciles the cache — which the
transition boundary does whenever it reads a durable status it disagrees with.

Reading the durable status on every live read would close the window sooner, at the cost
of a persistence call on the paths a monitoring console polls continuously. The trade is
deliberate, and the review surface is the answer for a caller that needs the durable truth
at this instant. See [operability-model.md](operability-model.md) §9.1.

## 6. What tracing the four surfaces found

Every one of these was observable, and every one is now fixed and asserted.

| Finding | How it showed up |
| --- | --- |
| **D reported `flagged` under `status`** while C reported `active` for the same session. The console's review panel treated `flagged` as `locked`, so a session scoring 52 was displayed as **LOCKED** while the dashboard displayed it as active. | Comparing D and C for one session; reading `ReviewRecord.isLocked` |
| **B's registry branch reported zero for every counter**, so a session deployed before a restart reported `eventCount: 0` there while A reported the durable total. | A restart followed by a detail read |
| **D reported no counters at all**, so the console re-derived them by counting `timeline` — which is capped, so a session with more than 500 events was under-reported on the review panel. | Reading `fetchAuditRecord`; a session with more than the window's worth of events |
| **The durable `peakRiskScore` lagged by one batch.** The counters write ran *before* the analysis, so the peak it wrote was the previous batch's — and for a session whose last batch produced the highest score, the durable peak never recorded that score at all. | Comparing `peakRiskScore` across A/B/C/D after one batch |
| **A durable detail answer reported `liveness: "active"`** for a session whose durable window had closed, because it derived liveness from the empty in-memory maps. | An expired session read after a restart |
| **D reported an empty `auditId`** for a document that holds only `matrixId`, while B reported the matrix id. | A seeded document with `matrixId` and no `auditId` |

## 7. Related documents

- [operability-model.md](operability-model.md) — every request path mapped against nine
  operability columns, including what each read path does when its dependency fails.
- [session-state-model.md](session-state-model.md) — every piece of session state, its
  class (durable authority, reconstructable cache, ephemeral, derived), and what a restart
  does to it.
- [state-transition-model.md](state-transition-model.md) — the enforced transition table
  and the cache-reconciliation rule that closes the staleness window in §5.
- [../api-errors.md](../api-errors.md) — the stable codes, and the note that a read can
  now return `SESSION_STORE_UNAVAILABLE`.

# The multi-writer state model

What happens to every piece of session state when **two API processes serve the same
session at the same time**.

## 1. Why this is a different question from the restart question

[session-state-model.md](session-state-model.md) asks *what survives a restart*. That
question has one author: the process that went away is gone, and nothing is racing it.

This document asks a harder one. Two processes are both live, both hold a cache, and both
can write:

> If process A and process B handle requests for the same session at the same time, does
> Cerberus still tell the truth?

A restart is a gap in *time*. A second replica is a gap in *space*, and it does not close
by itself. Every field that was safe to cache because "the only writer is me" is a
different field when it is not.

The architecture deliberately stays Mongo-backed. The answer to a multi-writer problem is
a **durable predicate**, not a distributed lock: compare-and-set on a single document is
atomic in MongoDB without a transaction, so it works on the documented single-node
deployment. Nothing here needs Redis, Kafka, or a replica set.

## 2. Five classes

Every concept is exactly one of these. The names are chosen so that the *class* answers
the multi-writer question before the field-by-field table does.

| Class | Meaning | Multi-writer consequence |
| --- | --- | --- |
| **Durable authoritative** | MongoDB is the truth. A process's copy is a cache of it. | A read that serves the cache without reconciling can contradict the truth. This is the class the invariant in §3 is about. |
| **Reconstructed** | Not stored directly, but derivable from something durable. | Safe to serve from any process, because any process derives it from the same durable source. Costs work, not correctness. |
| **Derived** | Computed at read time from other fields; never stored. | Always correct **if its inputs are**, which is why the inputs matter more than the derived value. |
| **Ephemeral** | In one process's memory only, on purpose. | Divergence is expected and must be **stated** to the client rather than hidden. |
| **Process-local authority** | In one process's memory, and the process *behaves as if it were the truth*. | **An anti-pattern.** Every instance of it is either a defect to fix or a documented limitation. §5 lists which are which. |

The distinction that matters most is the last one. A cache is not a defect; a cache that
is *consulted instead of* the durable value is.

## 3. The invariant

> **A live read must not report a durable-authoritative field with a value the durable
> document contradicts.**

Stated as three rules:

1. **Durable wins on read.** Where a durable value exists, it is what is reported for a
   durable-authoritative field. A process's cache may be *newer* only in the interval
   between a mutation and its write, and never *older*.
2. **Ephemeral is labelled, not implied.** A field this process alone can answer is
   reported with `ephemeralStateAvailable: false` (or omitted) when the process does not
   hold it, rather than as a zero-valued fact. A `0` and an absent value are different
   statements.
3. **A stale process cannot write older truth back.** Every write path either applies a
   monotonic operator (`$max`, `$inc`), is predicate-checked against the value it read
   (compare-and-set), or is append-only with a unique identity.

Rule 3 is what makes rules 1 and 2 hold over time rather than only at the instant of a
read: reconciling a read fixes the *reporter*, and only a guarded write fixes the
*writer*.

## 4. Field by field

The six questions from the charter, answered for every concept. "Reconciles" names what
turns a stale copy into a current one; "max divergence" is how long a client can see the
stale answer. §6 is the enforcement table, and it is the one to trust about what holds
**today**; the "B returns before reconciliation" column describes the failure mode each
reconciliation exists to remove.

| Concept | Class | A can write while B is stale? | B returns before reconciliation | Reconciles | Divergence acceptable? | Max divergence | Stale write-back possible? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Lifecycle status** (`active`/`locked`/`terminated`) | Durable authoritative | Yes | B's cached status — **including `active` for a durably `terminated` session** | The batched durable query on every live-list request, and the document read on every live-detail request; also a transition (the boundary reconciles from its durable read) and a restart | **No** — it is a false statement about whether monitoring continues | **Zero on both live surfaces** | **No** — `set_session_status` is predicated on the observed status, so a stale transition reports `SESSION_CONFLICT` |
| **Lock state** | Durable authoritative | Yes | As lifecycle status: it *is* `status === "locked"` | As lifecycle status | No | As lifecycle status | No — same predicate |
| **Liveness** (`active`/`expired`) | Derived | N/A — never stored | A value derived from B's own activity view, which is memory-based when B has the session in `sessionStore` | Nothing caches it; recomputed per read, from the **more recent** of the local and durable activity instants, so neither side can move the window | Yes at the TTL boundary, no when it contradicts a durable `updatedAt` | Zero on both live surfaces | N/A |
| **`eventCount`** | Durable authoritative | Yes | B's hydrated total plus what B has itself seen — **can be lower than durable** | `$max` at the store; the merge on both live surfaces; hydration on the first ingest of the session in B | Yes — bounded, and it can only be behind, never wrong-high | One request on both live surfaces; until B hydrates on the ingest path | **No** — `$max` refuses a lower total |
| **`pasteCount`, `tabSwitchCount`, `focusLossCount`, `copyAttemptCount`** | Durable authoritative | Yes | As `eventCount` | As `eventCount` | Yes, as `eventCount` | As `eventCount` | No — `$max` |
| **`peakRiskScore`** | Durable authoritative | Yes | On the memory paths, B's own latest payload score — **`0` for a session another process scored** | `$max` at the store; both live surfaces take `max(local, durable)` | **No** — "this session was never risky" is a false negative | One request on both live surfaces | **No** — `$max` |
| **`last activity`** (`updatedAt`) | Durable authoritative | Yes | B's own `lastActivityAt` when B ingested more recently, otherwise the durable `updatedAt` | Any durable read | Yes — both are server clocks and the TTL predicate takes the more recent | One batch interval, or B's process lifetime | No — a stale process does not write `updatedAt` unless it writes something else |
| **`currentCode`** | Ephemeral | N/A — one reconstruction per process | B's own reconstruction, or `""` if B never ingested | Never; `terminalContent` is the durable owner | **Yes, explicitly** — the response marks `ephemeralStateAvailable` | B's process lifetime | **Yes — see §5.3** |
| **`lastRiskPayload`** | Reconstructed | Yes (A stores a new assessment) | B's own latest in-memory payload, or `null` | The review surface reconstructs from `risk_assessments`; the live detail does not | Yes for the live detail (labelled ephemeral); no for review, which reads durable | B's process lifetime | No — assessments are append-only under a unique identity |
| **`terminalContent`** | Durable authoritative | **Yes** — the write has no predicate | The durable value on the review surface | Never | **No** — it is one fact: "the workspace as monitoring ended" | Permanent (last writer wins) | **Yes — see §5.3** |
| **Review disposition** (`flagged`/`investigating`/`none`) | Derived | N/A — never stored | Derived from durable assessments | Recomputed on every read | No | None | N/A |
| **Identity binding** (operator handle) | Ephemeral | N/A — no durable home | A handle minted by A is **unknown to B** | Never | **Yes** — documented as a per-process display handle, not a credential | The process lifetime of whichever replica minted it | N/A |
| **Rate-limit bucket** | Ephemeral | N/A — no shared state | B's own bucket decision | Never | **Yes** — N replicas enforce up to N× the configured limit | The process lifetime | N/A |
| **Request id** | Ephemeral | N/A | Its own per-request id | Never | Yes — it is observability only, never an identity or a dedup key | One request | N/A |
| **Notification delivery state** | Ephemeral | N/A — nothing durable records it | N/A | Never | **Yes** — documented best-effort | N/A | N/A |
| **Idempotency state** | **Absent** | N/A | N/A | N/A | N/A | N/A | N/A — see §5.4 |
| **`sessionStore.events`** (the live window) | Ephemeral | N/A | B's own window | Never; `micro_events` is the durable record | Yes — the review timeline is the durable view | B's process lifetime | No — the window is never written back |
| **`recentEventFingerprints`** | Ephemeral cache | N/A | B's own ring | Never | Yes — the durable `(sessionId, eventId)` identity is the guarantee | B's process lifetime | N/A |
| **`lastAnalyzedCodeHash`** | Ephemeral cache | N/A | B's own hash | Never | Yes — costs at most one redundant paid analysis | B's process lifetime | N/A |

## 5. The four things this table says are wrong

The table is the map; these are the findings.

### 5.1 A live read did not reconcile lifecycle status — the main gap

`GET /api/v1/guardian/sessions` built its answer from `sessionStore` and `activeSessions`
and consulted MongoDB **only when local memory was empty**. `GET /api/v1/guardian/sessions/:sessionId`
returns from `sessionStore` whenever it has the session, without reading the document at
all.

Two consequences, both false statements:

- **A session another process terminated was still reported live.** It stayed in B's
  `sessionStore` with its old status, and it stayed in B's live list until the TTL elapsed,
  a transition happened to run through the boundary in B, or B restarted. The review
  surfaces read durable and said `terminated`; the live surfaces said `active`. Two
  surfaces, one session, two answers — the class of disagreement
  [read-model.md](read-model.md) was written to remove, surviving in the dimension that
  document did not consider.
- **A session another process deployed or ingested was missing entirely.** B's
  `activeSessions` holds only what B deployed, so the live list omitted A's sessions. That
  is worse than a stale value: the session was not misreported, it was absent.

**Both live surfaces are fixed.**

The list issues **one batched durable query per request** — always, not only when memory is
empty — and merges durable over local, so a durably-terminated session is dropped in the same
request that would have reported it, and another process's sessions appear. The detail reads
the session document on **every** request, including when it holds the session, and merges the
same way.

The merge is `services/session-reconciliation.ts`: a pure function, unit-tested over the states
that are awkward to produce through HTTP, with the routes as thin adapters. The repair it
returns is applied through `SessionTransitionCache.reconcileStatus`, which changes the cached
status and deliberately **not** the cached activity instant — a read must not extend a
monitoring window as a side effect of looking at it.

The cost is one bounded read per detail request and one per list request, on paths that
previously paid none. That is the price of the answer being true, and it is the same read the
restart-recovery path already made. The durable-recovery path always did the right thing; it
was simply unreachable whenever B held any local state.

### 5.2 `peakRiskScore` was reported as `0` on the memory paths

The list and detail memory paths computed the risk from `session.lastRiskPayload` — this
process's most recent payload. A session that B had ingested but never analysed reported
`0` even when its durable `peakRiskScore` was 90. The durable value is maintained with `$max`
and is exactly the answer to "how risky did this session get".

**Both live surfaces are fixed**: the merge takes `max(local, durable)` for the peak score, so
a score this process never saw is reported and a payload this process holds but has not yet
persisted is not discarded.

### 5.3 `terminalContent` has no ownership rule

`POST /sessions/:sessionId/terminate` preserves the workspace **before** the status
transition, and `update_session_terminal_content` is an unconditional `$set`. So two
processes terminating the same session both write, and the last writer wins — with
whichever process happened to hold the staler `currentCode`. The field's own definition
("the workspace as monitoring ended") makes it a single fact with no single owner.

The rule this needs is **first successful terminal transition owns `terminalContent`**: the
transition that actually moves the document to `terminated` is the one whose workspace is
preserved, and a process that lost that race must not overwrite it.

### 5.4 There is no durable idempotency state

`POST /api/v1/scenarios` and `POST /api/v1/auditor/query` spend money per call and have no
durable record of a request. A caller whose response is lost retries, and the retry
executes the provider call again. Two processes racing the same request both execute it.

Nothing here claims exactly-once billing. The honest statement today is: **at-least-once
execution, with no deduplication across a lost response.**

## 6. Enforcement status

Which rules from §3 hold today, and where.

| Rule | Enforced by | Status |
| --- | --- | --- |
| Durable wins for **status** on a transition | `services/session-transition.ts` — reads durable, validates, writes with a predicate, repairs caches from the outcome | **Enforced** |
| Durable wins for **status** on the live **list** | `services/session-reconciliation.ts`, wired into `GET /sessions`; one batched durable query per request | **Enforced** |
| Durable wins for **status** on the live **detail** | the same module, wired into `GET /sessions/:sessionId`; the document is read on every request | **Enforced** |
| Durable wins for **counters** | `buildSessionCountsUpdate` applies `$max`; hydration seeds before the first event | **Enforced** on any path that hydrates |
| Durable wins for **counters** on both live surfaces | the merge takes `max(local, durable)` | **Enforced** |
| A stale process cannot lower a counter | `$max` at the store | **Enforced** |
| A stale process cannot regress a status | `expectedStatuses` compare-and-set | **Enforced** |
| A stale process cannot overwrite `terminalContent` | — | **Not enforced** (§5.3) |
| A read repairs the cache only **toward** the document | `SessionTransitionCache.reconcileStatus` — status only, never the activity instant, never seeding | **Enforced** |
| A read never extends a monitoring window | `reconcileStatus` takes `at: null`, so the cached activity instant is untouched | **Enforced** |
| Duplicate events count once | `micro_events` unique `(sessionId, eventId)` + `$setOnInsert` + the accepted-set report | **Enforced** |
| Derived values are never persisted | `ReviewDisposition` and `SessionLiveness` are computed at read time | **Enforced** |
| Ephemeral state is labelled | `source` and `ephemeralStateAvailable` on detail; `statusSource` and `ephemeralStateAvailable` on every list row | **Enforced** on both live surfaces |
| A live read that cannot reconcile says so | `reconciled: false` on the list body and on the detail session, with every row `statusSource: "process-local"` | **Enforced** |

## 7. What this document does not claim

- **It is not an authorization model.** One shared operator key still grants equivalent
  authority to every replica. Reconciling reads improves *correctness*; it changes nothing
  about *who may do what*.
- **It is not per-user attribution.** Replicas do not create identity. There is still no
  user account, role, tenant, or audit trail that distinguishes operators.
- **It is not distributed infrastructure.** No lock service, no message bus, no cache
  cluster. Where the Mongo-backed design provably cannot satisfy the invariant, that is
  recorded as a limitation rather than solved by adding a system.
- **It is not a compliance claim.** The session model is an engineering property, not a
  control.

See [live-read-consistency.md](live-read-consistency.md) for the freshness contract each
read surface owes, and [../security/threat-model.md](../security/threat-model.md) for the
trust boundaries the single-key model does and does not draw.

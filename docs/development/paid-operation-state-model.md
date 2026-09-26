# The paid-operation state model

What happens to a paid request at every step, what state it leaves behind, and what a
retry of it means — traced from the source at `b2c0e00` and then specified as the
target state.

This is the state model for the two routes that spend money. It exists because the
question the `v0.6.0` cycle turns on has no answer in prose:

> What exactly happens when a caller retries a paid operation after an ambiguous
> response, especially when two API processes receive the same request at nearly the
> same time?

[idempotency-model.md](idempotency-model.md) answered it as a **decision**: the risk was
measured, the mechanism was designed, and nothing was built. This document answers it as
a **state machine**: every step, every durable field, every failure path, and the exact
window in which the answer is "unknown".

## 1. How to read this document

Two layers, kept apart on purpose:

- **§2 is the current state**, traced from the source and correct as of `b2c0e00`. It
  records what the code does, including one thing the earlier document got wrong.
- **§3 onward is the target state**, which is what the `v0.6.0` cycle implements. Each
  section carries a **status marker** so the document cannot describe the target as
  though it were already shipped.

| Marker | Meaning |
| --- | --- |
| **Implemented** | In `main`, with a test that fails if it stops being true. |
| **Partly** | Part of it is in `main` and tested; the rest is specified here. §13 names which part. |
| **Design** | Specified here, not in `main`. Do not describe it as behaviour. |

The status of the whole mechanism is in §13, which is the only place a reader should
take "is this done?" from.

## 2. The current state, traced from the source

### 2.1 `POST /api/v1/scenarios`

`apps/api/src/routes/scenarios.ts`, `createScenariosRouter`. One accepted request runs:

| # | Step | Paid? | Durable effect |
| --- | --- | --- | --- |
| 1 | `c.req.json()` and shape validation | no | none |
| 2 | Field caps: `prompt` ≤ 8 000, `roleContext` ≤ 200, `vectorCount` 1..25 | no | none |
| 3 | `normalizeSeverityMix(body.severityMix)` | no | none |
| 4 | `runPreFilter(trimmedPrompt)` — regex only, `422` on reject | no | none |
| 5 | `provider.classifyScenarioRequest(...)` — **paid call 1** | **yes** | none |
| 6 | `evaluateVerdict(verdict)` — `422` on reject, `503` fail-closed on throw | no | none |
| 7 | `provider.authorThreatScenarioMatrix(...)` — **paid call 2** | **yes** | none |
| 8 | `matrix.metadata.promptFingerprint = sha256(body.prompt)` | no | none |
| 9 | `callMcpTool(STORE_THREAT_SCENARIO, …)` | no | one `threat_scenarios` document |
| 10 | `201` with `matrix`, `mcpCorrelationId`, `persisted`, `generationRequestId`, `pipeline` | no | none |

Three properties of this path matter to idempotency and none is obvious:

- **The paid calls are steps 5 and 7, and nothing durable is written between them or
  after them by the route.** A claim record has to be written before step 5, because
  step 5 is the first place money is spent.
- **Step 9 is best-effort.** `persisted.ok === false` is logged and the matrix is still
  returned with `201`. So a `201` does not imply the matrix is retrievable, and a
  completed replay cannot reconstruct the matrix from `threat_scenarios` — the response
  body is the only copy the caller ever gets.
- **Step 5 has a durable side effect that is not the route's**: the classifier verdict is
  discarded. It is not persisted anywhere, so a retry re-runs it. §3.5 defines what that
  costs.

### 2.2 `POST /api/v1/auditor/query`

`apps/api/src/routes/auditor.ts`, `createAuditorRouter`. One accepted request runs:

| # | Step | Paid? | Durable effect |
| --- | --- | --- | --- |
| 1 | `c.req.json()` and `typeof body.question === "string"` | no | none |
| 2 | `question` ≤ 2 000 characters | no | none |
| 3 | `provider.toMongoPipeline(question)` — **paid call 1** | **yes** | none |
| 4 | `callMcpTool(LIST_SESSIONS, {})` | no | none (a read) |
| 5 | `applySafePipeline(records, pipeline)` — `$match`/`$sort`/`$limit` only | no | none |
| 6 | `matched.slice(0, MAX_AUDITOR_RESULTS)` — 200 | no | none |
| 7 | `provider.summarizeSessionRecords(question, records)` — **paid call 2** | **yes** | none |
| 8 | `200` with `summary` and `raw` | no | none |

Two properties matter:

- **A durable read sits between the two paid calls.** Step 4 is an MCP round trip, so the
  window between the two spends is not merely a scheduling gap — it is a network
  dependency. §3.11 defines the window that opens if the store fails there.
- **The result is persisted nowhere.** The summary is model text and the raw records are
  a projection of `monitored_sessions`. There is no durable artifact to point a
  `resultRef` at, so a completed replay has to carry the response body itself. §3.7
  bounds it.

### 2.3 The revalidation finding: the auditor spends twice, not once

**`idempotency-model.md` §2 records `POST /api/v1/auditor/query` as one paid call per
accepted request. That is wrong.** The route makes two, at steps 3 and 7 above:

```ts
const pipeline = await provider.toMongoPipeline(body.question);        // paid call 1
const matched = applySafePipeline(await listSessions(requestId), pipeline);
const records = matched.slice(0, MAX_AUDITOR_RESULTS);
const summary = await provider.summarizeSessionRecords(body.question, records); // paid call 2
```

`toMongoPipeline` calls `completeJson` (`apps/api/src/ai/provider.ts:347`) and
`summarizeSessionRecords` calls `completeText` (`:369`), and both reach
`client.chat.completions.create`. The route's own module comment and the
`MAX_QUESTION_CHARS` docstring both already say "sent to a paid provider twice"; only the
idempotency document's table disagreed with the code.

So the corrected exposure is:

| Route | Paid logical calls per accepted request | Source |
| --- | --- | --- |
| `POST /api/v1/scenarios` | **2** — semantic classifier, then matrix authoring | `routes/scenarios.ts` steps 5 and 7 |
| `POST /api/v1/auditor/query` | **2** — pipeline construction, then summarisation | `routes/auditor.ts` steps 3 and 7 |

This does not change the shape of the mechanism — one route-level operation record
covers one caller request either way — but it changes the cost of being wrong, and it is
recorded here rather than silently patched so the correction is auditable.
[maturity-plan.md](maturity-plan.md) and [idempotency-model.md](idempotency-model.md) are
corrected in the same pull request.

### 2.4 One logical call is up to four billable HTTP requests

`OpenAIProvider.complete` (`provider.ts:122`) retries internally:

```ts
const MAX_ATTEMPTS = 3;                      // provider.ts:35
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) { … }
```

and inside that loop, a JSON-mode call whose response is empty retries **once more**
without the `response_format` constraint (`:178`–`:196`). A fatal error (`isFatal`, from
the SDK's status and code rather than a substring match) short-circuits the loop.

So the billable HTTP requests behind one accepted caller request are:

| Route | Logical calls | Worst case HTTP requests |
| --- | --- | --- |
| `POST /api/v1/scenarios` | 2 | 2 × 4 = **8** |
| `POST /api/v1/auditor/query` | 2 | 2 × 4 = **8** |

This is why the mechanism is specified at **logical-call** granularity and why no claim
about billing is made at HTTP-request granularity. An idempotency key stops a *retry*
from starting a second operation; it does not, and cannot, stop the provider client's own
retry ladder inside one operation. See §11.

### 2.5 What the current code has for a retry, and what it lacks

| Thing a retry needs | Present at `b2c0e00` |
| --- | --- |
| A request identifier | Yes — `currentRequestId()`, from `X-Request-Id` or generated; echoed as `X-Request-Id` and `X-Correlation-Id` |
| A stable client-supplied operation identity | **No.** `X-Generation-Request-Id` exists but is a *cancel handle*, not an idempotency key: it is not validated, not durable, and not compared |
| A durable record of an operation | **No.** `grep -i idempot apps/api/src` returns nothing |
| A store API to claim or replay | **No.** `MongoStore` has no claim/complete/fail method and `MCP_TOOL_NAMES` has no matching tool |
| Route-level retry | **No.** A retry is a new request that re-enters at step 1 and spends again |

### 2.6 The failure that matters

Response loss, not a hostile caller. Three ordinary ways it happens: a dropped
connection, a client timeout shorter than the provider's latency (the provider timeout is
180 s by default), and an operator pressing the button again because nothing appeared.
The third is the most likely in practice, and the console offers no signal other than the
response.

## 3. The target state model

One collection, `operation_claims`, one document per claim. The protocol is deliberately
small, and entirely Mongo-backed: **a unique index is the whole of the mutual
exclusion**, so it works on the documented single-node deployment without a transaction,
without Redis, and without a lock service.

### 3.1 Request validation — *Implemented*

Both routes keep their existing validation exactly, in the existing order. The claim is
made **after** every validation that does not spend money, so a malformed, oversized or
pre-filtered request never creates a record:

| Route | Validation before any claim | First paid step |
| --- | --- | --- |
| `/scenarios` | JSON parse, object shape, `prompt` present/non-empty, `roleContext` string, both length caps, `vectorCount` integer 1..25, `severityMix` normalisation, deterministic pre-filter | classifier |
| `/auditor/query` | JSON parse, `question` non-empty string, 2 000-character cap | pipeline construction |

**Consequence, stated because it is a real asymmetry:** a request refused by the
pre-filter or by a length cap creates no record, so the same key may later be used for a
different body that passes. That is correct — no operation was claimed, so nothing is
being reused — and it is why the conflict check is scoped to records that exist rather
than to keys the server has ever seen.

### 3.2 Idempotency-key validation — *Implemented*

Header name: **`Idempotency-Key`**. Optional.

| Rule | Value | Why |
| --- | --- | --- |
| Presence | Optional | Additive. A caller that sends no key gets exactly today's behaviour |
| Length | 1..255 characters | A caller-controlled string on a paid path; the ceiling is a storage bound |
| Charset | `\x21`–`\x7E` (printable ASCII, no space) | Excludes every control character, every non-ASCII ambiguity, and the whitespace that would make `"a b"` and `"a  b"` indistinguishable after any trimming |
| Raw storage | **Never.** `sha256(key)` is stored as `keyHash` | The record is a document an operator can dump; a caller's key is not evidence, and a key that is not stored cannot leak from a backup |
| Error on invalid | `400 INVALID_IDEMPOTENCY_KEY`, and **no record is created** | A rejected key must not consume a claim |

A key is **not** synthesised from the request body when the header is absent. The server
cannot know that two requests are the same request — that is precisely what the caller
knows and the server does not — so a synthesised key would silently claim a guarantee
that does not exist. See §5.

**Implemented.** `apps/api/src/services/idempotency-key.ts` implements this contract in full
— the range, the length bound, the digest, the log-safe truncated identifier, and a rejection
that carries no key material and never echoes the value — with its own suite, and **both**
paid routes read the header and answer `400 INVALID_IDEMPOTENCY_KEY` before anything is
claimed. An invalid key creates no record on either route.

### 3.3 Request fingerprint — *Implemented*

A versioned, canonical digest of the semantically relevant fields, so that a key reused
for a different request is detectable.

| Route | Fingerprint input |
| --- | --- |
| `/scenarios` | `{ prompt: trimmedPrompt, roleContext, vectorCount, severityMix }` |
| `/auditor/query` | `{ question }` |

Rules:

- **Only semantically relevant fields.** `X-Request-Id`, `X-Generation-Request-Id`, the
  `Idempotency-Key` itself, headers, and the arrival time are all excluded.
- **The values the operation actually uses**, after the route's own normalisation.
  `prompt` is the trimmed string the route passes to the provider, and `severityMix` is
  the normalised object. Two requests that produce the same provider input therefore
  produce the same fingerprint, and two that produce different input cannot collide.
- **Stable object-key ordering**, by UTF-16 code unit. Not `localeCompare`: a
  locale-sensitive comparison makes the fingerprint depend on the process's locale,
  which would make the same request fingerprint differently on two replicas.
- **Arrays are order-sensitive.** By construction, because the canonical form is the
  array's own order. The two payloads here carry no semantically-unordered array, and a
  future one would have to be sorted explicitly and deliberately.
- **No Unicode normalisation.** NFC and NFD spellings of the same text produce different
  fingerprints, because they are different byte sequences and therefore different
  provider inputs. Normalising would make two genuinely different requests collide,
  which is the one error the fingerprint exists to prevent.
- **`sha256` over the canonical UTF-8 bytes**, from `node:crypto`.
- **Versioned.** `fingerprintVersion: 1` is stored beside the digest, so a future
  serialisation change is a new version rather than a silent reinterpretation of
  existing records.
- **Not authentication.** The fingerprint proves two requests are the same request. It
  grants nothing.

### 3.4 Operation claim — *Implemented*

The claim is a **single-document atomic insert**, and the unique index is the mutual
exclusion:

```
insertOne({ routeFamily, keyHash, fingerprint, fingerprintVersion,
            status: "pending", claimId, createdAt, updatedAt,
            leaseExpiresAt, expiresAt })
   ├─ succeeds ─▶ this process owns the operation
   └─ E11000  ─▶ another claim exists; read it and decide (§3.6–§3.9)
```

`claimId` is a fresh UUID minted by the claiming process. It is the **ownership token**:
`complete` and `fail` are conditional on it, so a process whose lease expired cannot
overwrite a record that a reclaimer now owns.

Why not a process-local mutex: it is not a correctness mechanism across processes. Two
API processes share no memory, and the documented deployment already runs more than one
replica. The database is the only thing both can see.

Why the unique index and not a transaction: the documented deployment is a single-node
MongoDB, where a single-document write is atomic. `insertOne` racing on a unique index is
atomic without a transaction, so the mechanism works on the deployment the repository
documents rather than requiring a replica set.

### 3.5 Provider call(s) — *Implemented*

**One route-level operation record covers one caller request**, and a completed replay
re-runs **neither** paid call.

`/scenarios` is two paid calls inside one operation. If the classifier succeeds and
authoring fails, the operation fails as a whole, and the classifier's spend is **not**
recoverable: the verdict is not persisted, so resuming would require storing it, and the
charter's rule is to resume only where that is simple. It is not simple here — the
verdict would become a third durable shape to migrate, bound and reason about — so the
explicit choice is **re-execution**: a reclaim after a failure runs both stages again,
and that cost is stated rather than implied.

`/auditor/query` is likewise two paid calls, with a durable **read** between them. A
failure after the pipeline was built and before the summary exists also re-executes both.

| Route | On completion | On failure, on reclaim |
| --- | --- | --- |
| `/scenarios` | both calls ran once, result recorded | both calls run again |
| `/auditor/query` | both calls ran once, result recorded | both calls run again |

**A durable read that fails must fail the operation, not be substituted.** The auditor reads
the session list between its two paid calls, and that read used to degrade silently: a failed
`list_sessions` became an empty array — the same value a store that answered "no sessions
matched" returns — and the route summarised nothing and answered `200`. That was untruthful on
its own. It became a **correctness** defect the moment the response started being recorded for
replay: a `200` recorded as `completed` would replay the fabricated answer for the whole
retention window, and a caller would have no way to tell it apart from a real one.

So the read now reports whether it answered, and a failure is a `503 AUDITOR_STORE_UNAVAILABLE`
recorded as a retryable failure — nothing claimed as an answer, nothing to replay, and a
same-key retry that re-executes. The general rule this is an instance of: **a response is only
worth remembering if it is true.**

### 3.6 Same key + same request, completed — *Implemented*

Return the recorded result. No provider call.

| Aspect | Behaviour |
| --- | --- |
| Status code and body | The **recorded** ones — `201` and the matrix, or `200` and the summary. A replay is the same answer, not a new one |
| Correlation identity | **Regenerated.** `correlationId` is stripped before the body is stored and the current request's value is injected on replay. A replayed response must not present the original request's identity as current |
| Operation identity | **Preserved.** `mcpCorrelationId`, `generationRequestId` and `pipeline.startedAt` describe the *original operation* and are part of the business result; replaying them is the point |
| Signal header | `Idempotency-Replayed: true` |
| Provider calls | zero |

### 3.7 Result persistence and replay bounds — *Implemented*

The completed record stores the response it will replay:

```
result: { status: number, body: object }
```

- **`correlationId` is removed before storage** and re-injected on replay, per §3.6.
- **Bounded.** A serialised result above `MAX_STORED_RESULT_BYTES` (4 MiB) is not stored;
  the record is marked completed with `resultOmitted: "too-large"`, and a replay answers
  `503 IDEMPOTENCY_STATE_UNAVAILABLE` saying the prior result was too large to retain.
  This branch is **defensive and unreachable at the documented bounds**: the auditor's
  `raw` array is capped at 200 records and the summary at 1 200 output tokens, and a test
  asserts a maximal payload serialises far below the ceiling. Storing an unbounded model
  response in a record whose whole purpose is bounded retention would be the one way this
  collection could grow without limit.
- **No `resultRef` shortcut exists for either route.** The scenarios matrix is persisted
  best-effort and may not be there, and the auditor persists nothing. Pointing a replay
  at durable storage would therefore be a replay that sometimes answers "gone".

### 3.8 Operation completion record — *Implemented*

Completion and failure are both conditional writes on `claimId`:

```
complete:  updateOne({ routeFamily, keyHash, claimId, status: "pending" },
                     { $set: { status: "completed", result, updatedAt, resultOmitted? } })
fail:      updateOne({ routeFamily, keyHash, claimId, status: "pending" },
                     { $set: { status: "failed", errorCategory, retryable, result?, updatedAt } })
```

`matchedCount === 0` means the claim is no longer ours — the lease expired and another
process reclaimed it, or it was already terminal. That is reported as
`recorded: false`, logged as `idempotency.completion-lost`, and the caller still receives
the result the work produced. **A lost completion is not hidden**, because it is exactly
the state in which a second execution exists.

### 3.9 Same key + different request — *Implemented*

Deterministic `409 IDEMPOTENCY_CONFLICT`, and **no provider call**.

```
{ success: false, code: "IDEMPOTENCY_CONFLICT",
  error: "This Idempotency-Key was used for a different request. Use a new key.",
  correlationId: <current> }
```

- The response reveals **nothing** about the stored request: no field name, no digest, no
  difference. An idempotency record is not an oracle for what another caller sent.
- The log line carries `requestId`, `routeFamily`, `conflict: true` and the truncated
  key digest. Never the raw key, never either body.
- The check is fingerprint-first: a reclaim predicate always includes the fingerprint, so
  a stale-pending or retryable-failed record belonging to a *different* request is never
  reclaimed by this one.

### 3.10 Pending lease and stale reclaim — *Implemented*

A `pending` record carries `leaseExpiresAt`. The lease is **derived from the provider
timeout**, not configured independently:

```
lease = clamp(2 × OPENAI_REQUEST_TIMEOUT_MS + 30 s, 60 s, 30 min)
```

Deriving it is a correctness decision, not a convenience. An independently configured
lease could be set shorter than a provider call — an operator raising
`OPENAI_REQUEST_TIMEOUT_MS` to ten minutes is the realistic case — and the lease would
then expire while the first process was still waiting, so a second process would reclaim
and spend again **on a healthy operation**. Tying the lease to the timeout makes that
state unrepresentable. A floor of 60 s covers the MCP round trips inside the operation.

A second caller's decisions, in order:

| Record state | Fingerprint | Action |
| --- | --- | --- |
| `pending`, lease fresh | same | `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After`; **no provider call** |
| `pending`, lease expired | same | **atomic reclaim** — one winner, which executes |
| `failed`, `retryable: true` | same | **atomic reclaim** — one winner, which executes |
| `failed`, `retryable: false` | same | replay the recorded failure |
| `completed` | same | replay the recorded result |
| any | different | `409 IDEMPOTENCY_CONFLICT` |

Reclaim is a single `findOneAndUpdate` whose **filter is the predicate** — status, expiry
and fingerprint — and whose update mints a new `claimId` and a new lease. Two processes
reclaiming together both run it; MongoDB applies one, and the loser's predicate no longer
matches, so it falls through to the read path and sees a fresh `pending`. Exactly one
reclaimer executes. There is no lock and no leader election.

The lease is evaluated against the **claiming process's clock** (the `$expr`/`$$NOW`
comparison is server-side where the driver supports it, and the filter value is the
process's `Date` otherwise), so a replica whose clock is materially behind could reclaim
a lease early. That is recorded as a limitation in §11 rather than papered over.

### 3.11 Failure semantics and crash windows — *Implemented*

Every window, including the one that cannot be closed:

| Situation | State left behind | A same-key retry |
| --- | --- | --- |
| Refused by validation or the pre-filter | **no record** | runs from the start; nothing was claimed |
| Store unreachable before the claim | **no record** | `503 IDEMPOTENCY_STATE_UNAVAILABLE`; nothing was claimed, nothing was spent |
| Unique-index conflict on insert | the winner's record | §3.10's table |
| Process dies after claim, before any provider call | `pending`, lease running | `409` while fresh, then reclaim and execute **once** |
| Provider timeout / transport failure / 429 / 5xx | `failed`, `retryable: true` | reclaim and execute again |
| Provider fatal error (401/403 — misconfiguration) | `failed`, `retryable: true` | reclaim and execute again once the credential is fixed |
| Provider succeeded, then **result persistence failed** | `failed`, `retryable: false`, `errorCategory: "result-persist-failed"` | **replays the failure**, does not spend again |
| Process dies after provider success, before the completion write | `pending`, lease running | after the lease, **reclaim and execute again** — the ambiguous window |
| Completion write rejected because the claim was reclaimed | the reclaimer's record | the reclaimer's outcome |
| Replay read fails | unchanged | `503 IDEMPOTENCY_STATE_UNAVAILABLE` |
| TTL index absent | records never expire | detected by the critical-index gate, not by a route |

The `result-persist-failed` row is the distinction that matters most. Cerberus **observed
the provider succeed** and then failed to record it, so the operation has already spent.
Marking that `retryable: false` and replaying the recorded failure is truthful, and it is
the difference between "we do not know whether it spent" and "we know it spent". The
caller who wants a different outcome uses a **new key**, which is a deliberate act rather
than a silent second charge.

The **crash-after-success window cannot be closed** by this mechanism. It is the time
between the provider's response and one document write. A process that dies inside it
leaves a `pending` record that says "someone is working" and does not say whether anyone
still is, and a reclaim after the lease will call the provider again. Closing it would
require the provider itself to support idempotent requests, which it does not. §11 states
this as the guarantee's edge.

### 3.12 Retention — *Implemented*

`expiresAt` is set from `CERBERUS_IDEMPOTENCY_TTL_SECONDS` (default **86 400** — 24 h;
bounds 60..604 800), and swept by a TTL index on `expiresAt` with
`expireAfterSeconds: 0` — the deadline is the field's value, so the index specification
never changes and cannot drift.

- **The TTL is cleanup, not a security boundary.** An expired record is one a retry may
  no longer find, and after expiry the same key starts a new operation. That is the
  documented intent, not an oversight.
- **Expiry is approximate.** MongoDB's TTL monitor runs about once a minute and deletes
  in the background, so a record may outlive `expiresAt` by up to roughly a minute, and a
  record whose `expiresAt` has passed may still be read in the interval. Nothing depends
  on exact wall-clock expiry: the read path compares `expiresAt` itself and treats an
  expired record as absent.
- **`expiresAt` is refreshed on completion**, so the retention window is measured from
  the end of the operation rather than from its start.
- **24 hours** is chosen against the actual retry behaviour the routes see: a dropped
  connection, a client timeout, or an operator re-pressing a button. A retry a day later
  is a new intent.

### 3.13 Observability and redaction — *Implemented*

| Event | When |
| --- | --- |
| `idempotency.claimed` | this process won the claim |
| `idempotency.reclaimed` | this process reclaimed a stale or retryable record |
| `idempotency.replayed` | a completed or non-retryable-failed record answered the request |
| `idempotency.conflict` | same key, different fingerprint |
| `idempotency.pending` | a fresh pending record answered with `409` |
| `idempotency.completed` | the completion write matched the claim |
| `idempotency.completion-lost` | the completion write matched nothing — a second execution exists |
| `idempotency.failed` | a failure was recorded |

Every line carries `requestId`, `routeFamily`, `state`, `elapsedMs`, `replay` and a
**truncated key digest** (`keyId`, the first 8 hex characters of `keyHash`). Never the
raw key, never a request body, never a provider result. The digest prefix is a
one-way derivation of a value the caller chose, and it is what lets two log lines be
joined to one operation without recording the key.

### 3.14 Rate-limit interaction — *Implemented*

The order is **auth → rate limit → validation → claim → provider**, and it is unchanged
from today except for where the claim sits inside the route.

- Rate limiting runs **before** the claim, as global middleware. A flood is therefore
  refused before it can create records, so the collection cannot be filled by traffic the
  limiter would have rejected.
- The limiter's cost backstop still applies to a replay: a replay is a request. It is
  deliberately **not** exempted, because an exemption would be a way to bypass the
  limiter entirely by reusing one key.
- Nothing about idempotency changes the limiter's per-process scope. §2.1 of
  [../operations/multi-replica.md](../operations/multi-replica.md) is unchanged.

### 3.15 Storage, indexes and migration — *Implemented*

Collection `operation_claims`. One document per claim:

| Field | Purpose |
| --- | --- |
| `routeFamily` | `"scenarios"` or `"auditor"` — one key namespace cannot collide with another |
| `keyHash` | `sha256(Idempotency-Key)`. The raw key is never stored |
| `fingerprint`, `fingerprintVersion` | `sha256` of the canonical request, and the version of the canonicalisation |
| `status` | `pending`, `completed` or `failed` |
| `claimId` | the ownership token; `complete`/`fail` are conditional on it |
| `createdAt`, `updatedAt` | when the claim was made and last changed |
| `leaseExpiresAt` | when a `pending` claim may be reclaimed |
| `expiresAt` | when the record may be swept |
| `result` | for `completed`, the `{status, body}` to replay; for a non-retryable `failed`, the recorded failure |
| `resultOmitted` | present only when the result exceeded the storage bound |
| `errorCategory`, `retryable` | for `failed`: a stable category, never a provider message |

Never stored: API keys, bearer tokens, the raw `Idempotency-Key`, the prompt, the model's
raw response, or the full fingerprint in a log line.

Indexes, from **one shared specification** used by both `ensureIndexes()` and the
migration, so the two cannot drift:

| Type | Key | Why |
| --- | --- | --- |
| Unique | `(routeFamily, keyHash)` | the mutual exclusion; without it a second insert succeeds and two processes both spend |
| TTL | `expiresAt` (`expireAfterSeconds: 0`) | bounds the collection; without it the collection grows forever |

**The fingerprint is deliberately not part of the unique identity.** Including it would
mean the same key with a different body created a *second* record instead of being
detected as a conflict — turning the conflict case into a silent second execution, which
is the exact failure the key exists to prevent. The fingerprint is compared against the
record, not used to select one.

Both indexes are added to `scripts/release/critical-indexes.json` and verified after
every restore, and the list's checker asserts **both directions**: every entry must exist
on the real store, and the store must not create an index the list omits.

Migration `0004-paid-operation-claim-collection` creates the collection's indexes from
the same shared specification. It is ordered, append-only, idempotent, dry-run aware,
concurrency-safe under the existing ledger rule, and rewrites no data — the collection is
new, so there is nothing to repair and no destructive step.

## 4. The claim protocol, end to end

```
Idempotency-Key absent ─────────────────▶ today's behaviour, unchanged
Idempotency-Key present and invalid ────▶ 400 INVALID_IDEMPOTENCY_KEY, no record
Idempotency-Key present and valid:
  insert {status: pending, claimId, leaseExpiresAt, expiresAt}
    ├─ succeeds ─▶ run the paid calls
    │              ├─ success ─▶ complete {status: completed, result}
    │              └─ failure ─▶ fail {status: failed, retryable, errorCategory}
    └─ E11000 ───▶ reclaim (atomic, fingerprint + status + expiry in the filter)
                    ├─ reclaimed ─▶ this process executes
                    └─ not reclaimed ─▶ read the record
                                          ├─ different fingerprint ─▶ 409 IDEMPOTENCY_CONFLICT
                                          ├─ completed ────────────▶ replay the result
                                          ├─ failed, !retryable ────▶ replay the failure
                                          └─ pending, fresh ────────▶ 409 IDEMPOTENCY_IN_PROGRESS
```

## 5. Why the key is opt-in, and why it is never synthesised

The header is optional. A caller that does not send one gets exactly today's behaviour,
which keeps the change additive and means no existing client is affected. A caller that
sends one gets the guarantee.

Making the server generate a key from the request body would look equivalent and is not:
the server cannot distinguish "the caller retried" from "the caller asked twice", so it
would either suppress a legitimate second request or fail to suppress a retry, and in
both cases it would have claimed a protection it does not provide. The caller is the only
party that knows.

## 6. What this is, and is not

- **Is:** duplicate-side-effect mitigation for a *retry*. One key, one operation, one
  replay, for as long as the record is retained.
- **Is not:** authentication, authorization, or replay protection against a hostile
  client. A caller that sends a new key gets a new operation; that is the design.
- **Is not:** per-user attribution. The shared operator key is unchanged, so the
  operation record identifies a request, not a person.
- **Is not:** an exactly-once guarantee. §11.

## 7. Compatibility

| Surface | Change |
| --- | --- |
| `POST /api/v1/scenarios` | Additive. No key → byte-identical behaviour and status codes |
| `POST /api/v1/auditor/query` | Additive. Same |
| Request headers | `Idempotency-Key` accepted, added to the CORS allow-list |
| Response headers | `Idempotency-Replayed: true` on a replay, added to the CORS expose-list |
| Error codes | `INVALID_IDEMPOTENCY_KEY` (400), `IDEMPOTENCY_CONFLICT` (409), `IDEMPOTENCY_IN_PROGRESS` (409), `IDEMPOTENCY_STATE_UNAVAILABLE` (503). All new, all additive |
| MCP tools | `claim_paid_operation`, `complete_paid_operation`, `fail_paid_operation` — added |
| Collection | `operation_claims` — added |
| Removed fields | none |

## 8. Threat model additions

- Idempotency is **duplicate-side-effect mitigation**, not authentication.
- The shared operator key still means no per-user attribution; an operation record
  identifies a request, not a caller identity.
- Stale-pending reclaim **may duplicate provider spend** inside the crash window. That is
  the documented cost of not requiring a replica set or a lock service.
- The TTL is **cleanup, not a security boundary**. An attacker who can send requests can
  fill the collection up to the retention window's worth of traffic, bounded by the rate
  limiter and by the TTL — which is why the claim is made after auth and after the
  limiter.
- **No exactly-once guarantee** is claimed, and no hostile-replay protection beyond the
  specific duplicate-operation suppression described here.
- High-cardinality abuse is bounded by three things: the key is length- and charset-
  capped, the claim happens after authentication and the rate limiter, and every record
  expires.

## 9. What will prove it

Each assertion, and why it exists:

| Assertion | Why |
| --- | --- |
| Same key, same body, twice → **one** provider call, the first result replayed | The whole point. Counted at the stub, not inferred from the response |
| Same key, different body → `409`, and **no** provider call | A key is about one request |
| Reordered JSON keys produce the **same** fingerprint | Canonical ordering is what makes a retry recognisable |
| A changed semantic field produces a **different** fingerprint | The other direction |
| A key over the limit, or with an unsafe character → `400`, and no record | The key is caller-controlled on a paid path |
| Two **real processes**, same key, `Promise.all` → exactly one provider execution | The race the unique index exists for, asserted as the invariant rather than a guess about the winner |
| A claim survives a restart and still replays | "Durable" is what distinguishes this from an in-process `Map` |
| A `pending` claim past its lease does not block a retry, and a fresh one does | Both directions of §3.10 |
| Two processes reclaiming one stale claim → exactly one reclaimer | The atomicity of the reclaim predicate |
| A `failed` + `retryable: false` record replays its failure instead of spending | §3.11's most important row |
| A completion write with a stale `claimId` reports `recorded: false` | A lost completion must be visible, not silent |
| No document holds the raw key, a prompt body, or a provider message | The record is on a path that handles operator-authored content |
| The collection is bounded by `expiresAt`, and the TTL index exists | Retention, asserted against a real MongoDB rather than assumed |
| The unique index exists and is verified after a restore | A restore that lost it would silently turn the mutual exclusion off |
| A replay's `correlationId` is the **current** request's | A replayed response must not present stale observability identity |

## 10. Query cost

More DB work per paid request is the honest trade for duplicate suppression. The counts,
asserted rather than estimated:

| Case | Extra store round trips |
| --- | --- |
| First request | 1 insert + 1 completion write = **2** |
| Completed replay | 1 insert attempt (E11000) + 1 read = **2** |
| Conflict | 1 insert attempt + up to 2 reclaim attempts + 1 read = **up to 4** |
| Fresh pending | 1 insert attempt + 1 read = **2** |
| Reclaim | 1 insert attempt + 1 atomic reclaim = **2** |
| Failure | 1 insert + 1 failure write = **2** |

**There is no polling.** A `pending` answer is returned immediately with `Retry-After`;
the server never waits, and nothing in the mechanism sleeps or loops. The worst case is
bounded at four round trips and is reached only by a conflict.

## 11. What is not claimed

- **Not exactly-once billing.** The provider client's own retry ladder can issue up to
  four HTTP requests per logical call (§2.4), and the crash window in §3.11 can re-spend.
- **Not exactly-once external side effects.** The scenarios matrix is persisted
  best-effort through MCP; a completed replay does not re-persist it, so a replay can
  answer with a matrix whose document was never written. That was already true of the
  first response.
- **Not perfect replay protection.** A caller that sends a new key gets a new operation.
- **Not a guarantee across a crash after provider success but before the completion
  write.** That window is stated in §3.11 and cannot be closed without provider-side
  idempotency.
- **Not a distributed lock, and not a job queue.** The record is a claim and an outcome.
- **Not clock-skew-proof.** The lease is evaluated against the claiming process's clock.
  A replica whose clock is materially behind could reclaim a live lease; the derived
  lease in §3.10 makes that window a fraction of a provider call rather than a fixed
  guess.
- **Not exact TTL expiry.** MongoDB's TTL monitor is approximate, so a record may outlive
  `expiresAt` by up to roughly a minute. The read path treats an expired record as absent,
  so correctness does not depend on the monitor.

## 12. Why this is durable and not an in-process map

An in-process map would pass the easiest tests and fail the only case that matters. Two
API processes share no memory; a restart empties the map; and the documented deployment
already runs more than one replica. "Durable" here means the claim is a MongoDB document
whose uniqueness is enforced by an index, so it survives a restart, is visible to every
replica, and cannot be duplicated by a race — which is precisely what an in-process map
cannot do.

## 13. Implementation status

Updated as each pull request lands. This table is the single source of truth for "is this
done?".

| Capability | Status | Proof |
| --- | --- | --- |
| `operation_claims` collection and its two indexes | **Implemented** | `operation-claims.ts` (one shared specification), `MongoStore.ensureIndexes`, migration `0004`, `critical-indexes.json`, `packages/mcp-mongodb/test/operation-claims.test.ts` |
| `Idempotency-Key` reading, validation and digesting | **Implemented** | `idempotency-key.ts`, `idempotency-key.test.ts` |
| Canonical, versioned request fingerprint | **Implemented** | `request-fingerprint.ts`, `request-fingerprint.test.ts` |
| Atomic claim, replay, conflict, in-progress | **Implemented** | `MongoStore.claimPaidOperation`, `claim_paid_operation`; 11 contract cases in `store-contract.test.ts`, run against the double **and** a real MongoDB |
| Reclaim of a stale or retryable claim | **Implemented** | the same contract cases; the reclaim predicate carries the fingerprint, so a stale record for another request cannot be taken |
| Conditional completion and failure, and the lost-completion signal | **Implemented** | `completePaidOperation` / `failPaidOperation`; the stale-claim-id contract case asserts a lost completion is reported rather than swallowed |
| The `400 INVALID_IDEMPOTENCY_KEY` response | **Implemented** | `scenarios-idempotency.test.ts`, `auditor-idempotency.test.ts` |
| `/scenarios` durable claim and replay | **Implemented** | `scenarios-idempotency.test.ts` (19 cases: replay, conflict, pending, stale reclaim, failure, redaction, correlation identity) |
| `/auditor/query` durable claim and replay | **Implemented** | `auditor-idempotency.test.ts` (13 cases) |
| Two-process race and replay against real MongoDB | **Design** | `test/integration/multi-process-idempotency.test.ts` |
| Retention bound, TTL index and `CERBERUS_IDEMPOTENCY_TTL_SECONDS` | **Implemented** | `operation-claims.ts` (`expireAfterSeconds: 0`), migration `0004`, `config.ts` (bounded, fail-closed), `config.test.ts`, `critical-indexes.test.ts` |
| Migration from a `v0.5.0` database | **Implemented** | `release-fixture.ts` (`v0.5.0` shape), `migration-from-previous-release.test.ts` |
| Backup/restore covers the collection and both indexes | **Implemented** | `backup-restore-drill.mjs` (11 checks, including a refused duplicate claim after restore), `restore-cerberus.ps1` |
| Release harness and CI coverage | **Design** | `verify-release.mjs`, `.github/workflows/ci.yml` |

**Both paid routes are protected.** `operation_claims` exists with both indexes, migration
`0004` creates them, `CERBERUS_IDEMPOTENCY_TTL_SECONDS` bounds retention, the claim protocol
is in `MongoStore` behind three MCP tools, and **both** `POST /api/v1/scenarios` and
`POST /api/v1/auditor/query` read the header, claim, replay, conflict and record their
outcomes. A retry of either route with a key no longer spends twice.

Two rows remain **Design**, and both are about *proving* rather than *building*:

1. **The race between two real API processes.** The store contract cases prove every
   predicate against a real MongoDB, but a single-threaded suite cannot put two claimants in
   flight at once. The two-process harness is the next pull request.
2. **Release-harness and CI coverage** for the new suites. They run in `npm test`, which CI
   already runs, but the harness does not name them as a gate yet.

**One behaviour changed rather than being added**, and it is recorded here because it is the
kind of change that should not be discovered from a diff: a failed `list_sessions` on the
auditor route now answers `503 AUDITOR_STORE_UNAVAILABLE` instead of `200` with a summary
over an empty record set. See §3.5 for why the idempotency mechanism made that a correctness
requirement rather than a nicety.

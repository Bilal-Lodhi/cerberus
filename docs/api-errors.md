# API error model

Every stable client-facing error `code`, the HTTP status that carries it, and the
action a client can take. Written from the source.

## 1. What is and is not a contract

`docs/compatibility.md` §1 lists the stable error `code` values as a public surface.
So:

- **A code is a contract.** Its spelling, its HTTP status and its meaning are fixed.
  Renaming one, changing its status, or giving it a second meaning is a breaking
  change and gets the §2 treatment in [compatibility.md](compatibility.md).
- **A message is not.** The `error` string is written for a human and may be
  reworded, extended or localised without notice. A client must branch on `code`,
  never on message text.
- **`correlationId` is not.** It is a per-request identifier for log correlation. Its
  presence and shape may change.

The Flutter console does **not** yet branch on `code`: `apps/console/lib/services/api_service.dart`
reads `body['error']` and shows it to the operator. That works today only because the
messages are written for a human, and it means a reworded message changes what an
operator sees. Making the console map `code` to its own text — so the message becomes
free to change — is tracked as console work, and this document is the list it maps
against.

## 2. The envelope

Every error response is a JSON object with `success: false` and an `error` string.
Beyond that, three fields appear where they are useful:

| Field | Meaning | Present on |
| --- | --- | --- |
| `code` | The stable code. | Every error that a client can act on differently |
| `correlationId` | Matches the `X-Correlation-Id` and `X-Request-Id` response headers, and the request log line | Every error, with one deliberate exception below |
| `status` | The session status that caused a refusal | Session transition refusals |

**Every route now returns the same value in `correlationId` as it does in the response
headers.** That was not true before this cycle: `index.ts` set one
`X-Correlation-Id` per response while `routes/guardian.ts`, `routes/review.ts`,
`routes/reference.ts` and `routes/auditor.ts` each minted their own `randomUUID()` per
handler, so for four of the five route groups the value in the body appeared in no
header and in no log line an operator could key on. The full record is in
[development/operability-model.md](development/operability-model.md) §4.

The **one exception** is the authentication rejection: `UNAUTHENTICATED` carries no
`correlationId`, because `docs/security/threat-model.md` §4 requires the
missing-credential and wrong-credential responses to be **byte-identical**, and a
per-request value would make them differ. Both still carry the request id in the
response headers, so the request is still correlatable.

An incoming `X-Request-Id` is accepted only when it is at most 128 characters and uses
`A-Z a-z 0-9 . _ : -`. A value that fails that validation is **replaced with a
generated one, not rejected**: an id is a correlation label, so a header the caller did
not know existed must not turn into a client-visible failure, and no route needs to act
differently. That is why there is no `INVALID_REQUEST_ID` code.

Errors raised by the framework rather than by a route — a malformed request line, an
unknown path — carry `code: "NOT_FOUND"` from the 404 handler or
`code: "INTERNAL_ERROR"` from the top-level handler. **Nothing else is ever returned
for an unhandled failure**: `INTERNAL_ERROR` deliberately discards the exception, so
no stack, driver message, provider payload or file path can reach a client. The
exception is logged server-side.

## 3. Authentication and transport

| Code | HTTP | Meaning | Client action |
| --- | --- | --- | --- |
| `UNAUTHENTICATED` | 401 | No credential, or one that matches neither the current nor the previous key | Present the operator key. Do not retry unchanged. |
| `PAYLOAD_TOO_LARGE` | 413 | The request body exceeds `CERBERUS_MAX_BODY_BYTES`. Refused **before** the body is buffered. | Send less. Splitting a telemetry batch is the intended remedy. |
| `RATE_LIMITED` | 429 | The per-process token bucket for this route category is empty | Back off. The response carries `retryAfterSeconds` **and** a `Retry-After` header. |
| `NOT_FOUND` | 404 | No route matches the method and path | Fix the URL. |
| `INTERNAL_ERROR` | 500 | An unhandled failure. The detail is logged, never returned. | Report with the `correlationId`. |

Rate limiting is a **per-process backstop, not DDoS protection**: it runs after
authentication and does not limit unauthenticated requests. N replicas enforce up to N
times the limit. See [operations/reverse-proxy.md](operations/reverse-proxy.md).

## 4. Session lifecycle

These are the codes the transition boundary returns. They are stable, and each has one
meaning.

| Code | HTTP | Meaning | Client action |
| --- | --- | --- | --- |
| `SESSION_EXPIRED` | 409 | The session's monitoring window has closed: its last server-observed activity is at least `SESSION_TTL_SECONDS` old. Telemetry is refused. | `POST /api/v1/guardian/sessions/:id/reactivate`, or deploy a new session. **Evidence is retained** — the review surfaces still serve it. |
| `SESSION_TERMINATED` | 409 | The session is `terminated`, which is irreversible. Returned by `reactivate` **and** by telemetry ingest. | Deploy a new session. Do not retry. |
| `SESSION_CONFLICT` | 409 | The durable status changed between the read and the write, so the transition was applied to a state the caller did not see. **The write did not happen.** | Re-read the session, then retry if the transition is still wanted. |
| `SESSION_NOT_FOUND` | 404 | No session document matches. Returned by every surface that can report it: the transition boundary, the live detail route, the review list's per-session read, the review detail route, and session deletion. | Check the id. |
| `SESSION_STORE_UNAVAILABLE` | 503 | The persistence layer did not answer, or answered with a failure. **Nothing was changed.** Returned by the transition boundary, by a `DELETE`, and by a **read** of a session detail when the store cannot be reached and this process holds nothing for the session. | Retry with backoff. |
| `INVALID_SESSION_TRANSITION` | 409 | The requested transition is not in the table for the session's current status, and the session is not terminal — which means the document holds a status the durable vocabulary cannot produce (`flagged`, `investigating`, `cleared`). | This is a data-integrity signal. Report it with the `correlationId`; do not retry. |

**One code, one meaning.** `SESSION_TERMINATED` is returned by two routes on purpose:
the actionable fact is the same — the session has ended — and minting a second code
would make a client handle the same condition twice.

A refusal that read the durable status also **reconciles the in-memory cache** to the
value it read, so a status that diverged because another writer moved it is corrected
rather than reported. A refusal never changes the durable status.

**A read can now return `SESSION_STORE_UNAVAILABLE` too.** `GET
/api/v1/guardian/sessions/:id` answers from this process's memory first, then from the
durable document, then from the live registry alone. When the store cannot be reached and
none of those holds the session, the answer is `503` — **not** `404`, because `404` would
assert that no such session exists, which cannot be verified from a store that did not
answer. The response carries `source` (`"memory"` or `"durable"`) and
`ephemeralStateAvailable`, so a caller can tell where a detail came from and whether this
process holds the reconstructed workspace for it. See
[development/operability-model.md](development/operability-model.md) §3.7 and §8.5.

The **live** surfaces report the status this process holds in memory, while the **review**
surfaces read the durable document. A status changed durably by another writer is
therefore visible on the review surface immediately, and on the live surfaces once a
transition reconciles the cache. That division is deliberate and is stated in
`operability-model.md` §9.1.

### 4.1 Session deletion

A deletion cascades over three **domain components** — `session`, `telemetry`,
`assessments` — and it can partly succeed. That is a different fact from "the store did
not answer", and the two are reported differently.

| Code | HTTP | Meaning | Client action |
| --- | --- | --- | --- |
| `PARTIAL_DELETE` | 500 | The deletion ran and only part of it succeeded. The body names the components that were removed (`components`) and the ones that were not (`failedComponents`). **Retrying is safe and is the remedy.** | Retry the same `DELETE`. The store removes the derived documents first and the session record last, so a retry finishes the job and nothing is orphaned. |
| `SESSION_STORE_UNAVAILABLE` | 503 | The store did not answer, so **nothing was attempted**. | Retry with backoff. |
| `SESSION_NOT_FOUND` | 404 | Nothing durable matched, and this process held nothing for the session either. | Treat as done. |

**A complete deletion is `200` with the same shape**: `complete: true`, `partial: false`,
`components` with the counts that were removed, `failedComponents: []`, and
`deletedDurably`. One contract, so a client reads one response shape whether or not the
deletion finished.

**Why the two failure codes are distinct.** A client that treated `PARTIAL_DELETE` and
`SESSION_STORE_UNAVAILABLE` alike would either retry an operation that never ran, or fail
to retry one that half-ran. `PARTIAL_DELETE` is `500` rather than `503` for the same
reason: `503` in this API means "a dependency did not answer and nothing was changed".

**Component names are domain names, not collection names.** `telemetry` and `assessments`
are what a caller reasons about; freezing `micro_events` and `risk_assessments` into a
public response would make a collection rename a breaking change to this contract.

**Retry semantics, precisely.** The store removes the derived documents first and the
session document **last**, and skips the session document entirely when a derived removal
failed. So a partial deletion leaves the session identifiable, and nothing is orphaned:
the session record is what identifies its telemetry, and removing it first would leave
documents no query could find. Successful component removals are never undone and never
re-reported — a second attempt reports `0` for them.

## 5. Telemetry ingestion

| Code | HTTP | Meaning | Client action |
| --- | --- | --- | --- |
| `BATCH_TOO_LARGE` | 400 | More than `MAX_EVENTS_PER_BATCH` (1 000) events in one request | Split the batch. The response carries `maxEvents`. |
| `MISSING_EVENT_ID` | 400 | An event has no non-empty `eventId`. `eventId` is the durable idempotency key, so an event without one cannot be deduplicated. | Fix the client. Every event needs one. |
| `SESSION_STORE_UNAVAILABLE` | 503 | A `DELETE` could not reach the persistence layer, so **nothing was changed** | Retry with backoff. |
| `SESSION_NOT_FOUND` | 404 | A `DELETE` matched no session, and the session was not in memory either | Treat as done. |
| `PARTIAL_DELETE` | 500 | See §4.1. | Retry the `DELETE`. |

A batch is **idempotent on `(sessionId, eventId)`**: re-sending it stores nothing new
and does not inflate the counters. The response reports `acceptedCount` and
`duplicateCount` alongside `processedCount` (which remains the batch size), so a client
retrying after a network ambiguity can tell that its events were already stored.

**`acceptedCount` and `duplicateCount` are omitted when `telemetryPersisted` is
`false`.** That means the store did not answer for the events write: the counts cannot
be stated, and a number the server knows is unverified is worse than no number.
`processedCount` always keeps its meaning, so nothing is lost. Before this field
existed, a failed write returned `acceptedCount: <batch size>` and `duplicateCount: 0`
— byte-for-byte what a fully successful ingest returns.

`assessmentPersisted` reports whether the `riskPayload` in the response is durable. It
is absent when no analysis ran. `false` means the paid analysis completed and its
persistence did not, in which case the session's status was deliberately **not** changed
and no notification was sent: a lock whose justification was never recorded is worse
than no lock.

This is retry idempotency, **not replay protection**: the monitored client supplies
`eventId`, so a client that wants to re-send content can send a fresh one. The threat
model says so explicitly.

## 6. Scenario authoring

| Code | HTTP | Meaning | Client action |
| --- | --- | --- | --- |
| `PROMPT_TOO_LONG` | 400 | `prompt` exceeds `MAX_PROMPT_CHARS` (8 000). Checked before any paid inference. | Shorten it. The response carries `maxChars`. |
| `ROLE_CONTEXT_TOO_LONG` | 400 | `roleContext` exceeds `MAX_ROLE_CONTEXT_CHARS` (200). | Shorten it. |
| `CLASSIFIER_UNAVAILABLE` | 503 | The semantic classifier could not be reached, so the request could not be validated. **Fail-closed**: no scenario is authored. | Retry. `retryable: true`. |
| `AI_UNAVAILABLE` | 503 | The provider was overloaded, timed out, or returned a retryable status. | Retry with backoff. `retryable: true`. |
| `SCENARIO_GENERATION_FAILED` | 500 | Generation failed for a non-retryable reason. | Report with the `correlationId`. |

A `422` with no `code` is returned when the pre-filter or the classifier rejects the
content on its merits (empty, greeting, gibberish, profanity, off-topic). That is a
content verdict rather than an error condition, so it carries `preFilterFlags` or
`contentFlags` instead of a code.

Persistence is **best-effort and reported**: a successful generation whose MongoDB
write fails returns `201` with `persisted: false` and the matrix in the body. The paid
artefact is not lost, and the response does not pretend it was stored.

## 7. Auditor

| Code | HTTP | Meaning | Client action |
| --- | --- | --- | --- |
| `QUESTION_TOO_LONG` | 400 | `question` exceeds `MAX_QUESTION_CHARS` (2 000). Checked before either paid call. | Shorten it. |
| `AUDITOR_QUERY_FAILED` | 500 | Pipeline construction or summarisation failed. | Report with the `correlationId`. |

## 8. Reference corpus

| Code | HTTP | Meaning | Client action |
| --- | --- | --- | --- |
| `INVALID_REFERENCE_DOCUMENT` | 400 | A field is missing, empty, the wrong type, or over its bound | Fix the document. The message names the field and the bound. |
| `REFERENCE_NOT_FOUND` | 404 | A delete matched no document with that `referenceId`. | Nothing to do — it is already gone. Distinguish this from `REFERENCE_STORE_UNAVAILABLE`, which is a retry. |
| `REFERENCE_CORPUS_LIMIT_REACHED` | 409 | The corpus is at `MAX_REFERENCE_DOCUMENTS` (200) and this would be a **new** document. An update of an existing `referenceId` is always allowed. | Remove a document first. Retrying will not help. The response carries `limit`. |
| `REFERENCE_STORE_UNAVAILABLE` | 503 | The corpus store did not answer. **Similarity matching degrades to no matches rather than failing an analysis.** | Retry. |

A failed corpus read during risk analysis does **not** fail the analysis: it returns an
empty corpus and logs. Similarity is one signal among several, and losing it must not
lose the telemetry or the risk score.

## 9. Identity

| Code | HTTP | Meaning | Client action |
| --- | --- | --- | --- |
| `INVALID_IDENTITY_FIELD` | 400 | An identity field is missing, the wrong type, or over its bound | Fix the field. The message names it. |

The identity registry is an in-memory, per-process handle store with a 12-hour expiry
and a ceiling of 100 entries. It is **not** an authorization credential, and a handle
is not an account. See [security/threat-model.md](security/threat-model.md).

## 10. What is deliberately absent

- **No error taxonomy for internal failures.** A client cannot distinguish "MongoDB was
  slow" from "the provider returned garbage"; both are `INTERNAL_ERROR` or the owning
  route's 500. Exposing the difference would describe the deployment to an attacker
  without giving a client anything it can act on differently.
- **No `Retry-After` header on 503.** The rate limiter sets it, because there the wait
  is a known number. A store outage has no schedule worth guessing at, so a 503
  carries no wait hint — a client should back off on its own curve.
- **No per-field validation error array.** One message names the first problem, which
  is enough for a client to fix and retry. A full field-error list would be a larger
  contract to keep stable than the value it returns.

## 11. Retry and idempotency contracts, per route

What a caller may safely do after a timeout, a dropped connection, or any response it did
not receive. This is the contract that matters most in practice: a network ambiguity is the
common failure, and "retry it" is only safe advice where the route says so.

| Route | Contract | Key | Duplicate-spend risk |
| --- | --- | --- | --- |
| `GET /health`, `GET /ready` | **Retry-safe.** Read-only. | — | none |
| `GET /api/v1/guardian/sessions` | **Retry-safe.** Read-only. | — | none |
| `GET /api/v1/guardian/sessions/:id` | **Retry-safe.** Read-only. | — | none |
| `GET /api/v1/sessions`, `GET /api/v1/sessions/:id` | **Retry-safe.** Read-only. | — | none |
| `GET /api/v1/identity/me` | **Retry-safe.** Read-only. | — | none |
| `POST /api/v1/identity/set` | **Retry-safe.** Re-registering the same identity returns the same handle shape; the registry is keyed on the display name and evicts by age, not by call count. | — | none |
| `POST /api/v1/guardian/deploy` | **Idempotent.** `create_session` is `$setOnInsert`, so a retry inserts nothing and returns the same `201`. | `sessionId` | none |
| `POST /api/v1/guardian/ingest` | **Idempotent via `eventId`.** `micro_events` carries a unique index on `(sessionId, eventId)` and the store reports which events were new, so a retry stores nothing and does not inflate the counters. The response's `acceptedCount` / `duplicateCount` tell the caller which case it was. | `(sessionId, eventId)` per event | **analysis re-spend.** A retry re-runs the paid analysis unless the workspace is unchanged *and* the process did not restart — the code-hash dedup layer is in-memory only. See §11.1. |
| `POST /api/v1/guardian/sessions/:id/terminate` | **Idempotent.** A second call is a legal no-op that returns `200`. | `sessionId` | none |
| `POST /api/v1/guardian/sessions/:id/reactivate` | **Idempotent** for a live session; refused for a terminated one. | `sessionId` | none |
| `DELETE /api/v1/guardian/sessions/:id` | **Idempotent in effect, not in status.** The first call returns `200`; a second returns `404` because nothing matched. A caller retrying after a lost response should treat `404` as success. | `sessionId` | none |
| `POST /api/v1/reference-documents` | **Idempotent via `referenceId`.** An update of an existing document is always allowed; only a genuinely new id claims a slot. Omitting `referenceId` makes each call a **new** document, so a retry creates a second one. | `referenceId` | none |
| `DELETE /api/v1/reference-documents/:id` | **Idempotent in effect, not in status** (`200`, then `404`). | `referenceId` | none |
| `POST /api/v1/scenarios` | **Non-idempotent, and paid.** Every call spends two provider calls (classify, generate). A retry after a lost response re-spends both. | — | **high.** See §11.1. |
| `POST /api/v1/scenarios/cancel` | **Idempotent in effect.** Cancelling an unknown or finished request is a `404`; treat it as done. | `generationRequestId` | none |
| `POST /api/v1/auditor/query` | **Non-idempotent, and paid.** Every call spends two provider calls. A retry re-spends both. | — | **high.** |

### 11.1 The two paid paths, and why no `Idempotency-Key` was added

Both paid routes can double-spend on a retry, and neither carries an idempotency key. That
is a **deliberate** decision, recorded here rather than left implicit.

**What a key would cost.** Implementing one properly means: a bounded key length, a request
fingerprint, returning the prior result for the same key and payload, conflicting for the
same key and a different payload, durability across a restart, race-safety under concurrent
identical requests, a bounded retention window, and no secret in the logs. That is a
capability in its own right — a durable request-result store — and it would be the largest
single component in the system.

**What the evidence says.** Neither path is retried by the console on a timeout: it surfaces
the error and lets the operator decide, and the operator is present and reading the screen.
The rate limiter already bounds how much a looping client can spend. And the scenario route
reports `persisted` honestly, so a lost response is recoverable by reading the matrix back
rather than by re-generating it.

**What would change the decision.** A client that retries paid routes automatically, or a
second consumer of the API that cannot see the screen. Either would justify the store. Until
then, the honest position is that these two routes are **non-idempotent and paid**, and the
documentation says so plainly rather than implying a guarantee that is not there.

**What *is* idempotent, and how.** `ingest` is the one paid path that is safe to retry for
its *telemetry*: the durable `(sessionId, eventId)` identity makes storage at-most-once and
the counters monotonic. What it does not protect is the analysis spend, which is bounded by
the in-memory code-hash layer and by the rate limiter. Both halves are stated in §5.
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
| `correlationId` | Matches the `X-Correlation-Id` response header and the server log line | Most errors |
| `status` | The session status that caused a refusal | Session transition refusals |

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
| `SESSION_NOT_FOUND` | 404 | No session document matches. | Check the id. |
| `SESSION_STORE_UNAVAILABLE` | 503 | The persistence layer did not answer, or answered with a failure. **Nothing was changed.** | Retry with backoff. |
| `INVALID_SESSION_TRANSITION` | 409 | The requested transition is not in the table for the session's current status, and the session is not terminal — which means the document holds a status the durable vocabulary cannot produce (`flagged`, `investigating`, `cleared`). | This is a data-integrity signal. Report it with the `correlationId`; do not retry. |

**One code, one meaning.** `SESSION_TERMINATED` is returned by two routes on purpose:
the actionable fact is the same — the session has ended — and minting a second code
would make a client handle the same condition twice.

A refusal that read the durable status also **reconciles the in-memory cache** to the
value it read, so a status that diverged because another writer moved it is corrected
rather than reported. A refusal never changes the durable status.

## 5. Telemetry ingestion

| Code | HTTP | Meaning | Client action |
| --- | --- | --- | --- |
| `BATCH_TOO_LARGE` | 400 | More than `MAX_EVENTS_PER_BATCH` (1 000) events in one request | Split the batch. The response carries `maxEvents`. |
| `MISSING_EVENT_ID` | 400 | An event has no non-empty `eventId`. `eventId` is the durable idempotency key, so an event without one cannot be deduplicated. | Fix the client. Every event needs one. |

A batch is **idempotent on `(sessionId, eventId)`**: re-sending it stores nothing new
and does not inflate the counters. The response reports `acceptedCount` and
`duplicateCount` alongside `processedCount` (which remains the batch size), so a client
retrying after a network ambiguity can tell that its events were already stored.

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

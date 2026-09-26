# Operability model

What an operator can observe about a Cerberus request, what they cannot, and why.
Written from the source, not from intent.

Scope: the Cerberus API (`apps/api`), the MCP MongoDB adapter
(`packages/mcp-mongodb`), and the non-HTTP operational helpers (`scripts/`). The
Flutter console (`apps/console`) is covered only where it is the caller that
decides what a response means.

This document has two halves and they are labelled apart on purpose:

- **§2–§4 and §8–§9 describe what the code does today**, and every claim there is
  checkable against the file it names.
- **§5–§7 describe the target design** for structured logging, request correlation
  and sensitive-field discipline. §10 records, item by item, which parts of that
  design are implemented and which are not. A design section is not a claim that
  the behaviour exists.

Cerberus is **not production ready**. This document does not change that, and
nothing in it should be read as a compliance or audit-trail claim. Structured logs
are a debugging and correlation aid; retention, shipping, access control and legal
basis for them belong to whoever deploys the software.

## 1. Why an operability model is a separate document

The architecture documents describe what the system *is*. This one answers the
questions an operator actually asks while something is going wrong:

| Question | Where it is answered here |
| --- | --- |
| Is the process alive? | §8.1 |
| Can it serve? Is a dependency down? | §8.2, §8.3 |
| Did this request fail, and which request was it? | §8.4, §4 |
| Did a delete partially succeed? | §9, and `api-errors.md` §4 |
| Was a session detail served from memory or from durable storage? | §8.5 |
| What must never appear in a log line? | §7 |

## 2. How to read the request-path map

Every route is described by the same nine columns. They are defined once, here, so
the tables stay readable.

| Column | Meaning |
| --- | --- |
| **Auth** | Whether the operator API key is required. `public` means the path is in `PUBLIC_PATHS` in `apps/api/src/middleware/auth.ts` and is reachable without a credential; `operator key` means a missing or wrong credential is a `401 UNAUTHENTICATED`. `CERBERUS_DEV_MODE=true` admits every route, so `operator key` describes production behaviour only. |
| **Request ID** | What identifier is available for correlating this request's log lines today. `header only` means the response carries `X-Correlation-Id` and nothing else uses it; `header + body` means the response body's `correlationId` carries the same value; `route-local` means the route minted its own `randomUUID()` and **that value does not match the response header** (see §4). |
| **Logs** | The `console.*` call sites the path can reach, by module. All of them are unstructured text today (§5). |
| **Dependencies** | The external calls the request makes, and their deadlines. Every MCP call is timeout-isolated by `callMcpTool`; every provider call by `ai/provider.ts`; every notification by `notifications.ts`. |
| **Durable writes** | What the request can change in MongoDB. A blank cell means the request is read-only. |
| **Response status** | The statuses the route can return. |
| **Stable error code** | The codes a client may branch on. Message prose is never a contract — see `api-errors.md` §1. |
| **Degraded behaviour** | What happens when a dependency fails. "Degrade" means the request still answers, with a truthful report of what did not happen. |
| **Never logged** | The fields from this path that must not reach a log line (§7). |

Rate limiting applies to every authenticated route and is described once, in §3.10.

## 3. Request-path map

### 3.1 Probes and capability discovery

| Route | Auth | Request ID | Logs | Dependencies | Durable writes | Response status | Stable error code | Degraded behaviour | Never logged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GET /health` | public | header only | none | none | — | `200` | — | Answers while the process answers HTTP. It checks **nothing**, deliberately: a liveness probe that fails on a dependency outage causes a restart loop while the outage continues (`services/readiness.ts`). | — |
| `GET /ready` | public | header only | `services/readiness.ts` does not log; the probe's dependency check logs through `mcp-client.ts` | one `health_check` MCP call, 1 500 ms | — | `200` ready, `503` not ready | — | Never throws. A failed check is reported as a `down` dependency with a one-line `detail`; the result is cached for 2 000 ms and concurrent probes share one in-flight check. | — |
| `GET /` | public | header only | none | none | — | `200` | — | Alias of `/health`. | — |

### 3.2 Identity

| Route | Auth | Request ID | Logs | Dependencies | Durable writes | Response status | Stable error code | Degraded behaviour | Never logged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `POST /api/v1/identity/set` | operator key | header only | `routes/identity.ts` (one `console.log` on registration) | none | none — the registry is in-memory, per-process, 12 h expiry, 100-entry ceiling | `201`, `400` | `INVALID_IDENTITY_FIELD` | Nothing to degrade: no dependency. An at-ceiling registry evicts the oldest handle rather than refusing. | `displayName`, `employeeId` are operator-supplied identifiers — log the fact of registration, not the values |
| `GET /api/v1/identity/me` | operator key | header only | none | none | — | `200`, `401` | — (prose only) | Nothing to degrade. An expired or unknown handle is `401` and the entry is dropped. | the session token; it is **not** a credential, and must not be logged as one |

The identity registry is **not** an authentication mechanism. A handle is not an
account, is not accepted as a credential anywhere, and carries no authorization.

### 3.3 Scenario authoring — paid

| Route | Auth | Request ID | Logs | Dependencies | Durable writes | Response status | Stable error code | Degraded behaviour | Never logged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `POST /api/v1/scenarios` | operator key | **header + body** — the one route that reads `X-Correlation-Id` | `routes/scenarios.ts`, `ai/provider.ts` | two provider calls (classify, generate) + one `store_threat_scenario` MCP call | `threat_scenarios` (best effort) | `201`, `400`, `422`, `500`, `503` | `PROMPT_TOO_LONG`, `ROLE_CONTEXT_TOO_LONG`, `CLASSIFIER_UNAVAILABLE`, `AI_UNAVAILABLE`, `SCENARIO_GENERATION_FAILED` | **Fail-closed on classification**: an unreachable classifier is `503 CLASSIFIER_UNAVAILABLE` and no scenario is authored. Persistence is best-effort and reported: a failed write returns `201` with `persisted: false` and the matrix in the body. | the `prompt` and `roleContext` bodies in full; the provider prompt; the provider API key |
| `POST /api/v1/scenarios/cancel` | operator key | header only | none | none | — | `200`, `404` | — (prose only) | Cancelling an unknown or already-finished generation is `404`; treat it as done. | — |

**Non-idempotent and paid.** A retry after a lost response re-spends two provider
calls. There is no `Idempotency-Key`, deliberately — the reasoning is in
`api-errors.md` §11.1.

### 3.4 Auditor — paid

| Route | Auth | Request ID | Logs | Dependencies | Durable writes | Response status | Stable error code | Degraded behaviour | Never logged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `POST /api/v1/auditor/query` | operator key | route-local (§4) | `routes/auditor.ts`, `ai/provider.ts` | one `list_sessions` MCP call + two provider calls (pipeline, summary) | — | `200`, `400`, `500` | `QUESTION_TOO_LONG`, `AUDITOR_QUERY_FAILED` | The result set is truncated to 200 records whatever pipeline the model produced, so a pipeline without `$limit` cannot pass every session to the provider. | the `question` in full; the provider prompt; the provider API key |

**Non-idempotent and paid**, for the same reason as §3.3.

### 3.5 Guardian — deploy and ingest

| Route | Auth | Request ID | Logs | Dependencies | Durable writes | Response status | Stable error code | Degraded behaviour | Never logged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `POST /api/v1/guardian/deploy` | operator key | route-local (§4) | `routes/guardian.ts` | one `create_session` MCP call | `monitored_sessions` insert (`$setOnInsert`, so a retry inserts nothing) | `201`, `400`, `500` | — (prose only) | A store failure still returns `201` with `mongoDocumentId: "local-only"`, because the live registry entry is what the console needs next. The response does not claim a durable write that did not happen. | — |
| `POST /api/v1/guardian/ingest` | operator key | route-local (§4) | `routes/guardian.ts`, `services/mcp-client.ts`, `ai/provider.ts`, `services/notifications.ts`, `services/session-transition.ts` | up to three MCP calls (session read/create, event batch, counters) + one or two provider calls + one `store_risk_assessment` + optional Slack and email | `micro_events`, `monitored_sessions` counters and status, `risk_assessments` | `200`, `400`, `404`, `409`, `500` | `BATCH_TOO_LARGE`, `MISSING_EVENT_ID`, `SESSION_EXPIRED`, `SESSION_TERMINATED` | Telemetry is written **before** any side effect. A failed event write is reported as `telemetryPersisted: false` with the counts **omitted** rather than guessed. A failed assessment write skips the status change and the notification, and reports `assessmentPersisted: false`. AI analysis failure is logged and swallowed: the telemetry is already durable. | full telemetry bodies; paste content; `currentCode`; the provider prompt; the operator key; the MCP token |

Ingest is the busiest and most failure-prone path in the system, and it is the one
where a log line is most likely to leak monitored content. §7 is written with this
route in mind.

### 3.6 Guardian — lifecycle

| Route | Auth | Request ID | Logs | Dependencies | Durable writes | Response status | Stable error code | Degraded behaviour | Never logged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `POST /api/v1/guardian/sessions/:id/terminate` | operator key | route-local (§4) | `routes/guardian.ts`, `services/session-transition.ts` | one `get_session_review` + one `update_session_terminal_content` + one `set_session_status` | `monitored_sessions.terminalContent` and `.status` | `200`, `404`, `409`, `503` | `SESSION_TERMINATED`, `SESSION_NOT_FOUND`, `SESSION_STORE_UNAVAILABLE`, `SESSION_CONFLICT` | Terminal-content preservation is best-effort and non-fatal: a failure to write it is logged and termination proceeds. The status write is durable-first and its result decides the response. A store that does not answer is `503` with **nothing changed**. | the workspace content being preserved |
| `POST /api/v1/guardian/sessions/:id/reactivate` | operator key | route-local (§4) | `routes/guardian.ts`, `services/session-transition.ts` | one `get_session_review` + one `set_session_status` | `monitored_sessions.status` | `200`, `404`, `409`, `503` | `SESSION_TERMINATED`, `SESSION_NOT_FOUND`, `SESSION_STORE_UNAVAILABLE`, `SESSION_CONFLICT`, `INVALID_SESSION_TRANSITION` | Idempotent for a live session. A terminated session is refused; termination is not reversible. | — |
| `DELETE /api/v1/guardian/sessions/:id` | operator key | route-local (§4) | `routes/guardian.ts`, `services/mcp-client.ts` | one `delete_session` MCP call | `monitored_sessions`, `micro_events`, `risk_assessments` for that session | `200`, `404`, `503` | `SESSION_STORE_UNAVAILABLE` | A store that does not answer is `503` with **nothing changed** — the in-memory caches are deliberately left alone, because clearing them would hide a session that is still durable. | — |

### 3.7 Guardian — live list and detail

| Route | Auth | Request ID | Logs | Dependencies | Durable writes | Response status | Stable error code | Degraded behaviour | Never logged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GET /api/v1/guardian/sessions` | operator key | route-local (§4) | `routes/guardian.ts`, `services/mcp-client.ts` | one `list_sessions` MCP call, **only when memory holds no live session** | — | `200` | — | Falls back to MongoDB when the in-memory store is empty, and rebuilds the live registry from the durable documents. A store failure yields an empty list rather than an error. | — |
| `GET /api/v1/guardian/sessions/:id` | operator key | **none today** | none | **none today** | — | `200`, `404` | — | **No durable fallback.** Immediately after a restart this answers `404` for a session that exists durably, until `GET /api/v1/guardian/sessions` is called, because that is the path that rebuilds the registry. Recorded as open item D4 in `state-transition-model.md` §5. | `currentCode` is returned to the caller by contract, so it must not also be logged |

This is the read-integrity gap the v0.4.0 cycle exists to close. It is a
correctness defect, not a design choice: the same session is `404` on one surface
and `200` on the review surface, from the same process, at the same instant.

### 3.8 Review surfaces

| Route | Auth | Request ID | Logs | Dependencies | Durable writes | Response status | Stable error code | Degraded behaviour | Never logged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GET /api/v1/sessions` | operator key | route-local (§4) | `services/mcp-client.ts` | one `list_sessions` + one bounded `get_session_review` per session (`eventsLimit: 0`, `assessmentsLimit: 1`) | — | `200` | — | Merges durable entries with the two in-memory maps and takes the maximum observed counter, so a restart never under-reports. A failed per-session read leaves the durable entry's own counters in place. | — |
| `GET /api/v1/sessions/:id` | operator key | route-local (§4) | `services/mcp-client.ts` | one `get_session_review` | — | `200`, `404` | — | **Serves from live memory when the store does not answer** and the session is in memory. A store failure with nothing in memory is `404`. | `terminalContent` and `codeSnapshot`; both are returned to the caller, and neither belongs in a log line |

The review surfaces deliberately include sessions whose `SESSION_TTL_SECONDS`
window has closed. Expiry stops monitoring; it never hides evidence.

### 3.9 Reference corpus CRUD

| Route | Auth | Request ID | Logs | Dependencies | Durable writes | Response status | Stable error code | Degraded behaviour | Never logged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `POST /api/v1/reference-documents` | operator key | route-local (§4) | `routes/reference.ts` | one `store_reference_document` MCP call | `reference_documents`, `reference_corpus_meta` | `201`, `400`, `409`, `503` | `INVALID_REFERENCE_DOCUMENT`, `REFERENCE_CORPUS_LIMIT_REACHED`, `REFERENCE_STORE_UNAVAILABLE` | The ceiling is enforced **at the store** with an atomic conditional `$inc`, so a 201st document is refused rather than stored and then excluded from every comparison. | the document `content` — it is operator-supplied reference text and may itself be sensitive |
| `GET /api/v1/reference-documents` | operator key | route-local (§4) | `routes/reference.ts` | one `list_reference_documents` MCP call | — | `200`, `503` | `REFERENCE_STORE_UNAVAILABLE` | A failed read is `503` rather than an empty corpus, because an empty corpus and an unreachable one mean different things to an operator. | `content` |
| `DELETE /api/v1/reference-documents/:id` | operator key | route-local (§4) | `routes/reference.ts` | one `delete_reference_document` MCP call | `reference_documents`, `reference_corpus_meta` | `200`, `404`, `503` | `REFERENCE_STORE_UNAVAILABLE` | Idempotent in effect, not in status: `200` then `404`. | — |

A failed corpus read during risk analysis is a different path and degrades
differently: it returns an empty corpus and logs, rather than failing the analysis.

### 3.10 Rate limiting, and the non-HTTP helpers

**Rate limiting** applies to every authenticated route and is a **per-process token
bucket, not DDoS defence**. It runs **after** authentication, deliberately, and
never reads `X-Forwarded-For`. Categories, from `services/rate-limit.ts`:

| Category | Routes | Default |
| --- | --- | --- |
| `ai` | `POST /api/v1/scenarios`, `POST /api/v1/auditor/query` | 10/min (`CERBERUS_AI_REQUESTS_PER_MINUTE`) |
| `ingest` | `POST /api/v1/guardian/ingest` | 600/min |
| `mutation` | everything else that is not a `GET`/`HEAD`/`OPTIONS` | 60/min |
| `read` | `GET`/`HEAD`/`OPTIONS` | 300/min |
| exempt | `/`, `/health`, `/ready` | — |

A rejection is `429 RATE_LIMITED` with `retryAfterSeconds` in the body **and** a
`Retry-After` header.

**Non-HTTP helpers.** These are not requests, so the request-path columns do not
apply. They are listed because they are operational surfaces with their own
observability story:

| Helper | Entry point | Observability today |
| --- | --- | --- |
| Migrations | `npm run migrate`, `npm run migrate:dry-run` (`packages/mcp-mongodb/src/migrate-cli.ts`) | Prints one line per migration applied or skipped, and a ledger summary. Exits non-zero on failure. |
| Backup | `npm run backup` (`scripts/backup-cerberus.ps1`) | Prints per-collection counts and writes a manifest beside the dump, so a restore can be verified rather than assumed. |
| Restore | `npm run restore` (`scripts/restore-cerberus.ps1`) | Refuses a non-empty target and a target equal to the source, then verifies counts and critical indexes against the manifest. |
| Bench | `npm run bench` (`scripts/bench/run-bench.mjs`) | Writes measured request-handling figures; the method and one corrected artifact are in `performance-baseline.md`. |
| HTTP smoke | `scripts/verify-all.ps1` and the three `smoke-*` / `stress-*` scripts | Requires a running instance. This is a manual aid, not the automated suite. |

## 4. Correlation today, and the defect it leaves

This is the single most consequential finding in this document, because it makes
every other log line harder to use.

`apps/api/src/index.ts` installs a middleware that sets a fresh
`X-Correlation-Id: randomUUID()` on **every** response and exposes that header
through CORS. `docs/api-errors.md` §2 then promises that a body's `correlationId`
"Matches the `X-Correlation-Id` response header and the server log line".

What the routes actually do:

| Route group | Source of the `correlationId` it returns | Matches the response header? |
| --- | --- | --- |
| `routes/scenarios.ts` | `c.res.headers.get("X-Correlation-Id")` | **yes** |
| `routes/guardian.ts` | its own `randomUUID()`, one per handler | **no** |
| `routes/review.ts` | its own `randomUUID()` | **no** |
| `routes/reference.ts` | its own `randomUUID()` | **no** |
| `routes/auditor.ts` | its own `randomUUID()` | **no** |
| `routes/identity.ts` | none | — |

Consequences, all of them observable today:

1. **The documented promise is false for four of five route groups.** A client that
   reports the `correlationId` from an error body hands over a value that appears
   nowhere in the response headers and nowhere in any log line that an operator can
   key on.
2. **The MCP call logs are keyed on the route-local id.** `callMcpTool` logs
   `[mcp] [<id>] <tool> → HTTP <status> in <ms>`, using the id the route passed. That
   id is in the error body, so those lines are reachable — but they cannot be joined
   to the request as a whole, because no line records the request.
3. **There is no request log line outside dev mode.** In production
   (`config.devMode === false`) `app.use("*", logger())` is not installed, so a
   successful request produces no line at all. In dev mode the Hono logger prints
   `METHOD path status - latency` **without** the correlation id, so even there the
   two cannot be joined.
4. **Nothing records the route template.** `c.req.path` for
   `/api/v1/guardian/sessions/op-123` contains a session id. A log line built from
   the raw path therefore puts an identifier into the logs that §7 says should be
   treated carefully, and it makes every session a distinct "route" for any
   aggregation.

The fix is not "add a header". It is to make **one** identifier per request the
only one, to record it on a single request line, and to let every downstream module
read it from the ambient request context rather than mint its own. §5 and §6 are
that design; §10 records its status.

## 5. Structured logging: target design

### 5.1 Configuration

| Variable | Values | Default | Meaning |
| --- | --- | --- | --- |
| `CERBERUS_LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` | The minimum level that is emitted. |
| `CERBERUS_LOG_FORMAT` | `pretty`, `json` | `pretty` | `json` emits one JSON object per line; `pretty` emits a single human-readable line. |

An **explicitly set but unusable** value is a startup failure, not a silent
fallback. This follows `SESSION_TTL_SECONDS` and `CERBERUS_MAX_BODY_BYTES`: a typo
in a logging control must not quietly change what is recorded.

`pretty` is the default because the common case is one developer reading a
terminal. `json` is what a log shipper consumes, and it is the format the
correlation guarantees are stated against.

**No external logging vendor, and no OpenTelemetry.** The whole point of this
logger is that it is dependency-free and its behaviour is auditable in one file.
An SDK would add a transitive dependency tree, its own redaction semantics, and a
network egress path — for a self-hosted single-tenant service whose log volume is
one line per request.

### 5.2 The request log line

Exactly one line is emitted per HTTP request, after the response is produced:

| Field | Source | Notes |
| --- | --- | --- |
| `timestamp` | server clock | UTC, ISO-8601. Log timestamps are UTC even though stored telemetry timestamps keep the server's local offset (`utils/time.ts`); a log is read across machines, a telemetry record is read against its own session. |
| `level` | derived from status | `error` for 5xx, `warn` for 4xx, `info` otherwise. |
| `requestId` | §6 | The same value as the `X-Request-Id` and `X-Correlation-Id` response headers. |
| `method` | request | |
| `route` | matched route template | `/api/v1/guardian/sessions/:sessionId`, **not** the concrete path. A session id is not a route. |
| `status` | response | |
| `latencyMs` | monotonic clock | |
| `errorCode` | stable code, when one was produced | |
| `dependency` | dependency category, when the request touched one | `mcp`, `provider`, `notification` |
| `providerAttempts` | provider retry count, when a paid call ran | |
| `sessionId` | only where it is already the request's subject | A session id is an identifier of a monitored person's session; see §7. |

### 5.3 Levels, and what belongs at each

| Level | Use |
| --- | --- |
| `error` | A failure the operator must act on: an unhandled exception, a durable write that did not happen, a store that did not answer, a provider that exhausted its retries. |
| `warn` | A refusal or a degraded path that is expected to be rare: a rejected transition, a rate-limit rejection, a best-effort side effect that failed (notification, terminal-content preservation, corpus read). |
| `info` | One line per request, plus lifecycle facts an operator tracks: a status transition, a session deployed, a session deleted. |
| `debug` | Per-step detail: each MCP call and its latency, each provider attempt. Off by default, because it multiplies volume by roughly five and is only needed while tracing one problem. |

### 5.4 Structural rules

- **Bounded by construction.** The logger holds no queue and no buffer. It writes
  synchronously to `stdout`/`stderr` and returns. There is nothing that can grow
  with traffic, so there is nothing to leak.
- **Field values are redacted and bounded before serialisation.** A long string is
  truncated; a non-finite number is dropped; a nested object is walked with a depth
  cap. Logging a 5 MB telemetry body must be impossible by construction, not by
  convention.
- **`Error` objects are never serialised wholesale.** A provider or driver error
  can carry a request object, a connection string or an authorization header.
  Only `name`, a sanitised `message` and a `code` are recorded (§7.2).

## 6. Request/correlation ID: target design

### 6.1 One identifier per request

Every HTTP request gets exactly one identifier. It is:

- **generated** as a UUIDv4 when the caller supplies none;
- **accepted from `X-Request-Id`** only when it passes validation (§6.2);
- **echoed** in the `X-Request-Id` response header, and in `X-Correlation-Id`,
  which is kept because it is already an exposed CORS header and a client may
  already read it. The two headers carry the **same value**; they are not two
  identifiers;
- **recorded** on the request log line (§5.2) and on every downstream line for that
  request;
- **returned** in a structured error body's `correlationId`, so
  `api-errors.md` §2 becomes true for every route rather than one.

### 6.2 Incoming identifier validation

A caller-supplied `X-Request-Id` is untrusted input. It is accepted only when:

| Rule | Value | Why |
| --- | --- | --- |
| Maximum length | 128 characters | Bounds what one header can contribute to a log line and to any downstream store. |
| Allowed characters | `A-Z a-z 0-9 . _ : -` | Excludes whitespace, quotes and separators, so an id cannot restructure a `pretty` log line or a `json` field. |
| Control characters, newlines, `\r`, `\n`, `\t` | rejected | **Log injection.** A newline in an id forges a second log line, which is how a caller manufactures evidence. |
| Empty or all-whitespace | rejected, generated instead | An empty id is not an id. |
| Anything else | rejected, generated instead | A rejected id is replaced, never echoed, so a caller cannot learn what the validation rules are from a response and cannot smuggle a rejected value into the logs. |

A rejected identifier is **not** an error response. Replacing it is the safe
behaviour: the request proceeds with a server-generated id, and the operator sees a
valid correlation id rather than a failure caused by a header they did not know
existed. This is why there is no `INVALID_REQUEST_ID` code: a code would make an
ignored header into a client-visible failure, and no route needs to act differently.

### 6.3 The request ID is not a security control

It is **not** used for authentication, authorization, replay detection, idempotency
or rate-limit keying. It is a correlation label. A caller can choose it, so nothing
may branch on it.

### 6.4 Propagation

The identifier reaches the modules that log by **ambient request context** — an
`AsyncLocalStorage` established once per request by the middleware — rather than by
being threaded through every function signature. Two reasons:

1. **Threading it is what produced the §4 defect.** When each caller passes its own
   id, some callers pass a fresh one.
2. **Signature churn is a correctness risk.** Adding a `requestId` parameter to
   every service function is a wide, mechanical change to code that is otherwise
   correct, and a missed call site compiles fine.

An explicit `requestId` argument remains available on the MCP client and is used
where a caller genuinely has one (a probe, a script). When it is absent, the
ambient id is used. Lines that belong to no request — startup, migrations, a
readiness probe — carry a fixed, non-request label so they are never mistaken for a
request.

## 7. Secret and sensitive-field discipline

### 7.1 Never logged, under any level, by default

| Field | Why |
| --- | --- |
| `Authorization` header, in any spelling | It carries the operator key or the MCP token. |
| `X-API-Key`, `X-Session-Token`, `X-Generation-Request-Id` values | The first two are credentials; the third is a client-chosen id with no logging value. |
| `CERBERUS_API_KEY`, `CERBERUS_API_KEY_PREVIOUS` | Current and retiring operator credentials. |
| `CERBERUS_MCP_TOKEN`, and its retiring counterpart | Persistence-layer credentials. |
| `OPENAI_API_KEY` | Billable provider credential. |
| `MONGODB_URI` when it carries credentials | A connection string with a userinfo section is a password. |
| `SLACK_WEBHOOK_URL`, `SENDGRID_API_KEY` | A webhook URL is itself a credential: anyone holding it can post. |
| Full telemetry bodies | `micro_events` payloads carry keystroke characters, paste content and copied text. |
| `currentCode`, `terminalContent`, `codeSnapshot` | The reconstructed workspace, which is the most sensitive artefact in the system. |
| Full provider prompts and responses | They contain the workspace and the paste snippets. |
| Pasted or copied content | Same. |
| Raw exception objects | §7.2. |

### 7.2 Two layers, because one is not enough

**Layer 1 — known-secret registry.** At startup every configured secret is
registered with the logger. Any log string containing one is emitted with the
secret replaced. This is the strongest guarantee available: it does not depend on
recognising the shape of the surrounding text.

**Layer 2 — pattern scrubbing.** Messages are then scrubbed for credential-shaped
content that the registry does not know about: a `mongodb://user:pass@host` URI has
its userinfo removed, a `Bearer <token>` has its token removed, and a provider-style
`sk-…` key is replaced. This catches a value that reached a log through a path
nobody registered — a driver error quoting a URI, for instance.

Layer 2 exists because layer 1 only knows what configuration told it. Layer 1
exists because layer 2 can only recognise shapes it has been taught. Neither is
sufficient alone, and the test suite asserts both.

### 7.3 Retention and scope

Cerberus does not ship, store, rotate or expire logs. It writes to `stdout` and
`stderr`. Retention, access control, shipping and the legal basis for keeping
request metadata belong entirely to the deployer. **Structured logs do not imply
compliance**, and nothing in this document should be quoted as an audit-trail
guarantee. See `security/threat-model.md` §10.

## 8. Operational diagnostics

### 8.1 Is the process alive?

`GET /health`. Always `200` while the process answers HTTP. It checks nothing, by
design — see §3.1.

### 8.2 Can it serve?

`GET /ready`. `200` when the persistence layer answers, `503` when it does not, with
a `dependencies` array naming each dependency, its `state` and a one-line `detail`.

### 8.3 Which dependency is failing?

The `dependencies` array in `/ready`, plus the dependency category on the request
log line (§5.2). `/ready` distinguishes a dependency that is *unreachable* from one
that is *reachable but not connected to MongoDB*, because the remedies differ.

### 8.4 Did this request fail, and which request was it?

The request log line (§5.2): `status`, `errorCode`, `latencyMs`, `requestId`. The
same `requestId` is in the response headers and, for every route, in the error
body's `correlationId` — which is the property §4 identifies as broken today.

### 8.5 Was a detail served from durable storage or from memory?

`GET /api/v1/sessions/:id` serves from live memory when the store does not answer.
Today the response does **not** say which source answered. Adding that is part of
the durable-fallback work; until then, the distinction is only visible in the
request log's `dependency` field.

### 8.6 What diagnostics deliberately do not exist

- **No paid provider call in a health or readiness probe.** `/ready` asks the
  persistence layer one `health_check` question and nothing else. A probe that
  spends money is a probe that cannot be polled.
- **No liveness check of a dependency.** §3.1.
- **No metrics endpoint, no tracing, no dashboard.** Out of scope for this phase,
  and adding one would be a second observability system beside this one.

## 9. Degraded-state matrix

What each path does when its dependency is unavailable, in one table. "Report"
means the response says what did not happen; "degrade" means the request still
answers usefully.

| Path | Store unavailable | Provider unavailable | Notification unavailable |
| --- | --- | --- | --- |
| `GET /health` | unaffected | unaffected | unaffected |
| `GET /ready` | `503`, dependency `down` | unaffected | unaffected |
| `POST /identity/set`, `GET /identity/me` | unaffected (in-memory) | unaffected | unaffected |
| `POST /scenarios` | **degrade + report** — `201` with `persisted: false` | `503 AI_UNAVAILABLE`, or `503 CLASSIFIER_UNAVAILABLE` for the classifier | unaffected |
| `POST /auditor/query` | degrade — the pipeline runs against whatever `list_sessions` returned | `500 AUDITOR_QUERY_FAILED` | unaffected |
| `POST /guardian/deploy` | degrade — `201`, `mongoDocumentId: "local-only"` | unaffected | unaffected |
| `POST /guardian/ingest` | degrade + report — `telemetryPersisted: false`, counts omitted | analysis skipped, logged, telemetry still durable | logged and swallowed; ingestion is not affected |
| `terminate` / `reactivate` | `503 SESSION_STORE_UNAVAILABLE`, nothing changed | unaffected | unaffected |
| `DELETE /guardian/sessions/:id` | `503 SESSION_STORE_UNAVAILABLE`, nothing changed | unaffected | unaffected |
| `GET /guardian/sessions` | degrade — empty list rather than an error | unaffected | unaffected |
| `GET /guardian/sessions/:id` | **`404` for a session that exists** (open defect, §3.7) | unaffected | unaffected |
| `GET /sessions` | degrade — durable entries still listed from the failed-read fallback | unaffected | unaffected |
| `GET /sessions/:id` | degrade — serves from live memory when the session is in memory, else `404` | unaffected | unaffected |
| reference corpus CRUD | `503 REFERENCE_STORE_UNAVAILABLE` | unaffected | unaffected |
| corpus read during analysis | degrade — empty corpus, similarity skipped, analysis proceeds | unaffected | unaffected |

## 10. Implementation status

Recorded per item so this document cannot drift into describing a design as if it
were behaviour. Updated as the work lands.

| Design item | Status |
| --- | --- |
| §3 request-path map | **Described from source.** |
| §4 the correlation-id defect | **Open.** Confirmed against `index.ts`, `guardian.ts`, `review.ts`, `reference.ts`, `auditor.ts`. |
| §5.1 `CERBERUS_LOG_LEVEL` / `CERBERUS_LOG_FORMAT` | **Not implemented.** |
| §5.2 the request log line | **Not implemented.** |
| §5.3 level policy | **Not implemented.** |
| §5.4 structural rules | **Not implemented.** |
| §6.1 one identifier per request | **Not implemented.** |
| §6.2 incoming-id validation | **Not implemented.** |
| §6.4 ambient propagation | **Not implemented.** |
| §7.1 never-logged list | **Partially true by accident**: the current `console.*` call sites do not log secrets, but nothing enforces that, and the list is not asserted by a test. |
| §7.2 two-layer redaction | **Not implemented.** |
| §8.5 detail-source reporting | **Not implemented.** |
| §3.7 durable detail fallback | **Not implemented.** Open item D4. |
| §9 degraded-state matrix | **Described from source.** |

## 11. Related documents

- [`security/threat-model.md`](../security/threat-model.md) §10 — the logging
  threat model: what request metadata is recorded, what must not be, and why
  structured logs are not a compliance claim.
- [`api-errors.md`](../api-errors.md) — every stable code and what a client does
  with it. §2 states the `correlationId` promise that §4 of this document finds
  broken.
- [`operations/health-probes.md`](../operations/health-probes.md) — which probe
  belongs in which orchestrator slot.
- [`development/failure-semantics.md`](failure-semantics.md) — what each
  multi-step operation guarantees when a step fails.
- [`development/session-state-model.md`](session-state-model.md) — which session
  state is durable, reconstructable, ephemeral or derived.
- [`development/state-transition-model.md`](state-transition-model.md) — the
  transition table, and open items D4 and the `cleared` vocabulary.

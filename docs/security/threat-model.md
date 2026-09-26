# Threat model

Scope: the Cerberus API (`apps/api`), the MCP MongoDB adapter
(`packages/mcp-mongodb`), the Flutter console (`apps/console`) and their data at
rest in MongoDB, as shipped in version 0.1.0.

This document describes the security posture of the software as written. It is
not a claim of fitness for any particular deployment. Cerberus is not
production ready and does not guarantee that it detects or prevents anything.

## 1. Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Telemetry payloads | `micro_events`, request bodies | Keystroke characters, paste content, copied text, code deltas, terminal snapshots, user agent, IP address, screen resolution, platform, language. |
| Reconstructed terminal content | `monitored_sessions.terminalContent`, `SessionState.currentCode` | A best-effort reconstruction of what the monitored operator was working on. |
| Risk assessments | `risk_assessments`, `RiskAssessmentPayload` | Scores, flags, exfiltration matches, behavioural anomalies, paste snippets, code snapshot, incident summary. |
| Employee identifiers | `employeeId` on sessions and assessments | Names or ids of monitored people. Personal data in most jurisdictions. |
| Threat scenario matrices | `threat_scenarios` | Authored target systems, mandates, threat vectors, detection rules, penetration scenarios. Describes your defensive posture. |
| Reference corpus | `reference_documents` | Operator-supplied reference text compared against paste content. Submitted by the operator through the API; never populated by Cerberus itself. |
| Operator API key | `CERBERUS_API_KEY` | Full read and delete access to everything above. |
| MCP shared secret | `CERBERUS_MCP_TOKEN` | Full read and delete access to the persistence layer. |
| OpenAI API key | `OPENAI_API_KEY` | Billable credential; also the credential that authorises sending telemetry-derived prompts to the provider. |
| Notification credentials | `SLACK_WEBHOOK_URL`, `SENDGRID_API_KEY` | Ability to post content into a third-party channel. |
| MongoDB credentials | `MONGODB_URI` | Direct database access, bypassing Cerberus entirely. |

## 2. Actors

| Actor | Capability | Notes |
| --- | --- | --- |
| Authenticated operator | Anything the API exposes | Holds the single API key. There is exactly one privilege level. |
| Anonymous network client | `GET /health`, `GET /`; everything else receives 401 | Health exposes service name, version, uptime, timestamp and route hints. |
| Monitored operator | Controls the browser that produces telemetry | Can attempt to forge, replay, suppress or flood telemetry, and can read whatever the console sends. |
| Operator with local access to the API host | Environment variables, process memory, `.env` | Can read every secret. |
| Compromised monitored host | Same as the monitored operator, plus arbitrary code execution | Can forge any telemetry the console could have produced. |
| Third-party AI provider | Receives prompt content | Sees terminal content, paste snippets and keystroke metrics included in prompts. |
| Notification provider | Receives alert content | Sees employee id, risk score, session id, summary and flag types. |
| Network attacker | Off-path or on-path | Relevant only if TLS is absent or terminated incorrectly. |

There is no administrator role, no auditor role, no read-only role and no
per-user account. Authorization is binary.

## 3. Trust boundaries

```text
  [ untrusted ]                [ trusted: self-hosted ]                [ external ]
 ┌───────────────┐   key    ┌───────────────────────────┐   key    ┌──────────────┐
 │ console /     │─────────▶│ Cerberus API              │─────────▶│ OpenAI       │
 │ any client    │          │ session state, secrets    │          └──────────────┘
 └───────────────┘          └────────────┬──────────────┘
                                         │ MCP bearer token
                                         ▼
                            ┌───────────────────────────┐   conn str  ┌──────────────┐
                            │ MCP HTTP adapter          │────────────▶│ MongoDB      │
                            │ (loopback by default)     │             └──────────────┘
                            └───────────────────────────┘
```

1. **Client → API.** Crossed with a pre-shared key. Everything in the body is
   untrusted and shape-validated per route.
2. **API → OpenAI.** Crossed with the provider API key. The response is
   untrusted text and is parsed defensively.
3. **API → MCP adapter.** Crossed with `CERBERUS_MCP_TOKEN`.
4. **MCP adapter → MongoDB.** Crossed with whatever `MONGODB_URI` carries. This
   boundary is entirely the deployer's responsibility.
5. **API/MCP → notification providers.** Crossed with webhook URL and API key.
   Outbound only.

## 4. The API-key model

Cerberus ships exactly two principals: **authenticated operator** and
**anonymous**. This is stated in `apps/api/src/middleware/auth.ts`.

How it works:

- One key, from `CERBERUS_API_KEY`, held in process memory for the lifetime of
  the process.
- Presented as `Authorization: Bearer <key>` (matched
  case-insensitively as `Bearer`) or as `X-API-Key: <key>`. `Authorization`
  takes priority when both are present.
- Compared with `crypto.timingSafeEqual`. Length mismatch is handled by
  comparing the supplied value against a same-length zero buffer, so the
  rejection path does not short-circuit on length. Empty supplied or expected
  values always return false.
- The missing-credential and wrong-credential responses are byte-identical:
  HTTP 401 with `{ success: false, error: "Authentication required.", code:
  "UNAUTHENTICATED" }`. Neither response echoes the supplied or expected value.
- `GET /health` and `GET /` bypass the check (`PUBLIC_PATHS`).
- `CERBERUS_DEV_MODE=true` bypasses the check for **every** route, logging a
  warning the first time.

The MCP adapter uses the same construction with `CERBERUS_MCP_TOKEN`, accepting
only `Authorization: Bearer <token>`. Its `GET /health` is also unauthenticated
so container orchestrators can probe it.

### What the key model does protect against

- Unauthenticated use of the API or the MCP adapter.
- Credential guessing via timing side channels on the comparison itself.
- Information disclosure through authentication error messages.
- Accidental unauthenticated boot: a missing `CERBERUS_API_KEY` or
  `CERBERUS_MCP_TOKEN` is a startup failure, not a warning.
- Accidental dev-mode deployment: `CERBERUS_DEV_MODE=true` with
  `NODE_ENV=production` is refused at startup.

### What it does not protect against

- **A compromised host.** If an attacker has code execution or read access on
  the machine running the API or the MCP adapter, they can read
  `CERBERUS_API_KEY`, `CERBERUS_MCP_TOKEN`, `OPENAI_API_KEY`, the MongoDB
  connection string and all live session state. No part of Cerberus defends this
  boundary.
- **No per-user attribution.** Every action taken with the key is
  indistinguishable from every other action taken with the key. The identity
  registry (`apps/api/src/routes/identity.ts`) records a display name, but it is
  explicitly not an authentication mechanism, and the handle it returns is an
  opaque per-process token that is not accepted as a credential anywhere.
- **No replay protection beyond TLS.** A captured request can be replayed while
  the key is valid. There is no nonce, timestamp window, request signing or
  idempotency key on the API surface.
- **Telemetry has durable *retry idempotency*, which is not replay protection.**
  `micro_events` carries a unique index on `(sessionId, eventId)` and the store
  reports which events were newly inserted, so a batch retried after a network
  ambiguity is stored and counted once — including across a restart. But the
  **monitored client supplies `eventId`**, so a client that wants to re-send
  content sends a fresh one and the event is accepted. This protects against
  retries and duplicates, not against a hostile telemetry producer. The
  content-fingerprint ring is scoped to content-bearing events and is a cache in
  front of the durable identity, not a control.
- **Rotation needs an overlap window, and now has one.** Set
  `CERBERUS_API_KEY_PREVIOUS` (and `CERBERUS_MCP_TOKEN_PREVIOUS` for the sidecar)
  to the value being retired, restart, move every client across, then unset it and
  restart again. Both comparisons always run, so the response time does not reveal
  which key matched, and neither key is ever logged. There is still **no key
  identity, no revocation list and no rotation tooling**: ending the overlap is the
  revocation, and there is no way to revoke one key without revoking the others.
  See [operations/key-rotation.md](../operations/key-rotation.md).
- **Rate limiting is a backstop, not DDoS defence.** In-process token buckets bound
  the total request rate per route category, applied **after** authentication. The
  AI-backed endpoints are the tightest (`CERBERUS_AI_REQUESTS_PER_MINUTE`, default
  10/min) because every request there spends money. Three things it deliberately
  does not do: it does **not** limit unauthenticated requests — a limiter before
  auth would let an anonymous caller exhaust a bucket and deny service to the
  operator, turning a backstop into a denial-of-service amplifier; it does **not**
  key on the caller, because there is one shared key and therefore no caller to key
  on; and it does **not** share state, so N replicas enforce up to N times the
  limit. It also never reads `X-Forwarded-For`, which is caller-controlled behind a
  proxy. Per-caller and unauthenticated limiting belong at the reverse proxy — see
  [operations/reverse-proxy.md](../operations/reverse-proxy.md).
- **No brute-force lockout or alerting.** Failed authentications are not counted
  or surfaced.
- **No authorization.** Any authenticated caller can read every session, delete
  any session, and author scenarios.
- **No encryption of telemetry at rest** by Cerberus. It writes what MongoDB is
  configured to accept.

## 5. CORS posture

- The API applies an explicit allow-list. With `CERBERUS_CORS_ORIGINS` empty and
  dev mode off, **no cross-origin access is granted**; an unlisted origin
  receives no `Access-Control-Allow-Origin` header.
- With dev mode on and no explicit list, a fixed localhost list is substituted
  (ports 8080 and 5173 on `localhost` and `127.0.0.1`).
- Allowed methods: `GET`, `POST`, `DELETE`, `OPTIONS`. Allowed headers:
  `Content-Type`, `Authorization`, `X-API-Key`, `X-Session-Token`,
  `X-Generation-Request-Id`. Exposed header: `X-Correlation-Id`. Preflight
  results are cached for 86400 seconds.
- The MCP adapter emits **no CORS headers at all** unless
  `CERBERUS_MCP_CORS_ORIGINS` is set, because it is a server-to-server
  interface. When set, it echoes the request origin only if it is on the list,
  and sets `Vary: Origin`.
- CORS is a browser-enforced control. It limits which pages can read responses
  from a browser. It does not constrain non-browser clients, which is why the
  API key remains load-bearing. Do not treat a restrictive CORS list as an
  authorization boundary.

## 6. Fail-closed behaviours

These are the places where the code chooses to refuse rather than proceed:

| Behaviour | Where | Result |
| --- | --- | --- |
| Missing mandatory secret | `loadConfig()` in `apps/api/src/config.ts` | `ConfigError`, process exits 1. `OPENAI_API_KEY` is always required; `CERBERUS_API_KEY` and `CERBERUS_MCP_TOKEN` are required unless dev mode is on. |
| Dev mode under `NODE_ENV=production` | `loadConfig()` | `ConfigError`, process exits 1. |
| Missing MCP token outside dev mode | `packages/mcp-mongodb/src/http-adapter.ts` | Prints a fatal message and exits 1. |
| Missing API key in the container entrypoint | `scripts/entrypoint.sh` | Exits 1 when `NODE_ENV=production` and `CERBERUS_API_KEY` is unset. |
| Scenario classifier unavailable | `apps/api/src/routes/scenarios.ts` | HTTP 503 `CLASSIFIER_UNAVAILABLE`. The request is **not** admitted without validation. |
| Classifier output unparseable | `parseScenarioClassifierVerdict()` in `apps/api/src/ai/parsers.ts` | Returns `isAppropriate: false` with a `PARSE_ERROR` flag, which `evaluateVerdict()` rejects. |
| Deterministic pre-filter rejection | `runPreFilter()` in `apps/api/src/routes/scenarios.ts` | HTTP 422 before any inference is spent. |
| Unlisted CORS origin | `apps/api/src/index.ts` | No `Access-Control-Allow-Origin` header returned. |
| Unknown MCP tool name | `packages/mcp-mongodb/src/http-adapter.ts` | HTTP 404 with the list of tools that do exist. |
| Invalid `set_session_status` value | `packages/mcp-mongodb/src/tools.ts` | `ToolArgumentError`, HTTP 400. |
| Oversized MCP request body | `parseBody()` in `packages/mcp-mongodb/src/body.ts` | HTTP 413 `PAYLOAD_TOO_LARGE` with `Connection: close`. The parser always settles, so the handler answers instead of hanging, and an oversized body is distinguishable from a missing one. |
| Malformed MCP request body | `parseBody()` in `packages/mcp-mongodb/src/body.ts` | HTTP 400 `INVALID_JSON` for unparseable input, `INVALID_BODY` for a JSON value that is not an object. Both previously resolved to `{}` and surfaced as a misleading "Missing required parameter". |
| Unhandled API error | `app.onError` in `apps/api/src/index.ts` | Generic HTTP 500 with a correlation id. Framework and provider internals are logged server-side, never returned. |
| Missing/invalid credential | `apps/api/src/middleware/auth.ts` | HTTP 401, identical for both cases. |
| Invalid `SESSION_TTL_SECONDS` | `loadConfig()` in `apps/api/src/config.ts` | `ConfigError`, process exits 1. Must be a positive whole number of seconds, so a misconfigured monitoring window cannot be silently replaced by a default. |
| Telemetry for an expired session | `apps/api/src/routes/guardian.ts` | HTTP 409 `SESSION_EXPIRED`. The batch is not persisted and the monitoring window is not extended. |
| Reactivating a terminated session | `apps/api/src/routes/guardian.ts` | HTTP 409 `SESSION_TERMINATED`. Termination is not reversible, so reactivation cannot resurrect a session that was deliberately stopped. |
| Oversized API request body | `body-limit` middleware in `apps/api/src/index.ts` | HTTP 413 `PAYLOAD_TOO_LARGE` before the body is buffered. Runs ahead of the auth middleware, so it applies to authenticated and unauthenticated callers alike. |
| Over-long `prompt` or `roleContext` | `apps/api/src/routes/scenarios.ts` | HTTP 400 before any inference is spent. |
| Over-long auditor `question` | `apps/api/src/routes/auditor.ts` | HTTP 400 before any inference is spent. |
| Over-sized telemetry batch | `apps/api/src/routes/guardian.ts` | HTTP 400 `BATCH_TOO_LARGE`; nothing reaches the persistence layer. |
| Auditor result set above the ceiling | `apps/api/src/routes/auditor.ts` | Truncated to 200 records whatever pipeline the model produced, so a pipeline with no `$limit` cannot pass every session to the provider. |
| Non-string or over-long identity field | `apps/api/src/routes/identity.ts` | HTTP 400 `INVALID_IDENTITY_FIELD`. |
| Model-supplied score or confidence out of range | `parseRiskAssessment()` / `parseRiskDimensions()` / `parseRiskFlag()` in `apps/api/src/ai/parsers.ts` | Clamped to the documented range (0-100 for scores, 0-1 for confidences) rather than accepted as-is. A well-formed but absurd value cannot corrupt a threshold comparison. |
| Model-supplied array or text field oversized | `boundedArray()` / `bounded()` in `apps/api/src/ai/parsers.ts` | Arrays capped at 50 entries, free text at 2 000 characters, identifiers at 200, `subMandates` recursion depth-limited to 5. Non-object entries are dropped rather than coerced. |
| Non-finite composed risk score | `clampScore()` in `apps/api/src/routes/guardian.ts` | Coerced to 0 rather than `NaN`, so a bad blend cannot silently disable the auto-lock by making every comparison false. |
| Outbound notification that never answers | `notifySlack()` / `sendEmail()` in `apps/api/src/services/notifications.ts` | Abandoned after 5 000 ms and logged as a timeout. Ingestion awaits both, so the deadline is what bounds the ingest request's latency. |
| Operator handle past its lifetime | `GET /api/v1/identity/me` in `apps/api/src/routes/identity.ts` | HTTP 401 "Unknown or expired operator handle", and the entry is dropped. Handles expire after 12 hours. |
| Operator identity registry at its ceiling | `evictIdentities()` in `apps/api/src/routes/identity.ts` | Expired handles are reclaimed, then the oldest handle is evicted, so the in-memory registry cannot grow without bound. |
| Model output the recovery ladder cannot read | `parseJsonLoose()` in `apps/api/src/ai/parsers.ts` | Throws; every caller either fails closed (the scenario classifier rejects) or degrades to an empty result (the auditor pipeline, risk assessment, recommended actions). |
| Retry fatality | `isFatal()` in `apps/api/src/ai/provider.ts` | Classified from the SDK error's HTTP status and `code`, never from message text, so an unrelated error containing `401` cannot exhaust the retry budget. |

Deliberate **fail-open** behaviours, for completeness:

- AI risk analysis failure during ingestion is logged and swallowed. The request
  still returns success, because the telemetry has already been persisted. A
  persistent provider outage therefore means telemetry keeps accumulating
  without risk scoring.
- MCP persistence failures in the scenario route are logged and swallowed; the
  matrix is returned to the caller with `persisted: false`.
- Notification failures are logged and swallowed, and every call carries a
  5 000 ms deadline. Ingestion awaits both channels before returning, so the
  deadline is what keeps a hung webhook from stalling telemetry collection.
- All MCP calls from the API resolve `{ ok: false }` rather than throwing, and
  callers degrade rather than fail.

## 7. Data protection considerations

- Telemetry is designed to capture content: `codeSnapshot`, `pasteSnippets`,
  `copyContent`, `selectedText` and `terminalSnapshot` may contain secrets,
  customer data or third-party material. There is no redaction, scrubbing or
  field-level encryption in the codebase.
- Client metadata captured per event includes `userAgent`, `ipAddress`,
  `screenResolution`, `platform` and `language`.
- Timestamps are generated with the server's local timezone offset
  (`apps/api/src/utils/time.ts`) rather than UTC, which makes records easier to
  read but means stored timestamps depend on server configuration.
- Deleting a session cascades to its micro-events and risk assessments
  (`delete_session`). Terminating a session does not delete anything.
  `SESSION_TTL_SECONDS` bounds **active-liveness only**: once a session's
  monitoring window closes it stops being monitored, is excluded from the live
  list and refuses new telemetry, but every document is retained indefinitely.
  There is no retention policy, no TTL index and no automatic deletion of
  historical evidence. See
  [configuration.md](../configuration.md#session-lifetime-session_ttl_seconds).
- The activity timestamp that drives expiry is always server-generated. The
  client-supplied `MicroEvent.timestamp` is recorded and displayed but is
  deliberately not an expiry input, so a monitored client cannot hold its own
  monitoring window open with a forged timestamp. A replayed batch is
  deduplicated before the activity stamp is refreshed, so replay cannot extend
  the window either.
- Prompt content — terminal content, paste snippets, keystroke metrics — is sent
  to the configured AI provider on every analysed batch. Pointing
  `OPENAI_BASE_URL` elsewhere sends it elsewhere.

## 8. Operator-facing limitations

State these plainly to anyone who will run this:

1. Not production ready. No guarantee of detection or prevention.
2. Single-tenant, single shared key. No accounts, roles, OAuth, SSO, billing or
   multi-tenancy.
3. Session state is in memory and is lost on restart. MongoDB is the durable
   fallback.
4. Exfiltration similarity is a local, deterministic phrase-overlap comparison
   against an operator-managed reference corpus. It is not plagiarism detection,
   it does not establish that anything was copied, and it says nothing about
   intent. The corpus is never populated by Cerberus itself — every entry is
   submitted by the operator.
5. The endpoint agent that would emit telemetry is not built. Telemetry comes
   from the console/browser.
6. No endpoint `.exe` agent, no SaaS, no enterprise features.
7. Deploying this against employees has legal and ethical implications
   (consent, works councils, data-protection law) that the software does not
   address.

## 8a. What the architecture-integrity cycle changed here

Recorded because a threat model that does not move when the code does is a document, not a
model. The full record is in
[development/architecture-integrity-checkpoint.md](../development/architecture-integrity-checkpoint.md).

| Change | Effect on this model |
| --- | --- |
| **A terminated session is now terminal.** Ingest refuses one, and the transition table has no transition out of `terminated` | Strengthens the one irreversible lifecycle guarantee the system claims. Before, a caller holding the operator key could silently un-do a termination by sending a high-risk batch |
| **The status write is a compare-and-set, and its result is inspected** | A concurrent transition is detected and reported rather than overwritten. This is a correctness property, not a security one, but it removes a way two operators' intentions could silently collide |
| **A terminated session leaves the live session list** | The list no longer reports a session as live when it is not |
| **The focus-loss counter is named for what it measures** | Vocabulary only. **No score moves**, so no operator threshold changes meaning |
| **The reference-corpus ceiling is enforced at the store** | The ceiling was a read ceiling, so a 201st document was stored and then excluded from every comparison. That was a **detection gap**, not a storage one: an operator who added a document and saw it accepted would reasonably believe it was being compared against |
| **Durable identity for risk assessments** | A re-analysis of one incident stores one row, so a review surface cannot double-count |
| **Durable evidence is written before the side effects that depend on it** | A lock can no longer exist without the assessment that justifies it, and a notification can no longer describe an incident with no review record. This matters for **reviewability**: an operator challenging a lock can always find its basis |
| **The console words errors from the stable `code`, not the server's prose** | The console's operator-facing text no longer depends on API wording, and no internal identifier or stack is surfaced |

**Unchanged, deliberately.** No new data category is collected. Telemetry still originates
only from the browser console. There is still no endpoint agent, no filesystem or process
collection, no screenshots, no clipboard monitoring beyond the console's existing explicit
semantics, and no packet inspection. The advisory posture is unchanged: a risk score is a
signal for a human reviewer, never a finding of intent.

**Two limitations this cycle did not close**, both stated in the checkpoint rather than
implied: rate limiting remains a per-process backstop, and the two paid routes remain
non-idempotent, so a retry after a lost response re-spends. The condition that would change
the latter is named in [api-errors.md](../api-errors.md) §11.1.

## 9. Reporting a vulnerability

See [SECURITY.md](../../SECURITY.md) at the repository root for the private
reporting process, scope, and expected response times. Do not open a public
issue for a security problem.
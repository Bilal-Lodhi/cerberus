# Configuration

Cerberus is configured entirely through environment variables. There is no
config file format and no runtime settings endpoint.

The API reads configuration once at startup in `apps/api/src/config.ts`
(`loadConfig()`). If a mandatory variable is missing the process prints a
`ConfigError` and exits with code 1 — it never boots into an
unauthenticated or half-configured state. The MCP HTTP adapter reads its own
subset at module load in `packages/mcp-mongodb/src/http-adapter.ts` and does the
same.

Both local launchers (`scripts/dev-services.js`, `scripts/start-services.js`)
load the repository-root `.env` file with `dotenv`. The API also imports
`dotenv/config` directly, so a plain `node dist/index.js` picks up `.env` from
the working directory.

## 1. Server

| Variable | Type | Default | Required | Notes |
| --- | --- | --- | --- | --- |
| `PORT` | integer | `8080` | No | API listen port. A non-numeric value silently falls back to the default. |
| `CERBERUS_MAX_BODY_BYTES` | positive integer (bytes) | `8388608` (8 MiB) | No | Maximum accepted request body size. Enforced before the body is buffered, for authenticated and unauthenticated callers alike. Must be a positive whole number of bytes or the process exits with a `ConfigError`. |
| `CERBERUS_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` | `info` | No | Minimum level emitted. Matched case-insensitively. An unrecognised value is a startup `ConfigError`, not a silent fallback: a typo in a logging control must not quietly change what is recorded. |
| `CERBERUS_LOG_FORMAT` | `pretty` \| `json` | `pretty` | No | `pretty` renders one human-readable line per record; `json` emits one JSON object per line, which is what a log shipper consumes. Same fail-closed validation as the level. |

### Structured logging

Cerberus writes one line per HTTP request, plus lifecycle and failure lines, to
`stdout` (debug, info) and `stderr` (warn, error). The design, the field list and the
never-recorded list are in
[development/operability-model.md](development/operability-model.md) §5–§7, and the
security properties are in [security/threat-model.md](security/threat-model.md) §9.

Two things an operator should know before turning the level up or shipping the output:

- **`debug` is per-step detail.** It adds one line per MCP call and one per provider
  attempt, which multiplies volume by roughly five. It is for tracing one problem, not
  for a permanent setting.
- **Cerberus does not ship, store, rotate or expire logs.** Retention, access control
  and the legal basis for keeping request metadata belong to the deployer. A session id
  is personal data in most jurisdictions, which is why the recorded set is deliberately
  small — see `operability-model.md` §5.2. **Structured logs are not a compliance
  claim.**

Every configured secret is registered with the redactor at startup, so a credential
that reaches a log line through any path — a driver error quoting a connection string,
a provider error quoting a key — is replaced rather than printed. That guarantee is
asserted by `apps/api/test/logging-secrets.test.ts`, which drives real requests at
`debug` and asserts the absence of every listed value.

Security note: the API listens on all interfaces; `PORT` is the only control
over where it is reachable. Bind restrictions are the job of the container
runtime, firewall or reverse proxy.

`CERBERUS_MAX_BODY_BYTES` is a request-buffering bound, not a retention policy:
an oversized request is refused with HTTP 413 and code `PAYLOAD_TOO_LARGE`, and
nothing is truncated. It is applied before the authentication middleware, so an
oversized body is rejected without being read into memory whether or not the
caller holds a credential.

**Both the API and the MCP adapter read this same variable**, so the two ceilings
cannot drift apart: a request the API admits cannot be rejected by the adapter for
size. The API validates it fail-closed at startup; the adapter, which can be run
standalone, falls back to the 8 MiB default for an unusable value and logs the
value it is actually using. Both refuse an oversized body with HTTP 413 and close
the connection, because the unread remainder cannot be drained.

Per-field caps sit below this and are not configurable, because they bound what
reaches a paid provider rather than what the process buffers:

| Field | Cap | Endpoint |
| --- | --- | --- |
| `prompt` | 8 000 characters | `POST /api/v1/scenarios` |
| `roleContext` | 200 characters | `POST /api/v1/scenarios` |
| `question` | 2 000 characters | `POST /api/v1/auditor/query` |
| `events` | 1 000 entries per batch | `POST /api/v1/guardian/ingest` |
| `displayName`, `employeeId`, `role`, `department` | 200 characters each | `POST /api/v1/identity/set` |

The auditor also caps its result set at 200 records regardless of what pipeline
the model produces, so a pipeline without a `$limit` cannot pass every session to
the provider.

## 2. AI provider

| Variable | Type | Default | Required | Notes |
| --- | --- | --- | --- | --- |
| `OPENAI_API_KEY` | string (secret) | — | **Yes, always** | Required even in dev mode. The API refuses to start without it. |
| `OPENAI_MODEL_NAME` | string | `gpt-5.6` | No | Model id passed to Chat Completions. |
| `OPENAI_MAX_OUTPUT_TOKENS` | integer | `65536` | No | Sent as `max_completion_tokens`. |
| `OPENAI_TEMPERATURE` | float | unset | No | Optional sampling temperature (0-2). When unset, the parameter is omitted from the request entirely and the model uses its own default. Set it only if your model accepts a custom value: `gpt-5.6` rejects anything other than its default with HTTP 400. |
| `OPENAI_REQUEST_TIMEOUT_MS` | integer | `180000` | No | Per-attempt SDK timeout. Retries use exponential backoff with jitter, up to 3 attempts, and never retry 401/403, `invalid_api_key` or `insufficient_quota`. 180s rather than 90s because a multi-vector scenario matrix routinely takes longer than 90s to generate on current models. |
| `OPENAI_BASE_URL` | string (URL) | unset | No | Overrides the API base URL. Intended for a proxy or self-hosted gateway. |

Security notes:

- `OPENAI_API_KEY` is a billable credential. Nothing in the codebase logs it —
  the startup banner prints only `set` or `unset`.
- Pointing `OPENAI_BASE_URL` at a third-party gateway sends telemetry-derived
  prompt content (terminal content, paste snippets, keystroke metrics) to that
  endpoint. Treat it as a data-processing decision, not a performance knob.
- `OPENAI_MAX_OUTPUT_TOKENS` defaults to a large value; it is the main lever on
  cost per scenario-authoring call.

## 3. MongoDB and MCP

| Variable | Type | Default | Required | Notes |
| --- | --- | --- | --- | --- |
| `MONGODB_URI` | string (connection string) | `mongodb://localhost:27017` | No | Read by the MCP server only. The API has no direct database access. |
| `MONGODB_DATABASE` | string | `cerberus` | No | Database name. |
| `MCP_SERVER_ENDPOINT` | string (URL) | `http://localhost:3001` | No | Where the API finds the MCP HTTP adapter. |
| `MCP_PORT` | integer | `3001` | No | MCP adapter listen port. |
| `MCP_BIND_HOST` | string | `127.0.0.1` | No | MCP adapter bind address. |
| `MCP_TIMEOUT_MS` | integer | `10000` | No | Default MCP call timeout. Route-level callers pass `5000` ms explicitly, so this only applies to calls that do not override it. |

Security notes:

- `MCP_BIND_HOST` defaults to loopback on purpose: the adapter has no
  authorization roles, only a shared bearer token. Binding it to `0.0.0.0`
  exposes an interface that can read and delete session data to anything that
  can reach the port.
- `MONGODB_URI` frequently embeds credentials. Keep it out of committed files;
  `.gitignore` excludes `.env`, `*.pem` and `*.key` for this reason.
- Cerberus does not configure MongoDB authentication, TLS or network policy. If
  the connection string does not require TLS, traffic to MongoDB is plaintext.

## 4. Authentication

| Variable | Type | Default | Required | Notes |
| --- | --- | --- | --- | --- |
| `CERBERUS_API_KEY` | string (secret) | — | **Yes**, unless `CERBERUS_DEV_MODE=true` | The operator API key. Accepted as `Authorization: Bearer <key>` or `X-API-Key: <key>`. |
| `CERBERUS_API_KEY_PREVIOUS` | string (secret) | unset | No | The key being retired, accepted alongside the current one during a rotation. Requires `CERBERUS_API_KEY`. |
| `CERBERUS_MCP_TOKEN` | string (secret) | — | **Yes**, unless `CERBERUS_DEV_MODE=true` | Bearer token the API presents to the MCP adapter. |
| `CERBERUS_MCP_TOKEN_PREVIOUS` | string (secret) | unset | No | The MCP token being retired, accepted during a rotation. Read by both the API and the adapter. |
| `CERBERUS_DEV_MODE` | boolean | `false` | No | `true`, `1`, `yes` or `on` enable it. |
| `CERBERUS_RATE_LIMIT_ENABLED` | boolean | `true` | No | In-process token-bucket limiting. An unrecognised value is a startup error rather than a silent `false`, so a typo cannot turn the control off. |
| `CERBERUS_AI_REQUESTS_PER_MINUTE` | positive integer | `10` | No | Ceiling on the AI-backed endpoints (`POST /api/v1/scenarios`, `POST /api/v1/auditor/query`). |

### Rate limiting

Token buckets, one per **route category**, applied **after** authentication.

| Category | Default | Routes |
| --- | --- | --- |
| `ai` | `CERBERUS_AI_REQUESTS_PER_MINUTE` (10/min) | `POST /api/v1/scenarios`, `POST /api/v1/auditor/query` |
| `ingest` | 600/min | `POST /api/v1/guardian/ingest` |
| `mutation` | 60/min | State changes: corpus mutation, identity registration, session lifecycle |
| `read` | 300/min | Reads |
| — | exempt | `GET /health`, `GET /ready`, `GET /` |

A refused request is `429` with code `RATE_LIMITED`, a `Retry-After` header, and
`X-RateLimit-Limit` / `X-RateLimit-Remaining` on every response.

Only the `ai` ceiling is configurable. Every request there spends money, so it is a
cost control as much as an abuse control; the others are backstops whose values are
constants with a stated rationale rather than five more variables to get wrong.

Four properties are deliberate, and each is a decision rather than an omission:

- **After authentication.** A limiter placed before auth would let an unauthenticated
  caller exhaust a category's bucket and deny service to the legitimate operator —
  a backstop turned into a denial-of-service amplifier. Unauthenticated throttling
  belongs at the reverse proxy; see
  [operations/reverse-proxy.md](operations/reverse-proxy.md).
- **Keyed by category, not by caller.** There is one shared key and no per-caller
  identity, so there is no caller to key on. The limiter bounds the **total** rate
  per category. Per-caller limits need the proxy.
- **`X-Forwarded-For` is never read.** Behind a proxy it is caller-controlled unless
  the proxy overwrites it; trusting it would let a caller mint a fresh bucket per
  request.
- **Per process.** N replicas enforce up to N times the limit. A global ceiling needs
  a shared store, which means Redis, which the baseline does not require.

Memory is bounded by construction: one bucket per category, so nothing grows with
traffic and there is nothing to evict.

Security notes:

- One key, one tenant, no roles. Every authenticated caller is "the operator".
  See [security/threat-model.md](security/threat-model.md).
- Comparison is constant-time (`crypto.timingSafeEqual` in
  `apps/api/src/middleware/auth.ts` and in the MCP adapter). Empty values never
  match, so an unset expected key cannot be satisfied by a missing credential.
  The 401 response is identical whether the credential was absent or wrong.
- **When a previous key is configured, both comparisons always run.** Short-
  circuiting on the first match would make the response time depend on *which* key
  matched, which would let a caller holding a retired key tell "retired but still
  accepted" from "not accepted at all". Neither key is ever logged; the startup
  banner reports only `set` or `unset`.
- A previous key set **without** a current key is a startup `ConfigError`. An
  overlap is not a replacement, and a deployment authenticating only against the
  credential it is retiring is not a state worth supporting. A previous key equal
  to the current one is accepted with a warning — it is a no-op, and the warning
  tells an operator the rotation is already finished.
- Rotation is a four-step overlap, not a hard cutover. The full procedure, and
  what an overlap does not do, is in
  [operations/key-rotation.md](operations/key-rotation.md). There is still no key
  identity and no revocation list: ending the overlap *is* the revocation.
- `CERBERUS_DEV_MODE=true` **disables authentication entirely** on both the API
  and the MCP adapter, and substitutes a fixed localhost CORS allow-list.
  Nothing else about the request is validated differently. The API logs a
  warning the first time it admits an unauthenticated request.

### `CERBERUS_DEV_MODE` and `NODE_ENV=production`

`CERBERUS_DEV_MODE=true` is **refused** when `NODE_ENV=production`:

```text
CERBERUS_DEV_MODE=true is refused while NODE_ENV=production. Development mode
disables authentication and must never be enabled in production.
```

The process exits with code 1 and never listens. `scripts/entrypoint.sh`
independently refuses to start when `NODE_ENV=production` and
`CERBERUS_API_KEY` is unset.

## 5. CORS

| Variable | Type | Default | Required | Notes |
| --- | --- | --- | --- | --- |
| `CERBERUS_CORS_ORIGINS` | comma-separated origins | empty | No | API allow-list. Empty entries are dropped. |
| `CERBERUS_MCP_CORS_ORIGINS` | comma-separated origins | empty | No | MCP adapter allow-list. |

Resolution rules for the API, in order:

1. If `CERBERUS_CORS_ORIGINS` is non-empty, that list is used verbatim.
2. Otherwise, if `CERBERUS_DEV_MODE=true`, a fixed development list is used:
   `http://localhost:8080`, `http://127.0.0.1:8080`,
   `http://localhost:5173`, `http://127.0.0.1:5173`.
3. Otherwise the allow-list is empty and **no cross-origin access is granted**.

An origin not on the list receives no `Access-Control-Allow-Origin` header. The
API allows the methods `GET`, `POST`, `DELETE`, `OPTIONS` and the headers
`Content-Type`, `Authorization`, `X-API-Key`, `X-Session-Token`,
`X-Generation-Request-Id`, `X-Request-Id`, and exposes `X-Request-Id` and
`X-Correlation-Id` — which carry the **same value**, because there is one
identifier per request. See
[development/operability-model.md](development/operability-model.md) §6.

Security notes: CORS is a browser control, not an authorization control. It
prevents a page on another origin from reading responses; it does not stop a
non-browser client, which is why the API key still matters. The MCP adapter
emits no CORS headers at all when its list is empty, because it is a
server-to-server interface.

## 6. Detection thresholds

| Variable | Type | Default | Required | Notes |
| --- | --- | --- | --- | --- |
| `SESSION_TTL_SECONDS` | positive integer (seconds) | `7200` | No | Enforced session lifetime. See [Session lifetime](#session-lifetime-session_ttl_seconds) below. |
| `MAX_PASTE_EVENTS` | integer | `5` | No | Paste count above which risk analysis is forced. |
| `MIN_HUMAN_KEYSTROKE_MS` | integer | `80` | No | Inter-key delay treated as the human floor. |
| `DATA_LEAKAGE_SIMILARITY_THRESHOLD` | float (0–1) | `0.75` | No | Enforced similarity threshold for exfiltration matching. Must be a number between 0 and 1 or the process exits with a `ConfigError`; above 1 could never be reached, so it would silently disable the matcher. See [the reference corpus](#reference-corpus-data_leakage_similarity_threshold) below. |

### Session lifetime (`SESSION_TTL_SECONDS`)

This is the only threshold whose misconfiguration stops the process. When the
variable is set it must be a positive whole number of seconds; `0`, `-1`, `1.5`,
`1e3`, `7200abc` and `abc` all raise a `ConfigError` and exit with code 1. When
it is unset the default of `7200` applies. Silently reading `1.5` as `1`, or
falling back to a default the operator did not choose, would decide how long a
monitored person is observed on the strength of a typo.

**The TTL defines active-liveness, not evidence retention.** It answers one
question: is this session still being monitored? Expiry is computed on every
read from the session's activity timestamp and this value
(`apps/api/src/services/session-liveness.ts`). It is deliberately not a persisted
status, so no background sweep is needed and the durable status vocabulary stays
`active | locked | terminated`.

An expired session:

- is excluded from `GET /api/v1/guardian/sessions`, the live list;
- is not restored as live by a restart, even when its durable status is still
  `active` or `locked`;
- refuses new telemetry with HTTP 409 and code `SESSION_EXPIRED`, so a
  monitoring window cannot be extended indefinitely simply by continuing to emit
  events;
- can be reopened explicitly with
  `POST /api/v1/guardian/sessions/<sessionId>/reactivate`, which sets the status
  back to `active` and restarts the window. A `terminated` session is refused
  with HTTP 409 and code `SESSION_TERMINATED` — termination is not reversible;
- remains fully readable through `GET /api/v1/guardian/sessions/<sessionId>`,
  `GET /api/v1/sessions` and `GET /api/v1/sessions/<sessionId>`, each carrying a
  derived `liveness` field of `active` or `expired`.

**What counts as activity.** The most recent of two server-generated timestamps:
the server-observed time of the last accepted telemetry batch or lifecycle
transition, and the durable `updatedAt` the persistence layer writes on every
session mutation. The client-supplied `MicroEvent.timestamp` is deliberately not
a candidate — it would let the monitored client hold its own monitoring window
open — and neither is a replayed batch, which is deduplicated before the activity
stamp is refreshed.

**What expiry does not do.** It never deletes, truncates or hides evidence.
Cleanup of historical data is a separate retention policy and is not implemented;
deleting a session remains an explicit operator action
(`DELETE /api/v1/guardian/sessions/<sessionId>`).

Security notes:

- Lowering `MIN_HUMAN_KEYSTROKE_MS` makes the keystroke-rhythm check less
  sensitive; raising it makes ordinary fast typing look anomalous. Anomaly
  detection requires at least 10 recorded deltas and fires when more than 30% of
  them fall below this value.
- `DATA_LEAKAGE_SIMILARITY_THRESHOLD` gates the exfiltration matcher. See
  [the reference corpus](#reference-corpus-data_leakage_similarity_threshold)
  below for what it compares and what a match does and does not mean.
- These thresholds are also written into authored penetration scenarios as
  `antiExfiltrationThresholds`, with per-scenario defaults in
  `apps/api/src/ai/parsers.ts`.

### Reference corpus (`DATA_LEAKAGE_SIMILARITY_THRESHOLD`)

Exfiltration similarity is computed **locally and deterministically**, not asked
of the model. `DATA_LEAKAGE_SIMILARITY_THRESHOLD` is the gate: pairs scoring at or
above it are reported as `ExfiltrationMatch` entries in the risk payload; pairs
below it are not, though the best score found is still reported so an operator can
see how close a paste came.

The comparison is against the **operator-managed reference corpus**, a local
MongoDB collection (`reference_documents`). Manage it through the API:

```bash
# Add (or update) a document. Omitting referenceId creates a new one.
curl -X POST http://localhost:8080/api/v1/reference-documents \
  -H "Authorization: Bearer $CERBERUS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"label":"internal-ledger-snippet","content":"...reference text...","tags":["ledger"]}'

curl http://localhost:8080/api/v1/reference-documents -H "Authorization: Bearer $CERBERUS_API_KEY"
curl -X DELETE http://localhost:8080/api/v1/reference-documents/<referenceId> -H "Authorization: Bearer $CERBERUS_API_KEY"
```

The algorithm is normalise → tokenise → 3-token shingles → Jaccard, in
`apps/api/src/services/text-similarity.ts`. It is transparent, needs no external
service and is testable at its boundary. Texts shorter than 10 tokens are not
compared at all, because two short strings can be identical by accident.

Limits: label 200 characters, content 20 000 characters, 20 tags of 50 characters
each, and at most 200 documents are loaded per analysis.

**Cerberus never populates this collection itself.** There is no crawler, no
bundled corpus and no third-party content — every entry arrives through the API,
from the authenticated operator. **A match is not a finding that anything was
copied.** It reports that two pieces of text share a measurable amount of
phrasing. Do not treat it as plagiarism detection or as evidence of intent.

`ExfiltrationReport.aiCompletionLikelihood` is always `0`: Cerberus does not
attempt to determine whether content was machine-generated, and reporting a guess
there would present an unfounded number as a measurement.

## 7. Notifications

All four are optional. Both channels are no-ops when unconfigured, and both
swallow failures so a notification outage cannot fail telemetry ingestion. Each
call is bounded by a 5 000 ms deadline, because ingestion awaits both channels
before returning: without it, a hung webhook would stall the ingest request for
as long as the socket stayed open. A timed-out notification is logged as a
timeout and otherwise ignored.

| Variable | Type | Default | Required | Notes |
| --- | --- | --- | --- | --- |
| `SLACK_WEBHOOK_URL` | string (URL) | unset | No | Slack incoming-webhook URL. |
| `SENDGRID_API_KEY` | string (secret) | unset | No | Email requires **all three** of key, from and to; otherwise the send is skipped. |
| `EMAIL_FROM` | string (email) | unset | No | |
| `EMAIL_TO` | string (email) | unset | No | Single recipient. |

Security notes: notifications fire only on auto-lock (risk >= 75) and carry the
employee id, risk score, session id, incident summary and flag types to a third
party. Review whether that is acceptable for the data you are monitoring before
enabling either channel.

## 8. Related variables not owned by Cerberus

| Variable | Read by | Notes |
| --- | --- | --- |
| `NODE_ENV` | `apps/api/src/config.ts`, `scripts/entrypoint.sh` | Only used to refuse dev mode in production and to gate the entrypoint's key check. |
| `FIREBASE_API_KEY`, `FIREBASE_APP_ID`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_PROJECT_ID` | `apps/console/lib/main.dart` | Compile-time `String.fromEnvironment` values for the Flutter console. The console initializes Firebase but does not use it for authentication. |
| `API_BASE_URL` | `apps/console/lib/main.dart` | Compile-time `--dart-define`. Defaults to a hard-coded historical Cloud Run URL; override it for local work. |

## 9. Worked example — local development

Development mode admits every request, so it is only appropriate on a machine
you control. It also enables the localhost CORS allow-list automatically.

```dotenv
# ── Server ──
PORT=8080

# ── Local development only: disables authentication ──
# Refused when NODE_ENV=production.
CERBERUS_DEV_MODE=true

# ── AI provider (still required in dev mode) ──
OPENAI_API_KEY=sk-...
OPENAI_MODEL_NAME=gpt-5.6
# Optional. Leave unset unless your model accepts a custom temperature.
# OPENAI_TEMPERATURE=1
OPENAI_MAX_OUTPUT_TOKENS=65536
OPENAI_REQUEST_TIMEOUT_MS=180000

# ── MongoDB / MCP ──
MONGODB_URI=mongodb://localhost:27017
MONGODB_DATABASE=cerberus
MCP_PORT=3001
MCP_BIND_HOST=127.0.0.1
MCP_SERVER_ENDPOINT=http://localhost:3001
MCP_TIMEOUT_MS=10000

# ── Detection thresholds ──
SESSION_TTL_SECONDS=7200
MAX_PASTE_EVENTS=5
MIN_HUMAN_KEYSTROKE_MS=80
DATA_LEAKAGE_SIMILARITY_THRESHOLD=0.75

# ── Notifications (optional, leave unset to disable) ──
# SLACK_WEBHOOK_URL=
# SENDGRID_API_KEY=
# EMAIL_FROM=
# EMAIL_TO=
```

Start it:

```bash
npm install
npm run dev          # MCP adapter on :3001, API on :8080, both watch-reloading
curl http://localhost:8080/health
```

Note that `CERBERUS_API_KEY` and `CERBERUS_MCP_TOKEN` are deliberately omitted
above: dev mode makes them optional. If you set them anyway, they are used —
dev mode short-circuits the check before comparison.

## 10. Worked example — production

Every secret must be supplied by the environment or a secret manager. Nothing
below belongs in a committed file.

```dotenv
# ── Server ──
PORT=8080
NODE_ENV=production

# ── Authentication: both secrets are mandatory here ──
CERBERUS_API_KEY=<64+ random characters>
CERBERUS_MCP_TOKEN=<a different 64+ random secret>

# ── Dev mode must be absent or false ──
CERBERUS_DEV_MODE=false

# ── CORS: explicit allow-list, no wildcard ──
CERBERUS_CORS_ORIGINS=https://console.example.internal
CERBERUS_MCP_CORS_ORIGINS=

# ── AI provider ──
OPENAI_API_KEY=<secret>
OPENAI_MODEL_NAME=gpt-5.6
OPENAI_MAX_OUTPUT_TOKENS=65536
# Optional: omit to let the model use its own default temperature.
# OPENAI_TEMPERATURE=1
OPENAI_REQUEST_TIMEOUT_MS=180000

# ── MongoDB / MCP ──
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>/cerberus?retryWrites=true&w=majority
MONGODB_DATABASE=cerberus
MCP_PORT=3001
MCP_BIND_HOST=127.0.0.1
MCP_SERVER_ENDPOINT=http://127.0.0.1:3001
MCP_TIMEOUT_MS=10000

# ── Detection thresholds ──
SESSION_TTL_SECONDS=7200
MAX_PASTE_EVENTS=5
MIN_HUMAN_KEYSTROKE_MS=80
DATA_LEAKAGE_SIMILARITY_THRESHOLD=0.75

# ── Notifications (optional) ──
SLACK_WEBHOOK_URL=<secret webhook URL>
SENDGRID_API_KEY=<secret>
EMAIL_FROM=cerberus@example.internal
EMAIL_TO=security@example.internal
```

Operational checks before exposing this:

1. `NODE_ENV=production` is set and `CERBERUS_DEV_MODE` is not `true`. The
   process will refuse to start if you get this wrong, which is the intended
   failure mode.
2. `MCP_BIND_HOST` is loopback, or the adapter sits behind a network policy that
   only the API can reach.
3. `CERBERUS_CORS_ORIGINS` lists exactly the console origins you operate, and
   nothing else.
4. `CERBERUS_API_KEY` and `CERBERUS_MCP_TOKEN` are different values, generated
   randomly, and stored in a secret manager rather than an `.env` file.
5. MongoDB requires TLS and authentication, and the credentials in
   `MONGODB_URI` are scoped to the `cerberus` database.
6. You have a documented answer to the legal and ethical questions in the
   README's security and privacy warning.

This section describes how to configure the software. It is not a claim that
the resulting deployment is production ready; see the limitations in the
README, [architecture.md](architecture.md) and
[security/threat-model.md](security/threat-model.md).

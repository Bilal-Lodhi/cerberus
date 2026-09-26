# Architecture

This document describes what the repository actually contains as of version
0.1.0. It is written from the source, not from intent. Where a capability is
partial or absent, that is stated.

## 1. Component map

| Component | Path | Runtime | Role |
| --- | --- | --- | --- |
| API | `apps/api` | Node 20+, TypeScript, ESM, Hono | HTTP surface, authentication, CORS, in-memory session state, AI orchestration, MCP calls |
| Console | `apps/console` | Flutter (Dart), web target | Operator UI: identity setup, scenario authoring, live session view, session review |
| MCP server | `packages/mcp-mongodb` | Node 20+, TypeScript, ESM | MongoDB persistence exposed as MCP tools |

Supporting files:

- `Dockerfile` — multi-stage build; stage 2 runs both Node services in one
  non-root container (`cerberus` user), with the API on `PORT` and the MCP
  adapter on `MCP_PORT`.
- `scripts/entrypoint.sh` — container entrypoint. Starts the MCP adapter in the
  background, waits two seconds, then starts the API with
  `MCP_SERVER_ENDPOINT` pointed at the adapter. Refuses to start when
  `NODE_ENV=production` and `CERBERUS_API_KEY` is unset.
- `scripts/dev-services.js` / `scripts/start-services.js` — local launchers for
  the same two processes (watch mode and compiled mode respectively). Both load
  the repository-root `.env` via `dotenv`.
- `scripts/smoke-api.ps1`, `scripts/smoke-telemetry.ps1`,
  `scripts/stress-telemetry.ps1`, `scripts/verify-all.ps1` — PowerShell
  smoke/stress runners that drive a running API over HTTP.

### API internals

| File | Responsibility |
| --- | --- |
| `apps/api/src/index.ts` | Builds the Hono app: CORS, correlation id, auth middleware, route mounting, 404 and error handlers. Bootstrap and `loadConfig()` failure handling. |
| `apps/api/src/config.ts` | Reads every environment variable once, validates mandatory secrets, refuses `CERBERUS_DEV_MODE=true` under `NODE_ENV=production`, prints a banner that never contains secret material. |
| `apps/api/src/middleware/auth.ts` | Constant-time API-key check. Two principals only: authenticated operator and anonymous. |
| `apps/api/src/routes/health.ts` | Unauthenticated liveness plus capability discovery. |
| `apps/api/src/routes/identity.ts` | Display-identity registry. Explicitly **not** an authentication mechanism. |
| `apps/api/src/routes/scenarios.ts` | Threat scenario authoring: regex pre-filter, AI classifier, generation, persistence. |
| `apps/api/src/routes/guardian.ts` | Telemetry ingestion, session deploy/list/detail/terminate/delete, deduplication, risk analysis, auto-lock/auto-clear. Holds the session state. |
| `apps/api/src/routes/review.ts` | Session list and full session review (timeline + risk summary), merging in-memory and MongoDB sources. |
| `apps/api/src/routes/auditor.ts` | Natural-language query translated to a MongoDB pipeline, then interpreted in-process against a whitelist of stages. |
| `apps/api/src/ai/provider.ts` | The single inference boundary: `OpenAIProvider`, Chat Completions via the `openai` SDK. |
| `apps/api/src/ai/parsers.ts` | Pure, defensive structured-output parsers. No network access, so they are testable with fixtures. |
| `apps/api/src/services/mcp-client.ts` | The only place the API calls the MCP adapter. Always resolves, never throws. |
| `apps/api/src/services/mcp-tool-names.ts` | API-side copy of the canonical MCP tool names. |
| `apps/api/src/services/notifications.ts` | Optional Slack webhook and SendGrid email. Failures are logged and swallowed. |
| `apps/api/src/types.ts` | All contracts: scenario matrix, micro-events, risk payload, session review, MCP call envelope. |
| `apps/api/src/utils/time.ts` | ISO-8601 timestamps carrying the server's local offset, plus a human-readable local time label. |

### MCP internals

| File | Responsibility |
| --- | --- |
| `packages/mcp-mongodb/src/tool-names.ts` | Canonical tool names, Cerberus-native collection names, default database name, valid session statuses. Dependency-free so both sides can import it. |
| `packages/mcp-mongodb/src/mongo-client.ts` | MongoDB Node driver data layer. No ORM. Owns index creation. |
| `packages/mcp-mongodb/src/tools.ts` | Tool registry and input validation. Typed as `Record<McpToolName, ToolHandler>`, so a missing handler fails the TypeScript build. |
| `packages/mcp-mongodb/src/server.ts` | stdio transport for MCP-capable agent hosts, plus a `mongo://health` resource. |
| `packages/mcp-mongodb/src/http-adapter.ts` | HTTP transport used by the API. `GET /health`, `GET /tools`, `POST /tools/:toolName`. |
| `packages/mcp-mongodb/src/body.ts` | Request body parsing and the size bound. Extracted so it can be tested over a real socket without importing `http-adapter.ts`, which connects to MongoDB and exits on failure at module load. |

The API deliberately keeps its own copy of the tool-name set rather than
importing the MCP package, so the two services remain independently
deployable. `apps/api/test/mcp-tool-mapping.test.ts` asserts the two sets are
identical, so renaming a tool on one side without the other fails the suite.

## 2. Data flow — telemetry ingestion

Entry point: `POST /api/v1/guardian/ingest` in `apps/api/src/routes/guardian.ts`.

```text
console (browser)
  │  { events: MicroEvent[] }  — batched, non-empty array required
  ▼
auth middleware  (apps/api/src/middleware/auth.ts)
  ▼
POST /api/v1/guardian/ingest
  │
  ├─ 1. ensureMongoSession()      → MCP get_session_review, then create_session
  │                                 if the session document does not exist
  ├─ 2. MCP ingest_micro_events   → raw telemetry persisted (batch and body capped)
  ├─ 3. processEvent() per event  → in-memory SessionState mutated
  │                                 (fingerprint dedup applied here)
  ├─ 4. MCP update_session_counts → durable aggregate counters refreshed
  ├─ 5. shouldAnalyze?            → see trigger conditions below
  │     └─ yes, and currentCode.length > 50:
  │          ├─ SHA-256 of currentCode compared to lastAnalyzedCodeHash
  │          │    └─ equal → reuse cached payload, return early (no inference)
  │          ├─ OpenAIProvider.analyzeRisk()  → RiskAssessmentPayload
  │          ├─ behavioural score blend applied to the payload
  │          ├─ incident context enrichment (paste snippets, code snapshot,
  │          │    behavioural counters, keystroke metrics, summary, label)
  │          ├─ score >= 75  → recommendIncidentActions(), Slack + email,
  │          │                 lockSession()  → MCP set_session_status "locked"
  │          ├─ score <  25  → unlockSession() if currently locked
  │          └─ MCP store_risk_assessment → payload persisted
  ▼
{ success, processedCount, riskPayload, alertTriggered, anomalyRiskIndex }
```

Notes grounded in the code:

- Analysis is triggered by any of: a `PASTE` event with `changeLength >= 100`;
  `pasteCount` above `MAX_PASTE_EVENTS`; `tabSwitchCount > 3`;
  `fullscreenExitCount > 0`; `copyAttemptCount > 2`; or anomalous keystrokes.
- Anomalous keystrokes require at least 10 recorded deltas and a ratio of
  sub-`MIN_HUMAN_KEYSTROKE_MS` deltas above 0.3.
- A failure inside AI analysis is non-fatal and logged: the telemetry is already
  persisted by that point, and the request still returns success.
- Every MCP call from a route uses a 5 000 ms timeout
  (`MCP_TIMEOUT_MS` in `guardian.ts` and `review.ts`). The MCP client always
  resolves `{ ok: false }` on timeout, non-2xx status, connection refusal or an
  unparseable body, so a slow database degrades the response instead of
  stalling the ingestion loop.

## 3. Data flow — scenario authoring

Entry point: `POST /api/v1/scenarios` in `apps/api/src/routes/scenarios.ts`.

```text
{ prompt, roleContext, vectorCount (1..25), severityMix? }
  ▼
Stage 1  runPreFilter()            deterministic regexes, no inference cost
           empty | greeting-only | too short | profanity | gibberish
           → HTTP 422 with preFilterFlags
  ▼
Stage 2  OpenAIProvider.classifyScenarioRequest()
           verdict: isInputMeaningful, isScenarioRelated, isAppropriate,
                    contentFlags, confidence, detectedDomain, reason
           evaluateVerdict() rejects when:
             !isAppropriate  OR  !isInputMeaningful  OR  !isScenarioRelated
             OR confidence < 0.75  OR detectedDomain shorter than 3 chars
           classifier throws → HTTP 503 CLASSIFIER_UNAVAILABLE (fail-closed)
  ▼
Stage 3  OpenAIProvider.authorThreatScenarioMatrix()
           promptFingerprint replaced with SHA-256 of the raw prompt
           MCP store_threat_scenario (best-effort: a persistence failure is
           logged but the matrix is still returned)
  ▼
201 { success, matrix, mcpCorrelationId, persisted, generationRequestId, pipeline }
```

Cancellation: `POST /api/v1/scenarios/cancel` with a `generationRequestId`
aborts the in-flight `AbortController` registered for that request. A cancelled
generation returns HTTP 200 with `cancelled: true`.

`normalizeSeverityMix()` coerces the four weights, rejects negatives and
non-finite values, and renormalises to sum to 1.0; an unusable mix falls back to
`{ low: 0.25, medium: 0.35, high: 0.25, critical: 0.15 }`.

### The console's slider → `severityMix` mapping

The console's scenario panel exposes **three** risk-distribution sliders, but the
contract has **four** severity keys. The mapping lives in exactly one place,
`apps/console/lib/models/severity_mix.dart`:

| Slider | Severity |
| --- | --- |
| `routine` | `low` |
| `elevated` | `medium` |
| `severe` | `high` (60%) + `critical` (40%) |

The third slider is labelled **"Severe"**, not "Critical", because only 40% of its
budget becomes `critical`. The panel prints the resulting four percentages beneath
the sliders, so the split is shown rather than left to be discovered, and the
shares are named constants (`severeHighShare`, `severeCriticalShare`) rather than
literals buried in the widget.

This is the only channel for the risk distribution. The sliders are **not** also
folded into the prompt text: `buildScenarioSystemPrompt()` states the distribution
to the model from the structured numbers, so the operator's choice is expressed
once and cannot disagree with itself. The client normalises to sum 1.0 using the
same rules as the server, so the server never silently reinterprets what was sent.

## 4. Session state model

Live state lives in two in-process maps created per `createGuardianRouter()`
call and shared with the review router:

- `sessionStore: Map<string, SessionState>` — authoritative for sessions that
  have ingested events. Holds the full event array, reconstructed
  `currentCode`, paste/tab/fullscreen/copy counters, keystroke deltas, the last
  risk payload, the last analysed code hash, the fingerprint ring and
  `lastActivityAt`.
- `activeSessions: Map<string, ActiveSession>` — the deployment registry, so a
  freshly deployed session appears in listings before any event arrives. Holds
  `sessionId`, `employeeId`, `matrixId`, `targetSystem`, `status`, `deployedAt`,
  `riskIndex` and `lastActivityAt`.

`SessionState` fields are defined in `apps/api/src/routes/guardian.ts`. Notable
details:

- `currentCode` is reconstructed from telemetry, not from a filesystem:
  `PASTE_TRIGGER` appends `pasteContent`; `CODE_DELTA` applies `diffPatch`
  (a unified diff keeps only added lines, anything else is appended); `SUBMIT`
  replaces it with `pasteContent`; `EDIT` replaces it with `newText`; `PASTE`
  replaces it with `newText`.
- `endedAt` is set only by terminate, never by delete.
- `lastActivityAt` is stamped from the injected clock — not from the request
  body — when a telemetry batch survives deduplication, and on every lifecycle
  transition (deploy, lock, unlock, terminate, reactivate). It is the in-memory
  half of the `SESSION_TTL_SECONDS` activity signal.
- Status values written durably by the API are `active`, `locked` and
  `terminated`. Sessions are created as `active`
  (`guardian.ts` passes `status: "active"` to `create_session`, and
  `MongoStore.createSession` defaults to `"active"` in `$setOnInsert`).
  The retired historical creation value `in_progress` is never written, and
  `normalizeStatus()` maps it to `active` if it is found in old documents;
  `apps/api/test/persistence-naming.test.ts` asserts the literal is absent from
  the API source. `SESSION_STATUSES` in `tool-names.ts` lists
  `active | locked | terminated` as valid for the MCP `set_session_status`
  tool, and the tool rejects anything else with a `ToolArgumentError` (HTTP 400
  over the HTTP adapter) — so the written set is exactly the accepted set.
- **State is lost on restart.** MongoDB is the durable fallback. The guardian
  session list falls back to `list_sessions` only when the in-memory result is
  empty; the review router always merges both and takes the larger count for
  each counter, so a restart does not under-report activity. Recovery is
  expiry-aware: a session whose monitoring window closed while the process was
  down is not restored into the live registry.
- **Liveness is derived, never persisted.** `SESSION_TTL_SECONDS` is interpreted
  in one place, `apps/api/src/services/session-liveness.ts`, which both the
  guardian and review routers consult. There is no `expired` session status, no
  TTL index and no expiry sweep: expiry is computed from the activity timestamp
  on every read. The review endpoints deliberately still list expired sessions,
  each carrying a derived `liveness` field. The full contract is in
  [configuration.md](configuration.md#session-lifetime-session_ttl_seconds).
- The identity registry (`apps/api/src/routes/identity.ts`) is a separate
  per-process `Map` and also resets on restart.
- **The review route sorts risk assessments itself.** `MongoStore.getRiskAssessments()`
  returns them newest-first (`generatedAt: -1`), but every consumer in
  `review.ts` wants "the latest" as the last element. Sorting explicitly at the
  point of use means a change to the store's projection, index or sort cannot
  silently reverse which assessment is treated as final — which is exactly what
  happened: `finalRiskScore` reported the first assessment ever recorded.
- **Recovery reads evidence from where it was actually written.** The session
  document is not the only durable home. `monitored_sessions.terminalContent` is
  never written, so the review's `terminalContent` recovers from the newest
  assessment's `codeSnapshot` rather than reporting an empty workspace.
- **A restart does not reset the durable counters.** Before any event is applied,
  a session entering `sessionStore` for the first time in this process is seeded
  from its durable document — counters and identity only, never evidence. The
  storage layer also applies counters with `$max`, so neither the caller's
  bookkeeping nor a missed hydration can lower a durable total.
- **Rate limiting runs after authentication.** `services/rate-limit.ts` holds one
  token bucket per route category, keyed by category rather than by caller because
  there is one shared key and therefore no caller to key on. Placing it before auth
  would let an anonymous caller exhaust a bucket and deny service to the operator,
  so unauthenticated throttling is left to the reverse proxy — see
  [operations/reverse-proxy.md](operations/reverse-proxy.md).
- **Liveness and readiness are separate, and must not be conflated.** `/health`
  checks nothing and always answers `200`, so a dependency outage cannot cause an
  orchestrator to restart a healthy process in a loop. `/ready` checks the
  persistence layer and answers `503` when it is unreachable, so a load balancer
  stops routing traffic without killing the instance. See
  [operations/health-probes.md](operations/health-probes.md).

Every session field, its class and its fate across a restart is inventoried in
[development/session-state-model.md](development/session-state-model.md).

## 5. Deduplication layers

Five layers. The first is durable; the rest are in-process and best-effort.

1. **Durable event identity.** `micro_events` carries a unique index on
   `(sessionId, eventId)`, and `ingest_micro_events` upserts each event with
   `$setOnInsert`. The store reports which events were **newly inserted**, and the
   ingest path applies only those to in-memory state. A retried batch is therefore
   stored once and counted once — **including a retry after a restart**, when every
   in-process layer is empty. `eventId` is required by the `MicroEvent` contract;
   the route rejects an event without one with `400 MISSING_EVENT_ID`, because an
   event that cannot be identified cannot be deduplicated.

   This is **retry idempotency, not adversarial replay protection**: the monitored
   client supplies `eventId`, so a client that wants to re-send content can simply
   send a fresh one. The threat model says so explicitly.

2. **Risk-assessment id.** The AI contract carries `riskAssessmentId`; the parser
   generates a UUID when the model omits one (`apps/api/src/ai/parsers.ts`).
3. **Code-hash equality.** SHA-256 of `currentCode` is compared against
   `lastAnalyzedCodeHash`. When unchanged, the previous payload is reused and no
   inference is performed; the cached payload is returned with `alertTriggered`
   computed as score > 50. In-process only: after a restart this costs one
   redundant analysis per session, and cannot lose evidence.
4. **Content fingerprint ring, scoped.** `computeEventFingerprint()` builds a slim
   key from event type, the first 512 characters of
   `pasteContent`/`newText`/`diffPatch`, `changeLength`, and `deltaMs` bucketed to
   10 ms. A key already in `recentEventFingerprints` drops the event, and the set
   is trimmed to the most recent 128 entries.

   It applies **only to content-bearing types** — `PASTE`, `PASTE_TRIGGER`,
   `EDIT`, `CODE_DELTA`, `SUBMIT`. Everything else is a *signal*, and two signals
   with identical payloads are two events: two keystrokes with the same inter-key
   delay are two keystrokes, not a replay. Applying content dedup to signals
   silently lost telemetry, which is why it is scoped (`isContentBearingEvent`).

   The ring is a cache in front of layer 1, not a guarantee: it does not survive a
   restart, and it catches only the case layer 1 does not — the same content
   re-sent under a fresh `eventId`.
5. **Behavioural counter blend.** The semantic score is blended with a
   behavioural boost:

   ```text
   pastePenalty      = min(pasteCount * 5, 30)
   tabPenalty        = min(tabSwitchCount * 4, 16)
   copyPenalty       = min(copyAttemptCount * 6, 18)
   fullscreenPenalty = fullscreenExitCount > 0 ? 10 : 0
   keystrokePenalty  = anomalousKeystrokes ? 12 : 0
   behaviouralBoost  = sum of the above
   blendedScore      = clampScore(semanticScore * 0.85 + behaviouralBoost * 0.15)
   ```

   `clampScore()` rounds and clamps into 0-100, and maps a non-finite value to 0
   rather than `NaN` — `NaN >= AUTO_LOCK_THRESHOLD` is false, so a `NaN` score
   would silently disable the auto-lock instead of failing loudly.
   `dataExfiltration` and `policyViolation` dimensions are then adjusted by the
   blend factor and the paste/tab/copy penalties, each through `clampScore()`.

## 6. Score composition and model-output bounds

Risk scoring is **model-assisted, not model-trusting**. Two distinct numbers are
in play, and they are not interchangeable:

- the **semantic score** — what the model returned for `overallRiskScore`, which
  is advisory and untrusted;
- the **behavioural boost** — a deterministic function of counted telemetry
  (pastes, tab switches, copy attempts, fullscreen exits, keystroke rhythm).

The persisted `overallRiskScore` is the blend above, so it is a composition of
both. The model's raw number is not separately retained; the dimensions and
flags that produced it are, and `behavioralContext` records the counter tallies
the boost was derived from. The blend is documented rather than implicit so an
operator can explain any score without re-running the model.

`apps/api/src/ai/parsers.ts` is the single boundary every consumer reads from, and
it bounds what the model may supply:

| Value | Bound |
| --- | --- |
| `overallRiskScore`, `dimensionScores.*` | clamped to 0-100 |
| `flags[].confidence`, `exfiltrationReport.overallSimilarity`, `matchedSnippets[].similarityScore`, `aiCompletionLikelihood` | clamped to 0-1 |
| classifier `confidence` | clamped to 0-1, so an out-of-range value cannot stand in for the ≥ 0.75 admission gate |
| `regulatoryMandates[].weight` | clamped to 0-1 |
| `threatVectors[].riskScore` | clamped to 0-100 |
| `antiExfiltrationThresholds.*` | each clamped to its documented range, over the documented defaults |
| every array (`flags`, `behavioralAnomalies`, `matchedSnippets`, `subMandates`, systems, mandates, vectors, scenarios) | at most 50 entries |
| free text | at most 2 000 characters; identifiers at most 200 |
| `subMandates` recursion | depth-limited to 5 |

Non-object entries in any of those arrays are **dropped**, not coerced: every
consumer indexes into them, so a `null`, string or nested array would either
throw or fabricate a fieldless record that reads like real evidence.

Three consequences worth stating plainly:

- **Duplicate flags do not inflate the score.** The blend depends on counted
  telemetry, not on how many `flags` the model returned. Duplicates inflate the
  payload, which is why the array is bounded, but not the number.
- **The exfiltration report is not model output.** It is computed locally from
  the paste content and the operator-managed reference corpus, and it is the only
  part of the payload that is *replaced* rather than merely clamped. A similarity
  claim is evidence, and only the local comparison can be re-derived from inputs
  an operator can inspect.
- **A model score is never an authoritative judgement about a person.** It is one
  input to a blended advisory number. Nothing in the codebase labels a monitored
  operator as malicious, and no automated action is taken against a person; the
  auto-lock is a system-state containment action on a session, documented as such
  in [security/threat-model.md](security/threat-model.md).

## 7. Persistence model

All persistence goes through the MCP HTTP adapter. The API never opens a
MongoDB connection.

### Collections

Cerberus-native names, from `packages/mcp-mongodb/src/tool-names.ts`:

| Collection | Holds |
| --- | --- |
| `threat_scenarios` | Authored scenario matrices, keyed by `metadata.matrixId`. |
| `monitored_sessions` | Session documents: identity, matrix association, target system, status, aggregate counters, terminal content. |
| `micro_events` | Raw telemetry, one document per event. |
| `risk_assessments` | `RiskAssessmentPayload` documents plus the enrichment context. |
| `reference_documents` | The operator-managed reference corpus: `referenceId`, `label`, `content`, `tags`, timestamps. Read in full on every risk analysis. **Cerberus never writes here itself** — every entry arrives through `POST /api/v1/reference-documents`. |

Default database: `cerberus` (`DEFAULT_DATABASE_NAME`), overridable with
`MONGODB_DATABASE`.

### Index inventory

Created by `MongoStore.ensureIndexes()` in
`packages/mcp-mongodb/src/mongo-client.ts`, on every `connect()`. The calls are
idempotent for identical specifications.

| Collection | Index | Options |
| --- | --- | --- |
| `monitored_sessions` | `{ sessionId: 1 }` | unique |
| `monitored_sessions` | `{ employeeId: 1, auditId: 1 }` | |
| `monitored_sessions` | `{ createdAt: -1 }` | |
| `micro_events` | `{ sessionId: 1, timestamp: -1 }` | |
| `micro_events` | `{ eventType: 1 }` | |
| `micro_events` | `{ sessionId: 1, eventId: 1 }` | unique — the durable event identity |
| `risk_assessments` | `{ sessionId: 1, generatedAt: -1 }` | |
| `risk_assessments` | `{ employeeId: 1 }` | |
| `threat_scenarios` | `{ "metadata.matrixId": 1 }` | unique |
| `threat_scenarios` | `{ "metadata.generatedAt": -1 }` | |
| `reference_documents` | `{ referenceId: 1 }` | unique |
| `reference_documents` | `{ updatedAt: -1 }` | |

### MCP tool inventory

From `MCP_TOOL_NAMES`, present identically on both sides:

`store_threat_scenario`, `get_threat_scenario`, `create_session`,
`update_session_terminal_content`, `delete_session`, `append_micro_event`,
`ingest_micro_events`, `store_risk_assessment`, `update_session_counts`,
`set_session_status`, `get_session_review`, `get_employee_risk_history`,
`list_sessions`, `store_reference_document`, `list_reference_documents`,
`delete_reference_document`, `health_check`.

`create_session` upserts on `sessionId` with `$setOnInsert`, so it is
idempotent. `delete_session` cascades to `micro_events` and `risk_assessments`
for that session and then removes the session document **last**, so a partial
failure leaves the session identifiable rather than orphaning its telemetry. It
reports what it removed per domain component (`session`, `telemetry`,
`assessments`) and names any component whose removal failed, so a partial
deletion is never reported as a complete one. See
[api-errors.md](api-errors.md) §4.1.
`store_reference_document` upserts on `referenceId`, so re-submitting the same
document updates it rather than creating a duplicate that would double-count in
similarity scoring.

### Auditor pipeline restriction

`apps/api/src/routes/auditor.ts` never forwards a model-generated pipeline to
MongoDB. `applySafePipeline()` interprets only:

- `$match` with equality or `$gt` / `$gte` / `$lt` / `$lte` / `$ne` on top-level
  numeric fields,
- `$sort` (first field and direction only),
- `$limit`.

Any other stage is ignored rather than executed. The records it filters come
from `list_sessions`, which returns a projection of session fields, not raw
events.

## 8. Trust boundaries

```text
        untrusted                         trusted (self-hosted)                    external
 ┌───────────────────────┐      ┌──────────────────────────────────────┐   ┌──────────────────┐
 │ Browser / console     │─────▶│ Cerberus API                         │──▶│ OpenAI           │
 │ operator input,       │ key  │ holds CERBERUS_API_KEY, MCP token,   │   │ Chat Completions │
 │ telemetry payloads,   │      │ OPENAI_API_KEY, session state        │   └──────────────────┘
 │ model output          │      └───────┬──────────────────────────────┘
 └───────────────────────┘              │ bearer CERBERUS_MCP_TOKEN
                                        ▼
                          ┌──────────────────────────────────────┐   ┌──────────────────┐
                          │ MCP HTTP adapter (loopback default)  │──▶│ MongoDB          │
                          └──────────────────────────────────────┘   └──────────────────┘
```

Boundary by boundary:

- **Console → API.** Untrusted input. Authentication is a single pre-shared key
  (`Authorization: Bearer <key>` or `X-API-Key: <key>`), compared with
  `crypto.timingSafeEqual`; the missing-credential and wrong-credential
  responses are byte-identical. `GET /health` and `GET /` bypass the check
  (`PUBLIC_PATHS` in `middleware/auth.ts`); `/` is served by the health router.
  Request bodies are treated as untrusted: shapes are validated explicitly, and
  the global error handler returns a generic 500 with a correlation id rather
  than framework or provider internals. Bodies are bounded before they are read:
  the `body-limit` middleware in `index.ts` rejects anything above
  `CERBERUS_MAX_BODY_BYTES` (default 8 MiB) with `413 PAYLOAD_TOO_LARGE`, and it
  runs before the authentication middleware so an oversized request is refused
  whether or not the caller holds a credential. Per-field caps sit below it —
  see [configuration.md](configuration.md#1-server).
- **API → OpenAI.** Model output is untrusted text. It is parsed defensively
  (strip markdown fences → `JSON.parse` → repair trailing commas and control
  characters → extract the first balanced JSON object) and every field is
  coerced. A parse failure in the scenario classifier is treated as a rejection.
  Every model-reading path uses that same recovery ladder, including the
  auditor's pipeline translation. Retry fatality is classified from the SDK
  error's HTTP status and machine-readable `code` rather than by searching the
  message text, so a token count or request id containing `401` cannot be
  mistaken for an authentication failure.
- **API → MCP adapter.** A shared-secret bearer token
  (`CERBERUS_MCP_TOKEN`), compared in constant time. The adapter binds to
  `127.0.0.1` by default. It emits no CORS headers at all unless
  `CERBERUS_MCP_CORS_ORIGINS` is set. Bodies are capped at 8 MiB on both sides:
  the API refuses anything larger before buffering it, and the adapter applies
  its own cap to what it receives.
- **MCP adapter → MongoDB.** A single connection string from `MONGODB_URI`.
  Cerberus does not manage MongoDB authentication, network policy or encryption.
- **CORS.** The API uses an explicit allow-list. With an empty
  `CERBERUS_CORS_ORIGINS` and no dev mode, no cross-origin access is granted.
  Dev mode substitutes a fixed localhost list (ports 8080 and 5173 on
  `localhost` and `127.0.0.1`).
- **Outbound notifications.** Slack webhook and SendGrid email are optional and
  unauthenticated-by-default no-ops when unconfigured. They carry the employee
  id, risk score, session id, summary and flag types to a third party. Failures
  never fail ingestion. Every call is bounded by a 5 000 ms deadline
  (`NOTIFICATION_TIMEOUT_MS` in `apps/api/src/services/notifications.ts`):
  ingestion awaits both channels before returning, so without a deadline a hung
  webhook would stall the ingest request for as long as the socket stayed open,
  turning the notification path into a way to block telemetry collection.

What the boundaries do **not** provide is enumerated in
[security/threat-model.md](security/threat-model.md).

## 9. Known gaps in this release

Cerberus is at `v0.1.0` and is not production ready. The following are known,
deliberate or unresolved gaps rather than defects.

- **No endpoint agent.** Telemetry is currently produced by the console/browser
  only. The architecture above reserves the ingestion boundary for a future
  endpoint agent, but no agent implementation ships in this release.
- **Exfiltration similarity is local and deterministic, not model-derived.**
  `DATA_LEAKAGE_SIMILARITY_THRESHOLD` gates a comparison computed in-process
  (`apps/api/src/services/text-similarity.ts`: normalise → 3-token shingles →
  Jaccard) between paste content and the operator-managed reference corpus. The
  risk payload's `exfiltrationReport` is **replaced** with that result rather
  than merged with the model's, because only the local comparison is reproducible
  from the corpus and the threshold — the model never sees the threshold.
  `aiCompletionLikelihood` is always `0`, since Cerberus does not attempt to
  determine whether content was machine-generated. A match means two texts share
  phrasing; it is not a finding that anything was copied. See
  [configuration.md](configuration.md#reference-corpus-data_leakage_similarity_threshold).
- **Session expiry is computed, not swept.** `SESSION_TTL_SECONDS` bounds
  active-liveness only. There is no TTL index in MongoDB and no background expiry
  job: an expired session is excluded from the live list, is not restored by a
  restart, and refuses new telemetry until it is explicitly reactivated, but its
  documents are retained indefinitely. Cleanup of historical data is a separate
  retention policy that is not implemented. The full contract is in
  [configuration.md](configuration.md#session-lifetime-session_ttl_seconds).
- **Session status vocabulary is narrow, and it is one vocabulary.** `SESSION_STATUSES`
  in the MCP adapter and `PERSISTED_SESSION_STATUSES` in
  `apps/api/src/services/session-status.ts` are the same three values: `active`,
  `locked`, `terminated`. Sessions are created as `active`, and the guardian writes
  `locked`, `active` and `terminated`. The derived review values (`flagged`,
  `investigating`) are a **disposition**, reported separately and never persisted, and
  `cleared` was removed: nothing ever produced it, and the one clear behaviour the
  product has — lifting a lock — writes `active`. A legacy document holding a retired
  value is normalised to `active` and repaired on its next transition. See
  [development/state-transition-model.md](development/state-transition-model.md) §1 and
  [development/read-model.md](development/read-model.md).
- **No rate limiting, no replay protection beyond TLS, and no automated key
  rotation.** See [security/threat-model.md](security/threat-model.md).
- **Single shared API key.** Cerberus cannot attribute an action to an individual
  operator, and rotating access for one person rotates it for everyone.
- **The console is an operator console, not a hardened client.** Its operator API
  key is supplied at build time via
  `--dart-define=CERBERUS_API_KEY=...`, which means the key is embedded in the
  built web bundle. Serve the console only to trusted operators, or front it with
  a proxy that injects the credential.
- **No migration tooling** for the historical schema. See
  [migration.md](migration.md).
- **No `CODEOWNERS` file**, so no review is requested automatically on any path.
  The `docs/` index page now exists at [index.md](index.md).


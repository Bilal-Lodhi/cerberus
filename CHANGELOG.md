# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `npm run bench`, and `docs/development/performance-baseline.md`. The benchmark
  drives the compiled API in process through `app.request()` with the persistence
  layer and AI provider stubbed, so it is reproducible anywhere with no MongoDB, no
  network and no paid inference, and a regression is attributable to this code
  rather than to a container's warm-up. Every case warms up before sampling, and
  latencies are reported as p50/p95/p99 because request latency is right-skewed and
  a mean hides the tail.
  It found two real defects, both the same shape — work proportional to how much a
  session already holds:
  - **Ingest cost grows linearly with the events a session already holds.**
    Throughput falls from 2 263 req/s against an empty session to 78 req/s against
    one holding 5 000 events, and p50 rises from 0.44 ms to 11.53 ms. A 5 000-event
    session is an ordinary day of telemetry, and the console sends one event per
    request.
  - **In-memory session state has no per-session cap.** About 1.4 KiB per event held
    in memory; `MAX_EVENTS_PER_BATCH` bounds one request, not a session's lifetime.
  Neither is visible from a throughput figure taken on a fresh database, which is
  why the scaling case exists.
- `scripts/backup-cerberus.ps1` and `scripts/restore-cerberus.ps1`, plus
  `npm run backup` and `npm run restore`. Cerberus still has no backup mechanism of
  its own — it writes to MongoDB, so the mechanism is MongoDB's — but an unverified
  backup is a guess, so the scripts make one verifiable. The backup dumps, counts
  every collection, writes a manifest beside the dump, and **fails if any collection
  dumped to 0 bytes**. The restore restores into a scratch database by default,
  **refuses to restore over the source** without `-AllowSameDatabase`, **refuses a
  non-empty target** without `-Drop`, and **compares the restored counts against the
  manifest**.
  That last check is the one that matters: `mongorestore` exits **0** when it
  restores nothing — point it at the wrong directory level and it prints
  `don't know what to do with file ..., skipping` for every collection, reports
  `0 document(s) restored successfully`, and succeeds. An exit-code check would pass
  while the deployment came back empty. Verified by tampering with a manifest to
  claim 99 documents in a collection holding 3: the restore reports
  `FAIL micro_events expected 99 got 3` and exits 1.
- `docs/operations/backup-restore.md`: what to back up (including
  `schema_migrations`, which is easy to overlook and makes the runner re-apply
  migrations if omitted), what is deliberately **not** backed up (configuration and
  secrets — the manifest records the source rather than the connection string,
  which can carry a password), the end-to-end drill, and the gaps this does not
  close: no scheduling, no point-in-time recovery, no off-host storage, no
  encryption, no retention.
- `GET /ready`, and a real split between liveness and readiness. `/health` is
  **liveness**: it checks nothing and always answers `200`, so a dependency outage
  cannot make an orchestrator restart a healthy process in a loop. `/ready` is
  **readiness**: it asks the persistence layer, answers `200` or `503`, and is what a
  load balancer should use to stop routing traffic without killing the instance.
  The MCP adapter exposes the same pair, where `/ready` pings MongoDB. Before this,
  `/health` returned `healthy` unconditionally — a deployment whose sidecar was down
  reported itself healthy and kept accepting telemetry it could not persist.
  The readiness probe is cached for two seconds and concurrent probes share one
  in-flight check, so being watched closely does not add load in proportion to how
  closely it is watched. It always answers: a dependency that throws, hangs or
  returns nonsense is reported as `down`, never as a `500`, and each check has its
  own deadline. `docs/operations/health-probes.md` records which endpoint belongs in
  each probe slot, and the `Dockerfile` and `docker-compose.yml` now probe `/ready`.
- A schema and data migration framework
  (`packages/mcp-mongodb/src/migrations.ts`): ordered and append-only, idempotent,
  failing **before** it mutates, and recording what it did in a `schema_migrations`
  ledger. There are no down-migrations — reversing a data migration would be a
  fiction, since the removed documents are gone.
- `npm run migrate` and `npm run migrate:dry-run`. The dry run prints the plan,
  marking migrations that rewrite data, and changes nothing — it does not even read
  the telemetry collections.
- Migration `0001-dedupe-micro-event-identity`. The pre-fix ingestion path wrote
  every event in a retried batch, so a database that ran it holds duplicate
  `micro_events` documents — and the unique index on `(sessionId, eventId)` cannot
  be created over duplicates. Without this migration such a deployment would fail to
  start with an opaque duplicate-key error. The migration removes only copies that
  are otherwise **identical**, and refuses — having written nothing — when a pair's
  copies disagree, naming the pairs, because removing either version would destroy
  data.
- Migrations run **before** index creation, and the order is load-bearing: the
  unique identity index cannot be built over duplicates, so creating indexes first
  would turn a repairable database into one that will not start.
  `MongoStore.connect()` now applies migrations then indexes, and accepts
  `{ migrate: false }` for the CLI.
- `docs/operations/upgrade.md`: back up, read the plan, apply, restart, confirm —
  plus what to do when a migration refuses to run, why there are no
  down-migrations, and why the MCP adapter starts before the API.
- In-process rate limiting: token buckets, one per route category, applied
  **after** authentication. A refused request is `429` with code `RATE_LIMITED`, a
  `Retry-After` header, and `X-RateLimit-Limit` / `X-RateLimit-Remaining` on every
  response. `CERBERUS_AI_REQUESTS_PER_MINUTE` (default 10) caps the AI-backed
  endpoints, which are the ones that spend money; `ingest`, `mutation` and `read`
  have documented fixed ceilings, and `GET /health`, `GET /ready` and `GET /` are
  exempt because a rate-limited probe looks like a dead service.
  `CERBERUS_RATE_LIMIT_ENABLED` turns it off, and an unrecognised value for it is a
  startup error rather than a silent `false`, so a typo cannot disable the control.
  It is a backstop, not DDoS defence: it is per process, it does not key on the
  caller, and it deliberately does not limit unauthenticated requests — a limiter
  before auth would let an anonymous caller exhaust a bucket and deny service to
  the operator. Per-caller and unauthenticated throttling belong at the reverse
  proxy; see `docs/operations/reverse-proxy.md`.
- `docs/operations/reverse-proxy.md` records what a proxy in front of Cerberus must
  own, why `X-Forwarded-For` is deliberately not trusted, a minimal nginx
  configuration, and what happens with more than one replica.
- `CERBERUS_API_KEY_PREVIOUS` and `CERBERUS_MCP_TOKEN_PREVIOUS` support rotating
  either shared secret without a hard cutover: set the new value, put the old one
  in the previous slot, restart, move every client across, then unset it and
  restart again. **Both comparisons always run**, so the response time does not
  reveal which key matched, and neither key is ever logged. Setting a previous key
  without a current one is a startup `ConfigError` — an overlap is not a
  replacement. `docs/operations/key-rotation.md` documents the procedure and what
  an overlap does not do. There is still no key identity and no revocation list:
  ending the overlap is the revocation.
- `POST /api/v1/guardian/ingest` reports `acceptedCount` and `duplicateCount`
  alongside `processedCount`, which keeps its meaning (the batch size). A caller
  retrying after a network ambiguity can see that its events were already stored.
- `micro_events` gains a unique index on `(sessionId, eventId)`.
- `CONTRIBUTING.md` records that Cerberus is single-maintainer and does not use
  `CODEOWNERS`, why a file of invented or wildcard entries would be worse than
  none, and the condition for revisiting it: a second real owner relationship.
- `docs/development/maturity-plan.md` records the maintainer's decisions —
  `CODEOWNERS` not used while single-maintainer, the endpoint agent deferred,
  `v0.2.0` prepared but not published, and operational durability as the next
  focus — and states the current phase's exit condition as a tracked table.
- `docs/index.md` — an entry point for the documentation set. It lists every
  document under `docs/` with the audience it is written for, and is linked from
  the `README.md` documentation section.
- `docs/development/maturity-plan.md` — the current maturity state, completed
  milestones, the next work queue, accepted limitations and the decisions that
  need a maintainer.
- `docs/compatibility.md` — what counts as a public contract, the breaking-change
  and deprecation policies, versioning, supported runtimes, and the dependency and
  license policy with the current audit results. Linked from the documentation
  index, `README.md` and `CONTRIBUTING.md`.
- `SESSION_TTL_SECONDS` is now enforced. A session is live while its most recent
  activity is younger than the configured lifetime; once the window closes the
  session is excluded from `GET /api/v1/guardian/sessions`, is not restored as
  live by a restart, and refuses new telemetry with `409 SESSION_EXPIRED`.
  Expiry is computed on every read from the session's activity and the configured
  TTL — there is no `expired` status, no TTL index and no background sweep. It is
  **not** an evidence-retention policy: nothing is deleted, and the review
  endpoints still serve expired sessions.
- `POST /api/v1/guardian/sessions/:sessionId/reactivate` reopens a closed
  monitoring window. Reopening is explicit so that a monitoring window cannot be
  extended indefinitely as a side effect of continuing to emit events. It is
  idempotent for a live session and refuses a `terminated` session with
  `409 SESSION_TERMINATED`.
- A derived `liveness` field (`"active"` or `"expired"`) on
  `GET /api/v1/guardian/sessions/:sessionId`, `GET /api/v1/sessions` and
  `GET /api/v1/sessions/:sessionId`.
- `createApp()` accepts an optional injected `clock`, and
  `apps/api/src/services/session-liveness.ts` exports a manual clock, so the TTL
  boundary is asserted exactly in tests instead of by sleeping.
- The console sends the scenario panel's risk-distribution sliders as a
  structured `severityMix` object. The mapping lives in
  `apps/console/lib/models/severity_mix.dart`: `routine → low`,
  `elevated → medium`, and the third slider is a budget split
  `60% high / 40% critical`. `ApiService.authorScenario` accepts an injectable
  `http.Client` so the generated request body is tested.
- `CERBERUS_MAX_BODY_BYTES` bounds the request body the API will buffer. The API
  previously had **no request body size limit at all** — `@hono/node-server`
  exposes no `bodyLimit` option and none was configured — so every route read
  whatever the caller sent. An oversized request is now refused with
  `413 PAYLOAD_TOO_LARGE` before the body is read, for authenticated and
  unauthenticated callers alike. Default 8 MiB, matching the ceiling the MCP
  adapter already applied to its own bodies.

### Changed

- `README.md` and `CONTRIBUTING.md` now state where `flutter build web --release`
  writes its output: `apps/console/build/web`. `CONTRIBUTING.md` previously
  stopped at `flutter run -d chrome` and had no build step at all.
- Request fields that reach a paid provider are now length-capped: `prompt`
  (8 000 characters) and `roleContext` (200) on `POST /api/v1/scenarios`, and
  `question` (2 000) on `POST /api/v1/auditor/query`. Each is refused with
  HTTP 400 before any inference is spent. Telemetry batches are capped at
  1 000 events per request, and identity fields at 200 characters each.
- The auditor truncates its result set to 200 records whatever pipeline the model
  produces, so a model-generated pipeline with no `$limit` can no longer pass
  every session to the provider.
- The scenario panel's third risk slider is labelled **"Severe"** rather than
  "Critical", because only 40% of its budget becomes `critical`. The panel prints
  the resulting four percentages beneath the sliders, so the split is shown
  rather than hidden.
- The risk distribution is no longer folded into the scenario prompt as prose.
  It travels only as the structured `severityMix` field, and the server states it
  to the model from those exact numbers — one source of truth instead of two that
  could disagree.
- `SESSION_TTL_SECONDS` is validated at startup: it must be a positive whole
  number of seconds. `0`, `-1`, `1.5`, `1e3` and `7200abc` now raise a
  `ConfigError` and exit with code 1 instead of being silently parsed into a
  different monitoring window. An unset value still takes the `7200` default.
- The telemetry activity signal that drives expiry is server-generated only. The
  client-supplied `MicroEvent.timestamp` is recorded and displayed but is
  deliberately not an expiry input, and a deduplicated replay does not refresh
  the activity stamp.
- Model-supplied numbers are now clamped to the ranges their contracts document,
  in `apps/api/src/ai/parsers.ts`: `overallRiskScore` and `dimensionScores.*` to
  0-100, `flags[].confidence`, `exfiltrationReport` similarity fields and the
  classifier `confidence` to 0-1, mandate `weight` to 0-1, vector `riskScore` to
  0-100, and every `antiExfiltrationThresholds` field to its own range. Finiteness
  was already checked; range was not, so a well-formed `-1e9` or `1e9` passed
  through and would have corrupted threshold comparisons, sorting and the
  auto-lock decision.
- Model-supplied arrays and strings are bounded: at most 50 entries per array,
  2 000 characters of free text, 200 per identifier, and `subMandates` recursion
  is depth-limited to 5. Non-object array entries are dropped rather than
  coerced into fieldless records that read like real evidence.
- `exfiltrationReport` and `behavioralAnomalies` are now parsed field by field
  instead of being cast to their contract types, so a malformed model structure
  no longer reaches the console and the review timeline untouched.
- The composed risk score is clamped through `clampScore()`, which maps a
  non-finite value to 0 rather than `NaN`. `NaN >= AUTO_LOCK_THRESHOLD` is false,
  so a `NaN` score would have silently disabled the auto-lock instead of failing
  loudly.
- Outbound Slack and SendGrid notifications are bounded by a 5 000 ms deadline.
  Ingestion awaits both channels before returning, so a webhook that accepted a
  connection and never answered previously stalled the ingest request for as long
  as the socket stayed open — the notification path could block telemetry
  collection. A timed-out notification is logged as a timeout and otherwise
  ignored, so the failure semantics are unchanged.
- The operator identity registry is bounded in size and time. It was a `Map` that
  grew by one entry per `POST /api/v1/identity/set` and never evicted anything,
  while `GET /me` already described an unknown handle as "unknown or expired"
  although nothing expired it. Handles now expire after 12 hours and the registry
  reclaims expired entries, then the oldest, at a ceiling of 100.
- Retry fatality is classified from the OpenAI SDK error's HTTP status and
  machine-readable `code` instead of by searching the error message for `"401"` /
  `"403"`. Any error whose text happened to contain those digits — a token count,
  a request id, a URL — was treated as an authentication failure and skipped the
  retry budget entirely.
- The auditor's pipeline translation uses the same defensive JSON recovery ladder
  as every other model-reading path. A raw `JSON.parse` discarded an otherwise
  usable pipeline whenever the model wrapped it in a markdown fence or a
  sentence.
- The MCP adapter refuses an oversized request body with `413 PAYLOAD_TOO_LARGE`
  and `Connection: close`, and a malformed body with `400 INVALID_JSON` or
  `400 INVALID_BODY`. It previously destroyed the request without settling its
  promise — so the handler hung and the client saw a connection reset instead of a
  status — and collapsed both an oversized and a malformed body into `{}`, which
  surfaced as a misleading "Missing required parameter". The adapter now reads the
  same `CERBERUS_MAX_BODY_BYTES` variable as the API, so the two ceilings cannot
  drift apart.
- `npm test` runs the MCP workspace's suite as well as the API's. The MCP package
  had no tests at all; request body parsing now has integration tests over a real
  socket.
- `DATA_LEAKAGE_SIMILARITY_THRESHOLD` now gates something. Exfiltration similarity
  was previously left to the model, which never saw the threshold, and the
  reference source was a stub returning `[]`, so matches were always empty while
  the setting was still documented as doing something. Similarity is now computed
  **locally and deterministically** (`apps/api/src/services/text-similarity.ts`:
  normalise → 3-token shingles → Jaccard) against an operator-managed reference
  corpus, and pairs at or above the threshold become `ExfiltrationMatch` entries.
  The model's `exfiltrationReport` is replaced rather than merged, because only
  the local comparison is reproducible from inputs an operator can inspect.
  `aiCompletionLikelihood` is always `0`, since Cerberus does not attempt to
  determine whether content was machine-generated.
- `POST`, `GET` and `DELETE /api/v1/reference-documents` manage the reference
  corpus: a local MongoDB collection (`reference_documents`) that **Cerberus never
  populates itself**. There is no crawler, no bundled corpus and no third-party
  content — every entry is submitted by the authenticated operator. Label 200
  characters, content 20 000 characters, 20 tags of 50 characters, 200 documents
  loaded per analysis.
- The MCP package gains `store_reference_document`, `list_reference_documents` and
  `delete_reference_document`, plus the `reference_documents` collection and its
  indexes. `store_reference_document` upserts on `referenceId`, so re-submitting a
  document updates it rather than creating a duplicate that would double-count in
  similarity scoring.
- `DATA_LEAKAGE_SIMILARITY_THRESHOLD` is validated at startup: it must be a number
  between 0 and 1 or the process exits with a `ConfigError`. A value above 1 could
  never be reached by a similarity score, so it would have silently switched the
  matcher off while appearing to be configured.

### Fixed

- A batch retried after a restart was re-ingested and re-counted. Deduplication
  lived in a 128-entry fingerprint ring in process memory, which is empty after a
  restart. `micro_events` now carries a unique index on `(sessionId, eventId)`,
  `ingest_micro_events` upserts each event with `$setOnInsert` and reports which
  events were **newly inserted**, and the ingest path applies only those. Verified
  against real MongoDB across a real process restart: a two-event batch sent twice
  reports `accepted=2 duplicate=0` then `accepted=0 duplicate=2`, the durable
  `eventCount` stays 2, and exactly 2 documents are stored.
- Content deduplication was applied to **signal** events, silently dropping
  legitimate telemetry: two keystrokes with the same inter-key delay are two
  keystrokes, not a replay. It is now scoped to content-bearing types (`PASTE`,
  `PASTE_TRIGGER`, `EDIT`, `CODE_DELTA`, `SUBMIT`); every other event is
  identified by `eventId` alone.
- An event with no `eventId` is rejected with `400 MISSING_EVENT_ID`.
  `MicroEvent.eventId` was already required by the contract and is now the durable
  idempotency key, so an event that cannot be identified cannot be deduplicated.
- A restart reset a session's durable counters. `update_session_counts` was
  applied with `$set`, so the durable totals were whatever the API held in memory
  — and a restarted process held counters starting at zero. Its first write
  replaced a session's lifetime totals with the post-restart ones: 40 events and
  20 pastes came back as 1 and 1. Counters are now **hydrated** from the durable
  document before any event is applied, and applied with **`$max`** at the storage
  layer so a durable total cannot regress even if the caller sends a lower value.
  Verified across a real process restart: five events before, one after, and the
  durable `eventCount` reads 6 with `tabSwitchCount` and `fullscreenExitCount`
  intact.
- `SessionState.eventCount` was declared, initialised to zero and never read. It
  now means "events accepted for this session, including before this process
  started", and is what the durable `eventCount` is written from.
- The session review reported the **oldest** risk assessment as the final one.
  `MongoStore.getRiskAssessments()` sorts `{ generatedAt: -1 }` — newest first —
  while the review route read `reports[reports.length - 1]` as "the last report".
  Against MongoDB that is the first assessment ever recorded, so `finalRiskScore`
  was wrong and the derived `flagged` status was decided from a stale score. The
  in-process test stub returned assessments in insertion order, so the suite
  agreed with the route and disagreed with the database. The route now sorts the
  assessments itself, by `generatedAt`, rather than depending on the store's
  ordering, and the new tests use a stub that orders them the way MongoDB does.
- `monitored_sessions.terminalContent` is never written — no route calls
  `update_session_terminal_content` — so after a restart the session review
  reported an empty workspace even though the newest risk assessment holds the
  identical content in `codeSnapshot`. The review route now falls back to it. The
  evidence was always durable; only the view lost it.
- `fullscreenExitCount` was never persisted. The counter drives the
  fullscreen-exit analysis trigger and its score penalty, but it was absent from
  the `update_session_counts` payload, so MongoDB never learned it and a restart
  reset it to 0 — silently disabling both. It is now written, read back, and
  exposed on both session-list paths and in the review list.
- Corrected two documentation claims that the code had already outgrown.
  `docs/architecture.md` and `docs/migration.md` both stated that session
  creation writes the status `in_progress`; it does not. Sessions are created as
  `active`, and `apps/api/test/persistence-naming.test.ts` asserts the retired
  literal is absent from the API source.
- `docs/architecture.md` no longer says the repository has no `docs/` index page.
- `POST /api/v1/identity/set` returns HTTP 400 for a non-string field instead of
  throwing inside the handler. A numeric `displayName` used to be cast to a
  string and `.trim()` called on it, which surfaced as an unhandled 500.

## [0.1.0] - 2026-09-22

The initial independent open-source extraction. Cerberus began as "Cerberus
FinSec" in the **Google Cloud Rapid Agent Hackathon 2026** (Financial Services
track, MongoDB partner track), built on Google Cloud Agent Builder and Gemini.
The AI boundary was later migrated to the OpenAI SDK during **OpenAI Build Week
2026** (Agentic Coding track). The project was subsequently extracted from the
historical `Google-Cloud-Hackathon` repository into this standalone repository.
Published 2026-09-22 as a pre-release; this section describes the state of the
repository at extraction.

### Added

- API-key authentication middleware for the HTTP API, comparing the presented
  credential against `CERBERUS_API_KEY` in constant time. The middleware accepts
  `Authorization: Bearer <key>` and `X-API-Key: <key>`, admits `/health` and `/`
  without a credential, and returns an identical `401 UNAUTHENTICATED` response
  for a missing and a mismatched key.
- Explicit CORS allow-list. Cross-origin access is granted only to origins named
  in `CERBERUS_CORS_ORIGINS`, with development-only defaults applied when
  `CERBERUS_DEV_MODE=true`.
- Automated test suite using the Node.js built-in test runner (`node:test`)
  executed through `tsx`, wired up as `npm test`.
- GitHub Actions continuous integration.
- Open-source documentation set: `README.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md`, `CHANGELOG.md`, `NOTICE`,
  and the GitHub issue and pull request templates.
- Docker Compose local startup for the MongoDB dependency and the Cerberus
  services.

### Changed

- MongoDB collections renamed to Cerberus-native names: `threat_scenarios`,
  `monitored_sessions`, `micro_events`, and `risk_assessments`. `micro_events`
  keeps its historical name because it was already domain-neutral.
- Default database name renamed to `cerberus`.
- MCP tools renamed to Cerberus-native names, declared once in
  `packages/mcp-mongodb/src/tool-names.ts` and mirrored by the API-side client.
- The AI client consolidated into a single `OpenAIProvider` boundary. All
  inference now goes through the OpenAI Node SDK behind that one interface.
- Repository restructured into an npm workspaces monorepo: `apps/api` (Hono
  HTTP API), `apps/console` (Flutter web operator console), and
  `packages/mcp-mongodb` (MCP server for MongoDB).

### Removed

- The Assessment-era type-alias layer that duplicated the domain types.
- The legacy `GeminiClient` class name, replaced by `OpenAIProvider`.
- Hackathon-only files, tracked build artifacts, and unrelated cloud-project
  identifiers.

### Fixed

- The OpenAI provider no longer sends a `temperature` unless one is explicitly
  configured. Every request previously carried a temperature — the
  `OPENAI_TEMPERATURE` default of `0.2`, or a hard-coded `0`, `0.1` or `0.2` at
  individual call sites — and the default model (`gpt-5.6`) rejects any value
  other than its own default with HTTP 400. The effect was that **every** AI
  path failed: scenario authoring, risk analysis, incident recommendations, the
  natural-language auditor and session summarisation. `OPENAI_TEMPERATURE` is
  now an opt-in override; when it is unset the parameter is omitted and the
  model uses its own default.
- The default per-attempt AI request timeout is raised from 90s to 180s
  (`OPENAI_REQUEST_TIMEOUT_MS`). A multi-vector scenario matrix routinely takes
  longer than 90s to generate on the default model, so the provider exhausted all
  three attempts and the route returned a retryable `AI_UNAVAILABLE` for a
  request size its own contract accepts.
- Corrected the Code of Conduct enforcement contact and removed the placeholder
  banner.

### Security

- Removed the `origin: "*"` CORS wildcard. Cross-origin access now requires an
  explicit allow-list entry.
- Removed secret material from startup logs. The configuration banner reports
  only whether each credential is `set` or `unset`.
- Added fail-closed configuration validation: the API refuses to start when
  `OPENAI_API_KEY`, `CERBERUS_API_KEY`, or `CERBERUS_MCP_TOKEN` is missing, and
  refuses to start with `CERBERUS_DEV_MODE=true` while `NODE_ENV=production`.

<!--
Comparison links for the real repository.

`v0.1.0` is tagged, so the `[Unreleased]` compare link resolves. It is the only
compare link: 0.1.0 is the first release, so there is no earlier tag to compare
it against.
-->

[Unreleased]: https://github.com/Bilal-Lodhi/cerberus/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Bilal-Lodhi/cerberus/releases/tag/v0.1.0

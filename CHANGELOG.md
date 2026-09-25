# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `docs/index.md` — an entry point for the documentation set. It lists every
  document under `docs/` with the audience it is written for, and is linked from
  the `README.md` documentation section.
- `docs/development/maturity-plan.md` — the current maturity state, completed
  milestones, the next work queue, accepted limitations and the decisions that
  need a maintainer.
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

### Fixed

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

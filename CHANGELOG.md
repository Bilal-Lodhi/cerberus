# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet. Changes that land after `0.1.0` are recorded here.

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

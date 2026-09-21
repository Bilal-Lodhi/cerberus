# Contributing to Cerberus

Thanks for your interest in Cerberus. This document describes how to set up a
development environment, the conventions this repository actually uses, and what
a pull request is expected to contain.

Cerberus is an early-stage (0.1.0) self-hosted insider-threat and
data-exfiltration telemetry guardian. It is **not production ready** and makes
no guarantee of detection or prevention. Contributions that improve clarity,
correctness, or safety of the baseline are welcome.

Before you start, please read:

- `CODE_OF_CONDUCT.md` — participation expectations.
- `SECURITY.md` — how to report a vulnerability (never a public issue).
- `SUPPORT.md` — where to ask questions.

## Development environment

Requirements:

- Node.js 20 or newer (`engines.node` is `>=20.0.0`).
- npm (the repository is an npm workspaces monorepo).
- MongoDB, normally via Docker Compose, for persistence.
- Flutter, only if you are working on the operator console.
- An OpenAI API key, only if you are exercising the analysis path.

Setup:

```bash
git clone https://github.com/OWNER/cerberus.git
cd cerberus

# Install all workspace dependencies from the repository root.
npm install

# Start just the local MongoDB dependency.
docker compose up -d mongodb

# Create your local environment file.
cp .env.example .env
```

Then edit `.env`. The variables the API reads are defined in
`apps/api/src/config.ts`; the mandatory ones are:

- `OPENAI_API_KEY` — always required. Cerberus has exactly one AI backend and no
  offline or mock analysis mode.
- `CERBERUS_API_KEY` — the single shared operator API key. Required unless
  `CERBERUS_DEV_MODE=true`.
- `CERBERUS_MCP_TOKEN` — the shared secret the API presents to the MCP sidecar.
  Required unless `CERBERUS_DEV_MODE=true`.

`CERBERUS_DEV_MODE=true` disables authentication and must only ever be used on
a local development machine. The process refuses to start in dev mode when
`NODE_ENV=production`. `.env.example` ships with dev mode on and no secrets.

`docs/configuration.md` is the full variable reference. Do not duplicate it
here.

Common commands, all run from the repository root:

```bash
npm run build       # compile @cerberus/api and @cerberus/mcp-mongodb
npm run typecheck   # tsc --noEmit across both TypeScript workspaces
npm test            # node:test suite for the API workspace
npm run dev         # MCP adapter on :3001 and API on :8080, watch-reloading
npm run start       # the same two services from compiled output
npm run verify      # PowerShell smoke/verification runner (Windows)
```

`npm run dev` and `npm run start` both load the repository-root `.env` and start
the API with `MCP_SERVER_ENDPOINT` pointed at the MCP adapter. To run the whole
stack in containers instead, use `docker compose up --build`.

For the console:

```bash
cd apps/console
flutter pub get
flutter analyze
dart format --output=none --set-exit-if-changed .
flutter run -d chrome --dart-define=API_BASE_URL=http://localhost:8080
```

The console is a Flutter web app and is not containerised by `docker-compose.yml`.

## Repository layout

```
apps/api/                 Node + TypeScript Hono HTTP API (ingestion, risk analysis, review)
  src/config.ts           environment loading and fail-closed validation
  src/index.ts            Hono app assembly: CORS, auth, routes, error handlers
  src/middleware/auth.ts  API-key authentication boundary (constant-time compare)
  src/routes/             HTTP route modules (health, identity, scenarios, guardian, review, auditor)
  src/services/           MCP client and outbound notification helpers
  src/ai/                 OpenAI provider boundary and response parsers
  test/                   node:test suites, run by `npm test`
apps/console/             Flutter web operator console
packages/mcp-mongodb/     TypeScript MCP server for MongoDB (persistence sidecar)
  src/tool-names.ts       canonical MCP tool and collection names
  src/http-adapter.ts     HTTP transport used by the API
scripts/                  local service launchers, smoke/stress and verification runners
docs/                     architecture and configuration documentation
```

The root `package.json` declares the npm workspaces (`apps/api` and
`packages/mcp-mongodb`) and the aggregate scripts. The Flutter console is not an
npm workspace and is built with the Flutter toolchain.

## Coding conventions

- TypeScript, ESM only. `"type": "module"` is set in every manifest.
- Relative imports must carry the `.js` extension (`./config.js`), even from
  `.ts` sources. This is required by Node's ESM resolver.
- TypeScript strict mode is on. Do not add `any` or non-null assertions to
  silence the compiler; fix the type instead.
- Tests use the Node built-in test runner (`node:test`) executed through `tsx`.
  No additional test framework is used.
- Keep provider-specific code behind a small interface. All inference goes
  through the single `OpenAIProvider` boundary.
- Errors returned to clients use stable application-owned error codes. Never
  surface framework, provider, database, or raw JSON errors.
- Configuration is read once at startup and validated fail-closed. Never log
  secret material; log `set` / `unset` instead.
- Never widen CORS to `*`. Cross-origin access is an explicit allow-list.
- Flutter code follows `package:flutter_lints/flutter.yaml` as configured in
  `apps/console/analysis_options.yaml`. Run `flutter analyze` and
  `dart format` before submitting console changes.

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` a new capability
- `fix:` a bug fix
- `docs:` documentation only
- `chore:` maintenance, dependencies, tooling
- `refactor:` behaviour-preserving restructuring
- `test:` test-only changes
- `ci:` continuous integration changes

Write the subject in the imperative mood and keep it under about 72 characters.
Use the body to explain why the change is needed, not to restate the diff.

## Pull requests

- Keep the change scoped to one concern. Unrelated cleanups belong in their own
  pull request.
- Include tests for behaviour changes. A behaviour change without a test will
  normally be sent back.
- Run `npm run typecheck` after any structural change — moving files, renaming
  exports, or changing imports. A typecheck that passed before your edit does
  not cover the edit.
- Do not commit secrets, tokens, API keys, `.env` files, or credentials of any
  kind. `.gitignore` already excludes `.env` and key material; keep it that way.
- Update documentation when behaviour or configuration changes.
- Update `CHANGELOG.md` for user-visible changes.
- Use the pull request template and fill in every section, including the scope
  boundaries and the exact commands you ran.

## Licensing and contributor agreements

No CLA is required to contribute to Cerberus.

Contributions are accepted under the Apache License 2.0, the same license as
the project. By opening a pull request you agree that your contribution is
submitted under those terms, consistent with section 5 of the license. There is
no separate copyright assignment and no sign-off requirement.

## Security issues

Do not report security vulnerabilities through a public issue, discussion, or
pull request. Follow `SECURITY.md` instead.

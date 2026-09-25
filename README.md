# Cerberus

Cerberus is a self-hosted telemetry service that ingests fine-grained terminal
activity from a browser-based operator console, scores it with an LLM for
insider-threat and data-exfiltration indicators, and persists sessions, events
and risk assessments in MongoDB.

> **Status: 0.1.0 — first independent open-source release, published as a
> pre-release.** This is an experimental research system. It is not production
> ready, and it makes no guarantee that it will detect or prevent anything. Read
> the [Security & privacy warning](#security--privacy-warning) before running it.

## What problem it solves

Insider data exfiltration in regulated environments is usually reconstructed
after the fact from coarse logs: a file was downloaded, a repository was cloned,
a transfer was approved. The behavioural signals that precede those events —
pasting a large external block into a workspace, alt-tabbing away mid-task,
opening browser dev tools, copying selections, typing at superhuman speed — are
typically not captured at all.

Cerberus explores whether those micro-signals can be collected continuously,
scored by a model, and surfaced to an operator as a reviewable session record.
It is a research vehicle for that idea, not a compliance product.

## Core capabilities

Implemented today:

- **Streaming micro-event telemetry ingestion** over `POST /api/v1/guardian/ingest`,
  covering twelve event types: keystrokes, paste triggers, code deltas, tab
  switches, window blur, copy attempts, dev-tools open, fullscreen exit,
  external app switch, edits, submissions and pastes. Session state is held in
  memory.
- **Multi-layer deduplication** before spending inference: identical
  risk-assessment id, code-hash equality to skip re-analysis of an unchanged
  workspace, a 128-entry micro-event fingerprint ring to suppress replayed
  batches, and a behavioural-counter score blend.
- **AI risk analysis** producing a `RiskAssessmentPayload` with six risk
  dimensions, `RiskFlag`s, an `ExfiltrationReport` (similarity matches) and
  `BehavioralAnomaly`s.
- **Behavioural anomaly detection**: paste abuse, focus breaches, copy attempts
  and anomalous keystroke rhythm.
- **Agentic auto-lock** at risk >= 75 and auto-clear below 25, propagated to
  in-memory state and to MongoDB.
- **Threat scenario authoring** (`POST /api/v1/scenarios`) producing monitored
  target systems, regulatory mandates, threat vectors with detection rules, and
  penetration scenarios carrying anti-exfiltration thresholds. Guarded by a
  deterministic regex pre-filter plus a fail-closed AI classifier. The console
  sends its three risk-distribution sliders as a structured `severityMix`
  (`routine → low`, `elevated → medium`, `severe → 60% high / 40% critical`).
- **Session review** with a reconstructed event timeline and risk summary, plus
  session terminate (preserves data) and delete (removes data).
- **Natural-language auditor** over session records, restricted to a whitelisted
  subset of aggregation stages applied in-process.
- **MongoDB persistence** through an MCP server, with idempotent index creation.
- **Optional Slack webhook and SendGrid email** notifications for high-risk
  incidents.

Not implemented — see [Roadmap](#roadmap).

## Architecture summary

Three components:

| Path | What it is |
| --- | --- |
| `apps/api` | Node 20+ / TypeScript HTTP API (Hono, ESM). Owns auth, CORS, routing, session state and the AI boundary. |
| `apps/console` | Flutter web operator console (Dart). |
| `packages/mcp-mongodb` | TypeScript MCP server for MongoDB, with a stdio transport and an HTTP adapter used by the API as a persistence sidecar. |

There is exactly one AI provider boundary: OpenAI Chat Completions through the
official `openai` SDK, in `apps/api/src/ai/provider.ts` (class `OpenAIProvider`).
Model output is treated as untrusted text and handed to the defensive parsers in
`apps/api/src/ai/parsers.ts`.

```text
  ┌──────────────────────────┐
  │  Operator console        │  Flutter web (apps/console)
  │  browser telemetry       │  keystrokes, paste, focus, copy, dev-tools
  └────────────┬─────────────┘
               │  HTTPS + operator API key
               │  POST /api/v1/guardian/ingest  (batched micro-events)
               ▼
  ┌──────────────────────────────────────────────┐
  │  Cerberus API  (apps/api)                    │
  │  Hono · auth · CORS · correlation ids        │
  │                                              │
  │  ┌────────────────┐   ┌───────────────────┐  │
  │  │ session state  │   │ dedup layers      │  │
  │  │ (in-memory)    │   │ code hash + ring  │  │
  │  └────────────────┘   └───────────────────┘  │
  └───────┬──────────────────────────┬───────────┘
          │                          │
          │ OpenAI SDK               │ HTTP + bearer token
          │ (chat completions)       │ POST /tools/:toolName
          ▼                          ▼
  ┌──────────────────┐   ┌───────────────────────────────┐
  │  OpenAI          │   │  MCP MongoDB adapter          │
  │  Chat Completions│   │  (packages/mcp-mongodb,       │
  │  API             │   │   src/http-adapter.ts)        │
  └──────────────────┘   └───────────────┬───────────────┘
                                         │ MongoDB driver
                                         ▼
                         ┌───────────────────────────────┐
                         │  MongoDB  (database: cerberus)│
                         │  threat_scenarios             │
                         │  monitored_sessions           │
                         │  micro_events                 │
                         │  risk_assessments             │
                         └───────────────────────────────┘
```

The MCP package also ships a stdio transport (`src/server.ts`) that exposes the
identical tool registry to MCP-capable agent hosts. The API always talks to the
HTTP adapter.

See [docs/architecture.md](docs/architecture.md) for the component map, data
flows, session state model, deduplication layers, persistence model and trust
boundaries.

## Quick start

### Docker

```bash
cp .env.example .env      # then edit .env and set OPENAI_API_KEY
docker compose up --build
```

`docker-compose.yml` starts a local `mongo:7` service plus the Cerberus
container, and publishes the API on `http://localhost:8080`; `GET /health` is
unauthenticated. MongoDB is bound to `127.0.0.1:27017` on the host.

`.env.example` sets `CERBERUS_DEV_MODE=true` and `NODE_ENV=development`, which
is the right default for a local stack: authentication is disabled and localhost
CORS origins are allowed automatically. `OPENAI_API_KEY` still has to be set —
the API refuses to start without it. For anything reachable by another machine,
set `CERBERUS_DEV_MODE=false`, `NODE_ENV=production`, and fill in
`CERBERUS_API_KEY` and `CERBERUS_MCP_TOKEN`.

The Flutter console is not containerised. Run it separately:

```bash
cd apps/console
flutter pub get
flutter run -d chrome \
  --dart-define=API_BASE_URL=http://localhost:8080 \
  --dart-define=CERBERUS_API_KEY=<your CERBERUS_API_KEY>
```

Both defines have defaults (`http://localhost:8080` and an empty key), so with
`CERBERUS_DEV_MODE=true` the console connects with no key at all. Against an
authenticated API you must supply the key.

To produce a deployable bundle instead of a dev session, run this **from
`apps/console`**:

```bash
cd apps/console
flutter build web --release \
  --dart-define=API_BASE_URL=https://your-cerberus-host \
  --dart-define=CERBERUS_API_KEY=<your CERBERUS_API_KEY>
```

The bundle is written to **`apps/console/build/web/`** — that is, `build/web`
relative to `apps/console`, the directory you ran the command from. It is a
plain static directory (`index.html`, `main.dart.js`, `assets/`, `canvaskit/`
and the service worker), so serve it with any static file server or reverse
proxy, for example:

```bash
cd apps/console/build/web
python -m http.server 5173
```

`build/` is gitignored, so it never appears in a commit.

> **Note:** `--dart-define` values are compiled into the web bundle, so anyone
> who can fetch the bundle can read the API key. Serve the console only to
> trusted operators, or place it behind a proxy that injects the credential.

The console can also be verified without a backend:

```bash
cd apps/console
flutter analyze     # must be clean
flutter test        # runs on the Dart VM; no browser or server needed
```

### Local, without Docker

Requires Node 20 or newer and a reachable MongoDB.

```bash
npm install
npm run build            # or: npm run dev  (tsx watch, auto-reload)
```

`npm run dev` (via `scripts/dev-services.js`) loads the repository-root `.env`,
starts the MCP adapter on `MCP_PORT` (default 3001) bound to `MCP_BIND_HOST`
(default `127.0.0.1`), and starts the API on `PORT` (default 8080) with
`MCP_SERVER_ENDPOINT` pointed at the adapter. `npm start`
(`scripts/start-services.js`) runs the same pair from compiled output.

Verify the API is up:

```bash
curl http://localhost:8080/health
```

A minimal authenticated call:

```bash
curl -X POST http://localhost:8080/api/v1/scenarios \
  -H "Authorization: Bearer $CERBERUS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"insider exfiltration against the core trading ledger","roleContext":"core-trading-ledger","vectorCount":3}'
```

The Flutter console is built separately and is not started by either launcher;
use the `flutter run` command shown under [Docker](#docker) above.

## Configuration

All configuration is environment-based. The API reads it once at startup and
refuses to boot when a mandatory secret is missing.

| Variable | Default | Notes |
| --- | --- | --- |
| **Server** | | |
| `PORT` | `8080` | API listen port. |
| **AI provider** | | |
| `OPENAI_API_KEY` | — | **Required.** |
| `OPENAI_MODEL_NAME` | `gpt-5.6` | Model id sent to Chat Completions. |
| `OPENAI_MAX_OUTPUT_TOKENS` | `65536` | Sent as `max_completion_tokens`. |
| `OPENAI_TEMPERATURE` | unset | Optional. Omitted from the request unless set; `gpt-5.6` rejects any value but its own default. |
| `OPENAI_REQUEST_TIMEOUT_MS` | `180000` | Per-attempt SDK timeout. |
| `OPENAI_BASE_URL` | — | Optional base URL override for proxies or gateways. |
| **MongoDB / MCP** | | |
| `MONGODB_URI` | `mongodb://localhost:27017` | Read by the MCP server. |
| `MONGODB_DATABASE` | `cerberus` | |
| `MCP_SERVER_ENDPOINT` | `http://localhost:3001` | Where the API finds the MCP adapter. |
| `MCP_PORT` | `3001` | MCP adapter listen port. |
| `MCP_BIND_HOST` | `127.0.0.1` | Keep on loopback unless you intend to expose it. |
| `MCP_TIMEOUT_MS` | `10000` | Default MCP call timeout (per-route callers use 5000 ms). |
| **Authentication** | | |
| `CERBERUS_API_KEY` | — | **Required** unless `CERBERUS_DEV_MODE=true`. Operator key. |
| `CERBERUS_MCP_TOKEN` | — | **Required** unless `CERBERUS_DEV_MODE=true`. Bearer token the API presents to the MCP adapter. |
| `CERBERUS_DEV_MODE` | `false` | `true` **disables authentication**. Refused when `NODE_ENV=production`. |
| **CORS** | | |
| `CERBERUS_CORS_ORIGINS` | — | Comma-separated allow-list. Empty means no cross-origin access. |
| `CERBERUS_MCP_CORS_ORIGINS` | — | Comma-separated allow-list for the MCP adapter. Empty means no CORS headers at all. |
| **Detection thresholds** | | |
| `SESSION_TTL_SECONDS` | `7200` | Enforced session lifetime. Expiry stops monitoring; it never deletes evidence. Must be a positive whole number of seconds. |
| `MAX_PASTE_EVENTS` | `5` | Paste count above which analysis is forced. |
| `MIN_HUMAN_KEYSTROKE_MS` | `80` | Inter-key delay treated as the human floor. |
| `DATA_LEAKAGE_SIMILARITY_THRESHOLD` | `0.75` | Currently inert; see [Roadmap](#roadmap). |
| **Notifications (optional)** | | |
| `SLACK_WEBHOOK_URL` | — | Unset = Slack notification is skipped. |
| `SENDGRID_API_KEY` | — | Email requires all three of key, from and to. |
| `EMAIL_FROM` | — | |
| `EMAIL_TO` | — | |

Full type/default/security detail, plus worked development and production
examples, is in [docs/configuration.md](docs/configuration.md). The annotated
`.env.example` is the canonical starting point for a local stack.

## Security & privacy warning

**This software observes employee terminal activity.** Deploying it has legal
and ethical implications that are yours to resolve, not the project's:

- Monitoring employees may require notice, consent, or consultation with a
  works council or employee representative body, depending on your
  jurisdiction.
- Recording terminal activity is likely to process personal data. Data
  protection law (for example GDPR) applies to the operators you monitor, and
  may require a lawful basis, a retention limit and an impact assessment.
- Telemetry can contain sensitive content. `codeSnapshot`, `pasteSnippets`,
  `copyContent` and `terminalSnapshot` capture whatever was in the monitored
  workspace or clipboard, which may include secrets, customer data or
  third-party material.
- The API is a single-tenant service guarded by one shared key. There is no
  per-user attribution, no role separation and no audit trail of who queried
  what.

Run Cerberus only on systems you are authorised to monitor, and only with the
knowledge of the people using them.

See [docs/security/threat-model.md](docs/security/threat-model.md) and
[SECURITY.md](SECURITY.md).

## Documentation

**[docs/index.md](docs/index.md) is the entry point to the documentation set** —
it lists every document under `docs/` with the audience it is written for.

The documents most readers want first:

- [docs/architecture.md](docs/architecture.md) — components, data flows, state and persistence model.
- [docs/configuration.md](docs/configuration.md) — every environment variable.
- [docs/security/threat-model.md](docs/security/threat-model.md) — assets, actors, trust boundaries and limits.
- [docs/migration.md](docs/migration.md) — historical name → current name mapping.
- [docs/development/maturity-plan.md](docs/development/maturity-plan.md) — current maturity state, next work and accepted limitations.

Repository-level documents:

- [SECURITY.md](SECURITY.md) — how to report a vulnerability.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute.
- [CHANGELOG.md](CHANGELOG.md) — release history.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SUPPORT.md](SUPPORT.md) — community expectations and where to ask for help.
- [docs/release/](docs/release/) — the `v0.1.0` release notes, release checklist, community-health checklist and repository metadata, kept as a record of that release.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first for the
build, typecheck and test commands (`npm run build`, `npm run typecheck`,
`npm test`) and the expectations for a change. For anything security-relevant,
follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Roadmap

Everything below is **not implemented**. It is listed so that the gap between
what this repository does and what an operator would need is explicit.

- **Endpoint agent.** The process that would emit telemetry from a real
  workstation does not exist. All telemetry today originates from the
  browser-based console.
- **Reference completions for similarity comparison.** The reference set is not
  populated, so exfiltration similarity matching currently returns empty
  matches.
- **Multi-user identity and authorization.** Accounts, roles, OAuth/SSO.
- **Multi-tenancy.** The service is single-tenant with one shared key.
- **Durable session state.** Live state is in memory and is lost on restart.
- **Replay protection** beyond TLS, and automated key rotation.
- **Migration tooling** for the historical schema (see
  [docs/migration.md](docs/migration.md)).

## Project provenance

Cerberus originated as **Cerberus FinSec** in the **Google Cloud Rapid Agent
Hackathon 2026** (Financial Services track, MongoDB partner track), where it was
built on Google Cloud Agent Builder with Gemini as the model. The AI boundary
was migrated to the OpenAI SDK later, during **OpenAI Build Week 2026** (Agentic
Coding track). It was subsequently extracted from the historical
`Google-Cloud-Hackathon` repository into this independent open-source project,
which is why some historical naming survives in documentation and in the
console. This repository does not support the historical schema or tool names;
see [docs/migration.md](docs/migration.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).

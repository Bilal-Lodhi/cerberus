# 🔒 Cerberus FinSec — Insider Threat & Data Exfiltration Guardian

**Google Cloud Rapid Agent Hackathon 2026** — *Google Cloud Financial Services Track*

Cerberus FinSec replaces legacy financial compliance audit platforms with a fully autonomous,
Google Cloud-native insider threat detection engine. Built on **Google Cloud Agent Builder**
with **Hono** as the API runtime layer, **TypeScript**, **Gemini 3 Flash**, and
**Model Context Protocol (MCP)** for the Financial Services track with **MongoDB Atlas** grounding.

**MongoDB Atlas Partner** — All session telemetry, micro-events, compliance matrices, and suspicion reports are persisted to MongoDB Atlas through a 10-tool MCP server with automatic index management and connection pooling. MongoDB Atlas serves as the durable grounding layer for the entire Cerberus FinSec platform.

---

## 🏆 Full Test Suite — All 3 Suites Passed (June 9, 2026)

> **VERDICT: PRODUCTION READY** ✅ — Zero failures across all test suites

| Suite | Test | Results | Time |
|-------|------|---------|------|
| **1/3** | 12-Endpoint Smoke Test | **13/13 passed**, 0 failed | 46s |
| **2/3** | Telemetry — 12 Event Types + Lifecycle | **18/18 passed**, 0 failed | 32s |
| **3/3** | 50 Concurrent Request Burst | **50/50 OK**, 0 failed | 251s |
| **Total** | | **3/3 suites**, 329s | |

### Suite 3 Burst Report Highlights

| Metric | Gemini Generate (Vertex AI) | Micro-Event Ingest (MongoDB) |
|--------|---------------------------|------------------------------|
| Sent | 25 | 25 |
| Success | **25 (100%)** | **25 (100%)** |
| Failed | 0 | 0 |
| Avg Latency | 32,559ms | **193ms** |
| Throughput | 0.1 req/sec | 4.3 req/sec |
| MongoDB Ops/Sec | — | ~4.3 (limit: 100 — **well under**) |

All 12 event types verified: `KEYSTROKE`, `PASTE_TRIGGER`, `CODE_DELTA`, `TAB_SWITCH`, `WINDOW_BLUR`, `COPY_ATTEMPT`, `DEVELOPER_TOOLS_OPEN`, `FULLSCREEN_EXIT`, `EXTERNAL_APP_SWITCH`, `SUBMIT`, `EDIT`, `PASTE` — plus session lifecycle (deploy → ingest → review → terminate → delete).

### How to Run Tests

```powershell
# Run all 3 test suites
pwsh -File sandbox/run-all-tests.ps1

# Individual tests
pwsh -File sandbox/test-all-10.ps1       # 13 endpoint smoke
pwsh -File sandbox/test-telemetry.ps1    # 18 event types + lifecycle
pwsh -File sandbox/test-stress.ps1       # 50 concurrent burst (5 waves of 5)
```

---

## 🔗 How Cerberus FinSec Uses Google Cloud Agent Builder

Cerberus FinSec runs on **Google Cloud Agent Builder** as its orchestration
platform. The Hono API layer serves as the **hosting runtime for Agent Builder
webhook extensions** — each agent endpoint (`/generate`, `/guardian/ingest`,
`/guardian/deploy`) acts as an Agent Builder tool target. The flow works as follows:

1. **Agent Builder manages orchestration**: Compliance matrix generation requests
   are routed through Agent Builder's conversation engine, which handles
   multi-turn state management and context threading.
2. **Hono acts as the tool-execution runtime**: When Agent Builder invokes a
   tool (e.g., `generate_compliance_matrix`), the webhook hits the corresponding
   Hono endpoint, which calls Gemini 3 Flash via the `@google/genai` Vertex AI
   SDK (authenticated with Application Default Credentials) and returns
   structured JSON output. Exponential backoff with 3 retries ensures
   reliable large-matrix generation.
3. **MCP Server provides the grounding layer**: All session data, employee
   telemetry, and risk assessment payloads are persisted to MongoDB Atlas through
   the Model Context Protocol server, which Agent Builder can query for
   conversational context.
4. **Gemini 3 Flash handles inference**: All model inference runs on the
   mandated `gemini-3-flash-preview` model through Google Cloud's Vertex AI
   SDK (`@google/genai` with `vertexai: true`) with ADC authentication.

This architecture satisfies the hackathon's three core platform requirements
simultaneously: Google Cloud Agent Builder (orchestration), Gemini 3 (model
via enterprise Vertex AI), and MCP with MongoDB (grounding).

---

## Table of Contents

- [🏆 Full Test Suite — All 3 Suites Passed](#-full-test-suite--all-3-suites-passed-june-9-2026)
- [How Cerberus FinSec Uses Google Cloud Agent Builder](#-how-cerberus-finsec-uses-google-cloud-agent-builder)
- [Architecture Overview](#-architecture-overview)
- [Project Structure](#-project-structure)
- [Quick Start](#-quick-start)
  - [Prerequisites](#prerequisites)
  - [Install Dependencies](#1-install-dependencies)
  - [Configure Environment](#2-configure-environment)
  - [Build & Run Locally](#3-build--run-locally)
  - [Deploy to Cloud Run](#4-deploy-to-cloud-run)
- [API Endpoints](#-api-endpoints)
  - [`POST /api/v1/generate` — Compliance Matrix Generator](#post-apiv1generate--compliance-matrix-generator)
  - [`POST /api/v1/guardian/ingest` — Insider Threat Guardian](#post-apiv1guardianingest--insider-threat--data-exfiltration-guardian)
  - [`GET /api/v1/guardian/sessions/:sessionId` — Live Session Risk](#get-apiv1guardiansessionssessionid--live-session-risk)
  - [`GET /api/v1/sessions` — List All Sessions](#get-apiv1sessions--list-all-sessions-dashboard-drawer)
  - [`GET /api/v1/sessions/:sessionId` — Audit Review Log](#get-apiv1sessionssessionid--audit-review-log)
  - [`GET /health` — Health Check](#get-health--health-check)
  - [Identity Endpoints](#-identity-endpoints-personalization-layer)
- [Input Validation & Resilience](#-input-validation--resilience)
- [Human-Readable Timestamps](#-human-readable-timestamps)
- [Defensive JSON Parsing Pipeline](#-defensive-json-parsing-pipeline)
- [Session Persistence & Post-Restart Recovery](#-session-persistence--post-restart-recovery)
- [Session Drawer -- Categorization & Refresh](#-session-drawer--categorization--refresh)
- [Close, Kill & Delete Session Controls](#close-kill--delete-session-controls)
- [Event Deduplication Pipeline](#-event-deduplication-pipeline)
- [Code Workspace Telemetry — Copy, Paste & Tab Detection](#-code-workspace-telemetry--copy-paste--tab-detection)
- [Generate Panel UX Enhancements](#-generate-panel-ux-enhancements)
- [Real-Time Risk Notification UI](#-real-time-risk-notification-ui)
- [MongoDB MCP Tools](#%EF%B8%8F-mongodb-mcp-tools--10-tools-via-http-adapter)
- [Agent Design Philosophy](#-agent-design-philosophy)
- [Session Lock — Workspace Freeze on Risk Alert](#-session-lock--workspace-freeze-on-risk-alert)
- [AI Studio API Key Support](#-ai-studio-api-key-support)
- [Hackathon Compliance Checklist](#-hackathon-compliance-checklist)
- [Telemetry & Testing](#-telemetry--testing)

---

## 🏗 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      FLUTTER COMPLIANCE DASHBOARD                       │
│  ┌──────────────────────┐  ┌─────────────────────────────────────────┐ │
│  │  Terminal Workspace   │  │  Security Timeline + Risk Gauge         │ │
│  │  (Left Panel)         │  │  (Right Panel)                          │ │
│  │  - Live code monitor  │  │  - SSE-powered live updates             │ │
│  │  - Anomaly detection    │  │  - Color-coded risk severity           │ │
│  └──────────────────────┘  │  - Expandable behavioral flags           │ │
│                             └─────────────────────────────────────────┘ │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ HTTP/SSE
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     HONO API LAYER (Cloud Run)                          │
│  ┌─────────────────┐ ┌──────────────────┐ ┌────────────────────────┐   │
│  │ POST /generate  │ │ POST /guardian   │ │ GET /sessions          │   │
│  │  Compliance      │ │  /ingest         │ │ GET /sessions/:id      │   │
│  │  Matrix Gen      │ │ POST /guardian   │ │                        │   │
│  │                  │ │  /deploy         │ │                        │   │
│  └───────┬─────────┘ └───────┬──────────┘ └───────────┬────────────┘   │
│          │                   │                        │                │
│          ▼                   ▼                        ▼                │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                  GEMINI AGENT PIPELINE                            │  │
│  │  ┌────────────────────┐  ┌──────────────────────────────────┐    │  │
│  │  │ CISO Orchestrator   │  │ Insider Threat Guardian           │    │  │
│  │  │ (gemini-3-flash)    │  │ (gemini-3-flash reasoning)        │    │  │
│  │  │                    │  │                                   │    │  │
│  │  │ • Prompt → Matrix  │  │ • Paste trigger detection         │    │  │
│  │  │ • JSON contract    │  │ • Keystroke anomaly analysis      │    │  │
│  │  │ • Regulatory map   │  │ • Tab switch / window blur        │    │  │
│  │  │ • Penetration      │  │ • Code similarity scoring         │    │  │
│  │  │   scenarios        │  │ • Auto-creates audit sessions     │    │  │
│  │  │ • 90s timeout      │  │                                   │    │  │
│  │  └────────────────────┘  └──────────────────────────────────┘    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ MCP (Model Context Protocol)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│               MCP SERVER — MONGODB ATLAS GROUNDING                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │ Sessions     │  │ Micro-Events  │  │ Risk Reports  │                  │
│  │ Collection   │  │ Collection   │  │ Collection   │                  │
│  └──────────────┘  └──────────────┘  └──────────────┘                  │
│                                                                         │
│  Exposes 10 MCP tools via HTTP adapter:                                 │
│  • store_compliance_matrix / get_compliance_matrix                      │
│  • create_session (monitored employee session)                          │
│  • ingest_micro_events (batch behavioral telemetry)                     │
│  • store_suspicion_report (threat analysis)                             │
│  • get_session_review / get_employee_report / list_sessions             │
│  • close_session / delete_session (lifecycle controls)                  │
│  • health_check                                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 📂 Project Structure

```
Google-Cloud-Hackathon/
├── .gitignore                       # Blocks **/.env and node_modules
├── LICENSE                          # Apache 2.0 (OSI-approved)
├── package.json                     # npm workspace: hono-api + mcp-server
└── sandbox/
    ├── README.md                    # ← THIS FILE
    ├── CURL_COMMANDS.md             # Smoke-test curl commands
    ├── package.json                 # Workspace scripts
    ├── Dockerfile                   # Multi-stage Cloud Run container
    ├── entrypoint.sh                # Concurrent Hono + MCP launcher
    ├── start-services.js            # Node.js dev process manager (production builds)
    ├── dev-services.js              # Auto-reload dev mode (tsx watch)
    ├── run-all-tests.ps1            # Full test suite orchestrator (3 suites)
    ├── test-all-10.ps1              # 13 endpoint smoke test (PowerShell)
    ├── test-telemetry.ps1           # 18 event types + lifecycle test
    ├── test-stress.ps1              # 50 concurrent request burst test
    ├── hono-api/                    # Hono TypeScript API (Cloud Run)
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── .env.example             # Copy to .env and configure
    │   └── src/
    │       ├── index.ts             # Entry point, Hono app bootstrap
    │       ├── config.ts            # Environment config loader
    │       ├── types.ts             # Shared TypeScript contracts (FinSec domain)
    │       ├── agents/
    │       │   └── gemini-client.ts # Vertex AI SDK Gemini 3 Flash client (ADC)
    │       └── routes/
    │           ├── health.ts        # GET /health
    │           ├── generate.ts      # POST /api/v1/generate (compliance matrices)
    │           ├── guardian.ts      # POST /api/v1/guardian/ingest · POST /api/v1/guardian/deploy
    │           ├── review.ts        # GET /api/v1/sessions · GET /api/v1/sessions/:id
    │           └── identity.ts      # POST /api/v1/identity/set · GET /api/v1/identity/me
    ├── mcp-server/                  # MCP Server (MongoDB Atlas Grounding)
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── .env.example             # Copy to .env and configure
    │   └── src/
    │       ├── server.ts            # StdioServerTransport MCP server
    │       ├── mongo-client.ts      # MongoDB native driver + MongoStore
    │       └── http-adapter.ts      # HTTP wrapper for Cloud Run sidecar
    └── frontend/                    # Flutter Compliance Dashboard
        ├── README.md                # Frontend-specific docs
        ├── pubspec.yaml
        └── lib/
            ├── main.dart            # App entry point
            ├── app.dart             # MaterialApp + routing
            ├── models/
            │   ├── health_model.dart
            │   ├── generate_model.dart
            │   ├── guardian_model.dart
            │   └── identity_model.dart
            ├── providers/
            │   ├── health_provider.dart
            │   ├── generate_provider.dart
            │   ├── guardian_provider.dart
            │   ├── review_provider.dart
            │   ├── theme_provider.dart
            │   └── identity_provider.dart
            ├── screens/
            │   ├── dashboard_screen.dart
            │   └── identity_setup_screen.dart
            ├── services/
            │   └── api_service.dart
            ├── theme/
            │   └── app_theme.dart
            └── widgets/
                ├── generate_panel.dart         # Compliance Matrix bottom sheet
                ├── code_workspace_panel.dart
                ├── security_metrics_panel.dart
                └── risk_notification.dart     # Expandable risk notification banner + dialog (tabbed detail, paste snippets, behavioral context, keystroke metrics, animated gauge)
```

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** ≥ 22
- **Google Cloud Project** with Vertex AI API enabled (project ID: `YOUR_PROJECT_ID`)
- **Application Default Credentials** configured (`gcloud auth application-default login`)
- **MongoDB Atlas** connection string (set as `MONGODB_URI`)
- **Flutter SDK** ≥ 3.24 (for the compliance dashboard)

### 1. Install Dependencies

```bash
cd Google-Cloud-Hackathon
npm install
```

### 2. Configure Environment

```bash
cp sandbox/.env.example sandbox/.env
cp sandbox/hono-api/.env.example sandbox/hono-api/.env
cp sandbox/mcp-server/.env.example sandbox/mcp-server/.env
# Edit sandbox/.env with your MONGODB_URI, GEMINI_API_KEY, and GCP_PROJECT_ID
# Edit sandbox/hono-api/.env with your GEMINI_API_KEY (recommended) or GCP_PROJECT_ID + GCP_LOCATION
# Edit sandbox/mcp-server/.env with your MONGODB_URI
```

> **🔐 For Judges: Two Authentication Options — AI Studio Key Recommended**
>
> Cerberus FinSec supports **two** Gemini authentication methods. **Option A (AI Studio API key)
> is strongly recommended** for judging because `gemini-3-flash-preview` is not yet available on
> Vertex AI in all regions, and using `GCP_LOCATION=global` on Vertex AI can fail with 404 errors
> during the preview phase.
>
> **Option A — AI Studio API Key (RECOMMENDED ✅):**
> 1. Get a free API key at [https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)
> 2. Set `GEMINI_API_KEY=your-key-here` in `sandbox/hono-api/.env`
> 3. That's it — no `gcloud` CLI, no ADC, no GCP project needed
>
> **Option B — Vertex AI via ADC (falls back if no API key is set):**
> 1. Run `gcloud auth application-default login` once on your machine
> 2. Set `GCP_PROJECT_ID` and `GCP_LOCATION=global` in `sandbox/hono-api/.env`
> 3. ⚠️ `gemini-3-flash-preview` may not be available; the app auto-falls back to `gemini-2.5-flash`
>
> **Priority:** If `GEMINI_API_KEY` is set, it takes precedence over Vertex AI/ADC.
> Both paths provide identical model capabilities.

Key configuration options in `.env.example`:

| Variable | Default | Description |
|----------|---------|-------------|
| `GCP_PROJECT_ID` | `YOUR_PROJECT_ID` | Google Cloud project ID for Vertex AI |
| `GCP_LOCATION` | `global` | Vertex AI endpoint — use `global` for Gemini 3 Flash Preview |
| `GEMINI_MODEL` | `gemini-3-flash-preview` | Model to use for all inference |
| `GEMINI_MAX_OUTPUT_TOKENS` | `65536` | Max tokens for Gemini responses (prevent truncation on large matrices) |
| `GEMINI_TEMPERATURE` | `0.2` | Determinism control (lower = more deterministic) |
| `MCP_SERVER_ENDPOINT` | `http://localhost:3001` | MCP server URL |
| `SESSION_TTL_SECONDS` | `7200` | Session expiry (2 hours) |
| `MAX_PASTE_EVENTS` | `5` | Max paste events before auto-flagging |
| `DATA_EXFILTRATION_THRESHOLD` | `0.75` | Semantic similarity threshold for exfiltration detection |

### 3. Build & Run Locally

```bash
# Build TypeScript
npm run build -w sandbox/hono-api
npm run build -w sandbox/mcp-server

# Option A: Production mode (compiled JS)
node sandbox/start-services.js

# Option B: Auto-reload dev mode (tsx watch — no build needed)
node sandbox/dev-services.js
```

- Hono API → `http://localhost:8080`
- MCP Server HTTP Adapter → `http://localhost:3001`

### 4. Deploy to Cloud Run

```bash
gcloud builds submit --config=cloudbuild.yaml
gcloud run deploy cerberus-finsec-api --image=gcr.io/$PROJECT_ID/cerberus-api \
  --platform=managed --region=us-central1 --allow-unauthenticated
```

---

## 🔧 API Endpoints

### `POST /api/v1/generate` — Compliance Matrix Generator

Accepts a text prompt and returns a structured JSON compliance matrix via the
CISO Orchestrator Agent running on Gemini 3 Flash (`gemini-3-flash-preview`).
Generates target system profiles, regulatory mandate maps, threat vectors, and
penetration scenarios. Authenticated via Application Default Credentials with
3-retry exponential backoff. Supports explicit system targeting and severity
distribution tuning.

**Request:**
```json
{
  "prompt": "Generate a compliance audit matrix for a high-frequency trading desk covering FINRA and SOX mandates...",
  "roleContext": "core-trading-ledger",
  "problemCount": 5
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `prompt` | `string` | ✅ Yes | — | Natural-language description of the compliance domain |
| `roleContext` | `string` | No | `"mid-level developer"` | Target system context (e.g. "core-trading-ledger", "swift-gateway") |
| `problemCount` | `number` | No | `5` | Number of threat vectors to generate (1–10) |

**Response:** Complete `GeneratedComplianceMatrix` object with `MatrixMetadata`,
`TargetSystem[]`, `RegulatoryMandate[]`, `ThreatVector[]`, and `PenetrationScenario[]`.
See `types.ts` for full schema.

#### Gemini-First Semantic Intake Classifier

Every prompt is routed through a two-stage Gemini classifier
(`classifyComplianceIntent`) before generation:

- **Stage 1 — Meaningfulness**: Gemini determines if the input is coherent
  language (rejecting gibberish, single words, greetings, keyboard mashing)
- **Stage 2 — Compliance Relevance**: Validates the input describes a compliance
  audit/threat matrix generation request, detecting the domain and audit type
- Returns a verdict with `confidence` score, `detectedDomain`, and
  `detectedComplianceType`
- Robust JSON response parsing with a three-tier fallback chain: direct parse
  → `repairJson()` → `extractJsonObject()`
- Every response includes a `pipeline` diagnostics field exposing the
  classifier's decision, enabling full observability

#### Cancel & Resume Generation

Long-running compliance matrix generation can be cancelled mid-flight. A **Cancel Generation**
button appears in the Flutter UI while Gemini is generating. Tapping it shows a
confirmation dialog; on confirmation, the client sends a cancellation signal via
`POST /api/v1/generate/cancel` with the `X-Generation-Request-Id` header.

- **Cancel flow**: The Hono API registers an `AbortController` per request ID.
  When a cancel request arrives, the controller aborts the in-flight Gemini
  Vertex AI call, the stream terminates, and the server returns a `cancelled: true`
  response. The UI transitions to a cancelled state with a **Resume Generation**
  button.
- **Resume flow**: Tapping Resume re-initiates generation with the exact same
  prompt, system context, and threat vector count — but under a fresh request ID.
  The client increments an internal `_generationSeq` counter to prevent stale
  cancelled responses from clobbering the new request's loading state.
- **Request correlation**: A UUID v4 `X-Generation-Request-Id` header is
  generated client-side before the API call and sent with the request. The
  server uses this ID to register the abort controller, ensuring the cancel
  button targets the correct in-flight Gemini call.

#### Deploy Session (`POST /api/v1/guardian/deploy`)

Once a compliance matrix is generated, it can be deployed as an active monitoring
session via the deploy endpoint. This creates an `ActiveSession` in the in-memory
registry and persists to MongoDB Atlas via the MCP sidecar.

**Request:**
```json
{
  "employeeUid": "op-trader-001",
  "sessionId": "active-ledger-audit",
  "matrixId": "matrix-abc123",
  "targetSystem": "Core Trading Ledger"
}
```

**Response:**
```json
{
  "success": true,
  "sessionId": "active-ledger-audit",
  "employeeId": "op-trader-001",
  "deployedAt": "2026-06-02T12:00:00.000Z",
  "mongoDocumentId": "...",
  "mcpCorrelationId": "..."
}
```

### `POST /api/v1/guardian/ingest` — Insider Threat & Data Exfiltration Guardian

Ingests batched behavioral micro-events and runs Gemini-powered insider threat
analysis using keystroke anomaly detection, paste content similarity scoring,
and behavioral pattern matching. Auto-creates a session if the referenced
`sessionId` does not exist. Returns an `anomalyRiskIndex` (0-100) and triggers
`alertTriggered: true` when the score exceeds 50.

**Request:**
```json
{
  "events": [
    {
      "eventId": "evt-001",
      "sessionId": "sess-abc123",
      "employeeId": "emp-xyz789",
      "auditId": "audit-001",
      "vectorId": "vec-001",
      "eventType": "PASTE_TRIGGER",
      "timestamp": "2026-06-02T10:00:00.000Z",
      "payload": {
        "pasteContent": "function exfiltrateData() { ... }"
      },
      "clientMetadata": {
        "userAgent": "Mozilla/5.0",
        "ipAddress": "127.0.0.1",
        "screenResolution": "1920x1080",
        "platform": "web",
        "language": "en-US"
      }
    }
  ]
}
```

**Response:** Returns `IngestMicroEventResponse` with `processedCount`,
`riskPayload` (a `RiskAssessmentPayload` containing `overallRiskScore`,
`flags`, `behavioralAnomalies`, and `exfiltrationReport`),
`alertTriggered`, and `anomalyRiskIndex`.

Valid `eventType` values: `KEYSTROKE`, `PASTE_TRIGGER`, `CODE_DELTA`,
`TAB_SWITCH`, `WINDOW_BLUR`, `COPY_ATTEMPT`, `DEVELOPER_TOOLS_OPEN`,
`FULLSCREEN_EXIT`, `EXTERNAL_APP_SWITCH`, `SUBMIT`, `EDIT`, `PASTE`.

### `GET /api/v1/guardian/sessions/:sessionId` — Live Session Risk

Returns the current in-memory session state from the Guardian store with live
risk metrics (event counts, paste/tab-switch/fullscreen-exit/copy-attempt
counts, current code, and latest risk assessment payload).

### `GET /api/v1/sessions` — List All Sessions (Dashboard Drawer)

Returns an enriched summary list of all sessions with event counts,
paste/tab-switch metrics, suspicion scores, and peak risk scores. Used by the
Flutter compliance dashboard drawer to populate the session list.

```json
{
  "success": true,
  "data": [
    {
      "sessionId": "ses-clean-001",
      "employeeId": "emp-xyz",
      "auditId": "audit-001",
      "complianceId": "audit-001",
      "status": "active",
      "eventCount": 12,
      "pasteCount": 2,
      "tabSwitchCount": 3,
      "suspicionScore": 45,
      "peakRiskScore": 45,
      "alertTriggered": false,
      "lastEventTimestamp": "2026-06-02T23:40:00.000Z",
      "targetSystem": "Core Trading Ledger",
      "createdAt": "2026-06-02T12:00:00.000Z",
      "startedAt": "2026-06-02T12:00:00.000Z"
    }
  ]
}
```

### `GET /api/v1/sessions/:sessionId` — Audit Review Log

Returns the full session review including terminal workspace content, timeline
(built from micro-events with severity labeling), and risk assessment reports
from MongoDB via the MCP sidecar.

### `GET /health` — Health Check

Returns `{ "status": "ok", "timestamp": "..." }`

### 🔐 Identity Endpoints (Personalization Layer)

A lightweight, password-free identity system for persona-based compliance
demos. Identity is ephemeral — stored in-memory, reset on server restart.
Production deployments integrate with Google Cloud Identity Platform.

#### `POST /api/v1/identity/set` — Register Identity

Sets the current session identity. Returns a `sessionToken` UUID that is
automatically attached to all subsequent API calls via `X-Session-Token` header.

**Request:**
```json
{
  "displayName": "Alice Chen",
  "employeeId": "EMP-001",
  "role": "Senior Trading Desk Operator"
}
```

**Response:**
```json
{
  "success": true,
  "identity": {
    "displayName": "Alice Chen",
    "employeeId": "EMP-001",
    "role": "Senior Trading Desk Operator"
  },
  "sessionToken": "550e8400-e29b-41d4-a716-446655440000"
}
```

#### `GET /api/v1/identity/me` — Get Current Identity

Returns the currently registered identity for the session.

---

## 🛡️ Input Validation & Resilience

All API endpoints implement defense-in-depth input validation to guard against
malformed or unexpected request bodies. The following hardening measures are
applied uniformly across the Hono API layer:

### Request Body Type Guards

Every endpoint validates that `c.req.json()` returns a proper JSON object
before destructuring. Requests with `null`, primitives, or arrays as the
top-level body receive a structured **400 Bad Request** response with a
descriptive error message and a UUIDv4 `correlationId`. This prevents
unhandled `TypeError` crashes caused by property access on non-object values.

The following endpoints have validated body guards:
- **`POST /api/v1/generate`** — rejects non-object bodies; validates
  `prompt` and `roleContext` fields
- **`POST /api/v1/generate/cancel`** — rejects non-object bodies; validates
  `generationRequestId`
- **`POST /api/v1/guardian/ingest`** — rejects non-object bodies; validates
  `events` array
- **`POST /api/v1/guardian/deploy`** — rejects non-object bodies; validates
  `employeeUid`, `sessionId`, `matrixId`, `targetSystem`
- **`POST /api/v1/identity/set`** — rejects non-object bodies with a
  `try/catch` on `c.req.json()` parse; validates `displayName` and
  `employeeId`

### Non-Fatal Gemini Analysis Errors

The Guardian's Gemini-powered risk analysis (`guardian/ingest`) is wrapped in
a `try/catch` block. If Gemini analysis fails (network interruption, model
overload, transient Vertex AI error), the error is logged with a
`[Guardian Route] Gemini analysis FAILED (non-fatal)` message and the ingest
request completes gracefully without a risk payload. The session and events
are still persisted — the frontend simply won't display a live risk score
for that batch.

This ensures a single Gemini outage does not block the entire telemetry
ingestion pipeline.

### MCP Tool Name Consistency

The `persistRiskReport()` function in the Guardian route now calls
`store_suspicion_report` (matching the MCP server's registered tool name).
This fixes a previous HTTP 404 mismatch where the route called
`store_risk_report` which did not exist in the MCP tool registry.

### Field Normalization: `overallRiskScore`

All review endpoints (`GET /api/v1/sessions` and `GET /api/v1/sessions/:id`)
now reference the `overallRiskScore` field from suspicion reports, with a
backward-compatible fallback to the legacy `overallScore` field. This
normalization aligns the API contract with the `RiskAssessmentPayload` type.

### Session Creation Enrichment

The Guardian's `ensureMongoSession()` now passes enriched fields to the MCP
`create_session` tool:
- `candidateId` — mirrors `employeeId` for Atlas indexing
- `assessmentId` — mirrors `auditId` for Atlas indexing
- `status: "in_progress"` — explicit session lifecycle state

### Frontend Prompt Validation

The Flutter compliance dashboard's `GeneratePanel` now performs client-side
validation: an empty audit prompt triggers an inline error message ("Audit
prompt is required") with dedicated error border styling. The required field
indicator (`*`) is displayed next to the "Audit Prompt" label. The error
clears automatically when the user begins typing.

---

## 🕐 Human-Readable Timestamps

All backend timestamps are now normalized through a shared `formatTimestamp()`
utility (`hono-api/src/utils/time.ts`) that converts ISO-8601 dates and MongoDB
`ISODate` objects into a human-readable format (`Jun 2, 2026 at 10:30 PM`).
This ensures consistent timestamp rendering across:

- **Session review responses** (`GET /api/v1/sessions` and `GET /api/v1/sessions/:id`)
- **Suspicion report `generatedAt` fields** — readable in both the Flutter
  dashboard and raw API JSON
- **Micro-event `timestamp` fields** in the session timeline
- **Session metadata** (`createdAt`, `startedAt`, `lastEventTimestamp`)

The utility handles `Date` objects, ISO strings, and MongoDB `$date` extended
JSON objects with a graceful fallback to raw values when parsing fails.

---

## 🧩 Defensive JSON Parsing Pipeline

The Gemini response handling in `gemini-client.ts` now implements a robust
three-tier JSON extraction pipeline to handle malformed or partially-wrapped
model outputs:

### Tier 1 — Direct Parse
The raw response text is first attempted as valid JSON via `JSON.parse()`.
If successful, the structured object is returned immediately — this is the
fast path for well-formed Gemini outputs.

### Tier 2 — `repairJson()`
If direct parsing fails, a built-in heuristic repair function attempts to fix
common structural issues:
- Missing closing quotes on string values
- Unescaped double quotes within string values
- Trailing commas before closing braces/brackets
- Missing commas between object properties
- Single-quoted strings (replaced with double quotes)

### Tier 3 — `extractJsonObject()`
If repair fails, a deep regex-based extraction scans the response for the
outermost balanced `{ ... }` or `[ ... ]` block. The extractor tracks brace
depth to find the valid JSON envelope, strips surrounding text or markdown
fences, and returns the isolated JSON string.

### Graceful Degradation
If all three tiers fail, the pipeline returns a structured error object with
`parseSuccess: false`, a `parseError` description, and the `rawText` for
inspection. This prevents unhandled exceptions from reaching the API layer —
consumers receive a deterministic error payload instead of a 500 crash.

---

## 🔄 Session Persistence & Post-Restart Recovery

Deployed compliance sessions survive server restarts and Cloud Run cold starts
through a three-tier recovery pipeline:

### Tier 1 — In-Memory Fast Path

`GET /api/v1/guardian/sessions` first reads from the in-memory `activeSessions`
Map. When the server process is live and sessions have been deployed, this
returns sub-millisecond responses with enriched risk metrics (paste count, tab
switches, current risk score). This is the default path for active session
monitoring.

### Tier 2 — MongoDB Fallback via MCP

When the in-memory registry is empty (after server restart, Cloud Run scale-to-zero
wake, or container eviction), the Guardian route automatically falls through to
`list_sessions` — the MCP tool that queries MongoDB Atlas. Every previously deployed
session document is deserialized back into an `ActiveSession` and re-hydrated into
the `activeSessions` Map. This means:

- The Flutter dashboard drawer immediately shows all previously deployed sessions
- Subsequent micro-event ingest calls succeed because the session exists in-memory
- Session lifecycle state (`active`, `flagged`, `investigating`, `cleared`) is
  coerced with type-safe validation
- All enriched fields (`peakRiskScore`, `eventCount`, `pasteCount`, `tabSwitchCount`)
  are reconstructed from the MongoDB document

### Tier 3 — Flutter Client Fallback

The Flutter `ApiService.fetchSessions()` implements a parallel fallback chain:

1. **Primary**: `GET /api/v1/sessions` (MongoDB-backed review endpoint, durable
   across restarts) with a 15-second timeout
2. **Fallback**: If the review endpoint returns empty data or times out, the
   client calls `GET /api/v1/guardian/sessions` (the in-memory/MongoDB hybrid
   endpoint described above)

This ensures the session drawer populates even when the MCP sidecar or MongoDB
Atlas is unreachable — as long as in-memory sessions exist.

### Flutter Dashboard UX

The session drawer now displays the **employee UID** as the primary list label
(bold, weight 600) with the **session ID**, **event count**, and **status**
as the subtitle. This makes it easier for compliance officers to identify which
employee each session belongs to at a glance.

---

---

## 📂 Session Drawer -- Categorization & Refresh

The Flutter dashboard session drawer (`dashboard_screen.dart`) now organizes
sessions into categorized groups for efficient navigation and provides manual
refresh capability:

### Session Categorization

Sessions are automatically sorted into collapsible category groups based on
their lifecycle state:

- **Active Sessions** — sessions in `active` or `in_progress` status with a
  green status indicator
- **Flagged Sessions** — sessions with `flagged` status and an amber warning
  indicator
- **Under Investigation** — sessions in `investigating` status with a blue
  info indicator
- **Closed Sessions** — sessions in `closed` or `cleared` status with a grey
  neutral indicator

Each category group displays a count badge and can be independently expanded
or collapsed by the operator, reducing visual clutter in high-volume
compliance environments.

### Drawer Refresh Button

A dedicated **refresh button** (circular `IconButton` with a `refresh` icon)
appears in the drawer header. Tapping it triggers a full re-fetch of session
data through the dual-endpoint fallback chain:

1. Primary call to `GET /api/v1/sessions` (MongoDB-backed)
2. Automatic fallback to `GET /api/v1/guardian/sessions` if the primary
   returns empty or times out

An `isLoading` spinner in the `ReviewProvider` provides visual feedback during
the refresh, and the drawer UI is rebuilt reactively when new data arrives.
This allows compliance officers to pick up newly deployed sessions without
closing and reopening the drawer.

---

## 🛑 Close, Kill & Delete Session Controls

The Flutter dashboard now provides two distinct session lifecycle controls
accessible from the session drawer and the code workspace toolbar:

### Close Session (`POST /api/v1/guardian/sessions/:id/close`)

Gracefully terminates an active monitoring session. The Hono API:
- Sets the session status to `"closed"` in the in-memory `activeSessions` Map
- Calls the MCP `close_session` tool to persist the status change to MongoDB Atlas
- Preserves all existing session data (events, suspicion reports, risk payloads)
  for historical audit review

The session continues to appear in the **Closed Sessions** category of the
drawer and remains queryable via `GET /api/v1/sessions/:id`.

### Delete (Terminate) Session (`DELETE /api/v1/sessions/:id`)

Permanently deletes a session from the active monitoring registry and MongoDB Atlas:
- Removes the session from the in-memory `activeSessions` Map
- Calls the MCP `delete_session` tool to **delete** the session document and
  all associated micro-events from MongoDB Atlas
- Uses the RESTful `DELETE` HTTP method with proper CORS headers
  (`Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`)
- Intended for sessions created in error or test/development cleanup

**⚠️ This action is irreversible** — the Flutter UI shows a confirmation
dialog with a warning message before dispatching the delete request.

### UI Integration

- Each session tile in the drawer includes a **Close** button (grey, with a
  `close` icon) visible for sessions in `active` or `in_progress` status
- A **Delete** button (red, with a `delete_forever` icon) is shown only
  when the operator long-presses a session tile or explicitly expands the
  tile's action menu
- The code workspace panel (`code_workspace_panel.dart`) also exposes close
  and delete (kill) actions in its overflow menu for the currently monitored
  session

### Backend MCP Integration

The MCP HTTP adapter (`mcp-server/src/http-adapter.ts`) registers both
`close_session` and `delete_session` tools to handle session lifecycle state
transitions and permanent removal, bringing the total MCP tool count to
**10 tools**. The `delete_session` tool supports CORS-preflight by
accepting `DELETE` requests on the `/tools/delete_session` endpoint.

---

## 🔁 Event Deduplication Pipeline

The Guardian processes telemetry events at high frequency from the Flutter
code workspace and polling loops. To avoid redundant Gemini inference calls,
repeated risk notifications, and duplicate event storage, a four-tier
deduplication pipeline is now active:

### Tier 1 — Code-Hash Dedup (Backend)

`POST /api/v1/guardian/ingest` computes a SHA-256 hash of `currentCode` before
every Gemini analysis call (`node:crypto`). If the hash matches
`lastAnalyzedCodeHash` stored on the session state, the entire Gemini call is
skipped. The previous `lastRiskPayload` is re-emitted so the frontend
maintains its current risk display without a blank gap.

### Tier 2 — Micro-Event Fingerprint Dedup (Backend)

`processEvent()` now computes a compact fingerprint for every incoming
micro-event (`computeEventFingerprint()`). Identical events (same
`eventType` + serialized payload) arriving within the same second are
silently discarded. The last 128 fingerprints are maintained in a rotating
`Set` on the session state. This prevents the Flutter polling loop from
re-ingesting the same batch when loops overlap.

### Tier 3 — Frontend Risk Payload Dedup

`GuardianProvider._addEventIfNew()` suppresses duplicate
`RiskAssessmentPayload` entries in the live events timeline. Deduplication
is by UUID (`riskAssessmentId`) primarily, with a fallback comparison of
`generatedAt`, `overallRiskScore`, and flag identities.

### Tier 4 — Polling Fallback Cache

`ApiService._lastPolledRiskPayload` caches the most recent payload yielded
through the polling fallback stream. New payloads are only emitted when
`riskAssessmentId` differs or structural signal fields change.
`resetPollingCache()` clears this cache when switching sessions, ensuring
the new session always receives fresh data.

---

## ⌨️ Code Workspace Telemetry — Copy, Paste & Tab Detection

The Flutter code workspace (`code_workspace_panel.dart`) now captures
operational security telemetry beyond keystrokes:

- **Copy Detection**: Dedicated `_handleCopy()` method intercepts Ctrl+C,
  copies selected text (or full text when no selection), and dispatches a
  `COPY_ATTEMPT` micro-event with `copiedLength`, `copiedTextPreview`, and
  `selectedTextLength` fields for forensic review.
- **Paste Detection**: Ctrl+V detection arms a `_isPasting` flag. The next
  `onChanged` computes the exact pasted content delta and immediately sends
  a `PASTE` event (bypassing the debounce timer) with `pasteContent` and
  `changeLength` payload fields.
- **Tab Switch / Window Blur**: `WidgetsBindingObserver` detects
  `AppLifecycleState.paused` and `AppLifecycleState.inactive` transitions,
  dispatching `TAB_SWITCH` events with the browser `visibilityState` for
  full audit trail.

The `MicroEventPayload` model was extended with `copiedLength`,
`copiedTextPreview`, `selectedTextLength`, and `visibilityState` fields.
All events are ingested through the standard Guardian pipeline for
real-time risk scoring.

---

## 🎛️ Generate Panel UX Enhancements

The compliance matrix generation bottom sheet (`generate_panel.dart`) has
been redesigned for operator efficiency:

- **FilledButton CTA**: The app bar "Compliance" button now uses a
  `FilledButton.icon` with `elevation: 2` and a 10px border radius for
  prominence, replacing the previous `TextButton`.
- **Dropdown Target System Selector**: The `ChoiceChip` row for target
  system selection has been replaced with a `DropdownButtonFormField`
  featuring icons, filled surface, and `isExpanded: true` for better
  usability on narrow screens.
- **Risk Distribution Capping**: The three severity weight sliders
  (Routine, Elevated, Critical) now enforce mutual capping so the total
  always sums to exactly 100%. Each slider automatically clamps when
  dragging beyond the remaining available percentage. A `Total: N%` label
  provides real-time feedback.
- **Responsive Layout**: On wide screens (≥ 600px), the sheet is centered
  as a constrained card (max 650px wide) instead of a full-width bottom
  sheet. On narrow screens, the traditional bottom sheet layout is
  preserved.
- **Session Reset on Drawer Selection**: Tapping a session in the drawer
  now calls `GuardianProvider.resetForNewSession()` to clear the previous
  session's risk payload, events, and streaming subscription, then starts
  a fresh SSE stream for the newly selected session.

---

## 🔔 Real-Time Risk Notification UI

The Flutter compliance dashboard now features a full-featured risk notification
system that surfaces insider threat incidents in real-time:

- **Risk Notification Banner**: A dismissible banner appears at the top of both
  wide and narrow dashboard layouts when `alertTriggered` is `true` or the
  `anomalyRiskIndex` reaches ≥ 45, tap-to-expand into the full incident dialog.
- **Expandable Incident Dialog**: Tabbed detail view with **Flags** and
  **Incident** tabs, collapsible paste snippet sections, code snapshot viewer,
  behavioral context grid, keystroke metrics display, and dimension score bars
  with color-coded severity levels.
- **Copy Report**: One-tap copy of the full risk assessment report to clipboard
  for compliance audit trails.
- **Animated Risk Gauge**: A custom animated gauge widget renders the composite
  risk score (0–100) with smooth interpolation and color transitions from green
  (safe) → yellow (elevated) → red (critical).
- **Full Incident Persistence**: The Guardian captures the complete incident
  payload at detection time and persists it via MCP `store_suspicion_report` to
  MongoDB Atlas, ensuring incidents survive browser refresh, process restart,
  and Cloud Run cold starts.
- **Post-Restart Rehydration**: The review endpoint (`GET /api/v1/sessions/:id`
  and `GET /api/v1/sessions`) returns `lastRiskPayload` from in-memory state
  with an automatic MongoDB fallback, allowing the frontend to fully rehydrate
  incident details after any restart.
- **Auto-Surface on Alert**: `GuardianProvider` automatically surfaces the
  notification banner when `alertTriggered` flips `true` or the risk score
  crosses the configurable threshold, with dismiss/expand APIs for operator
  control.

### Enriched Risk Assessment Payload

The `RiskAssessmentPayload` type now carries full forensic context:

| Field | Description |
|-------|-------------|
| `pasteSnippets` | Collapsible sections of pasted content with source metadata |
| `codeSnapshot` | Terminal workspace code state at detection time |
| `behavioralContext` | Grid of behavioral flags with type, severity, and timestamp |
| `keystrokeMetrics` | Inter-keystroke timing deltas, burst patterns, and anomaly scores |
| `incidentSummary` | Human-readable incident summary with time label |
| `dimensionScores` | 6-category risk breakdown: `dataExfiltration`, `unauthorizedAccess`, `policyViolation`, `amlRedFlag`, `insiderTrading`, `soxNonCompliance` (0–100 each) |

---

## 🗄️ MongoDB MCP Tools — 10 Tools via HTTP Adapter

The MCP HTTP adapter (`mcp-server/src/http-adapter.ts`) exposes **10 tools**
via `POST /tools/:toolName`. All database operations route through the
`MongoStore` class (`mongo-client.ts`) using the MongoDB Node.js native driver
with Atlas connection pooling.

### Tool 1: `store_compliance_matrix` / `get_compliance_matrix`
**Purpose:** Persist and retrieve generated compliance matrix documents.
**Store parameters:** `{ suite: GeneratedComplianceMatrix }`
**Get parameters:** `{ suiteId: string }`

### Tool 2: `create_session`
**Purpose:** Initialize an audited employee monitoring session in MongoDB.
Persist session metadata to Atlas and return the generated document ID.
**Parameters:** `{ sessionId, employeeId, complianceId, threatVectorId?, ...extraMeta }`
**Returns:** `{ success: true, mongoDocumentId: string }`

### Tool 3: `ingest_micro_events`
**Purpose:** Batch ingest behavioral micro-events (keystrokes, paste triggers,
tab switches, window blur, copy attempts, fullscreen exits, etc.) from the
compliance dashboard into the session timeline.
**Parameters:** `{ events: MicroEvent[] }`
**Returns:** `{ success: true, processedCount: number }`

### Tool 4: `store_suspicion_report`
**Purpose:** Persist a Gemini-generated threat analysis (suspicion report)
against a session after the Guardian completes its real-time analysis.
**Parameters:** `{ report: RiskAssessmentPayload }`
**Returns:** `{ success: true, mongoDocumentId: string }`

### Tool 5: `get_session_review`
**Purpose:** Fetch the complete analytical review data for a session including
all events, suspicion flags, and submitted code from MongoDB.
**Parameters:** `{ sessionId: string }`
**Returns:** `{ success, session, events, suspicionReports }`

### Tool 6: `get_employee_report`
**Purpose:** Aggregate all suspicion reports for a specific employee
across all sessions.
**Parameters:** `{ employeeId: string }`
**Returns:** `{ success: true, reports }`

### Tool 7: `list_sessions`
**Purpose:** List all sessions with summary fields. Used by the Flutter drawer.
**Parameters:** none
**Returns:** `{ success: true, data: SessionSummary[] }`

### Tool 8: `close_session`
**Purpose:** Gracefully close an active monitoring session, persisting the
status change (`"closed"`) to MongoDB Atlas while preserving all session
data for historical audit review.
**Parameters:** `{ sessionId: string }`
**Returns:** `{ success: true, sessionId: string, status: "closed" }`

### Tool 9: `delete_session`
**Purpose:** Permanently delete a session document and all associated
micro-events from MongoDB Atlas. **This action is irreversible.**
**Parameters:** `{ sessionId: string }`
**Returns:** `{ success: true, sessionId: string, deletedEvents: number }`

### Tool 10: `health_check`
**Purpose:** MongoDB connectivity health check with Atlas ping.
**Returns:** `{ connected: boolean, healthy: boolean, timestamp: string }`

### Auto-Indexing

The `MongoStore` class runs `ensureIndexes()` automatically on startup,
creating core indexes for `sessions`, `micro_events`, `suspicion_reports`,
and `compliance_matrices` collections if they don't already exist.

---

## 🧠 Agent Design Philosophy

### CISO Orchestrator Agent (Compliance Matrix Generation)

The Orchestrator transforms unstructured natural-language audit requirements into
fully-structured, production-grade compliance matrices. It enforces:

- **Target system definition**: Maps abstract financial systems to concrete risk profiles
- **Regulatory mandate mapping**: Weighted sub-scores per compliance area (AML, SOX, GDPR, FINRA)
- **Threat vector construction**: Each vector includes exploit scenarios, detection
  rules, and expected remediation steps
- **Penetration scenario modeling**: Anti-exfiltration measures baked into the
  evaluation (token injection patterns, transfer interception, privilege escalation)

### Insider Threat Guardian Agent (Security)

The Guardian operates as a streaming telemetry event processor:

1. **Paste Trigger Detection**: Intercepts paste events (Ctrl+V) and analyzes pasted
   content for AI-generated code or external data injection patterns using Gemini's
   semantic similarity engine against known reference completions.
2. **Keystroke Anomaly Analysis**: Measures inter-keystroke timing deltas to detect
   non-human typing patterns (instant paste with minimal deltas, burst pastes, or
   copy-paste with obfuscated paste masking).
3. **Tab Switch & Window Blur Monitoring**: Detects external resource lookups and
   browser/IDE tab switches that may indicate unauthorized consultation of external
   tools, AI assistants, or data sources during monitored sessions.
4. **Code Similarity Scoring**: Uses Gemini embeddings to compare employee submitted
   code against Gemini-generated reference completions, computing semantic similarity
   scores to flag AI-generated or externally sourced content.
5. **Composite Risk Scoring**: Combines paste frequency, keystroke timing patterns,
   tab/window switches, and code similarity metrics into a weighted 0-100 risk index
   that triggers alerts when exceeding the configurable threshold.

---

## 🔒 Session Lock — Workspace Freeze on Risk Alert

When the Guardian detects a high-severity insider threat (anomaly risk index ≥ 75
or a `CRITICAL` flag), the frontend code workspace automatically locks:

- **Workspace Freeze**: The Flutter code editor transitions to read-only mode,
  preventing further keystrokes and paste operations from entering the audited
  session. A lock overlay with a shield icon and "WORKSPACE LOCKED — High-Severity
  Threat Detected" message covers the editor pane.
- **Backend Session Freeze**: The Hono API Guardian route sets the session status
  to `"frozen"` in the in-memory registry and persists the freeze state to MongoDB
  Atlas via the MCP `store_suspicion_report` tool. All subsequent ingest requests
  for the frozen session receive a `403 Forbidden` with `sessionFrozen: true` and
  a reference to the triggering `riskAssessmentId`.
- **Unlock Authorization**: Only a manual review with an explicit unlock command
  (`POST /api/v1/guardian/sessions/:id/unlock`) restores the session to active
  state. The unlock endpoint requires a `reviewerId` and `unlockReason` in the
  request body, which are logged to the session's compliance audit trail in
  MongoDB Atlas.
- **Frontend Feedback**: The `GuardianProvider` and `code_workspace_panel.dart`
  surfaces the lock status through `isFrozen` and `frozenReason` fields. The
  security metrics panel displays a persistent frozen-state banner with the
  triggering risk assessment ID and timestamp.

## 🤖 AI Studio API Key Support

In addition to Application Default Credentials (ADC) via Vertex AI, Cerberus
FinSec supports **Google AI Studio API keys** for Gemini inference. This
provides an alternative authentication path for rapid prototyping and
environments where ADC is not configured:

- **Configuration**: Set `GEMINI_API_KEY` in `sandbox/hono-api/.env` to bypass
  Vertex AI and use the AI Studio endpoint directly. The Gemini client
  (`gemini-client.ts`) auto-detects which auth method to use based on
  environment variables at startup.
- **Fallback Priority**: When both `GEMINI_API_KEY` and ADC are available, the
  API key takes precedence for local development simplicity. Cloud Run
  deployments default to ADC (auto-injected by the GCP metadata server) unless
  `GEMINI_API_KEY` is explicitly set as an environment variable.
- **Model Compatibility**: All `gemini-3-flash-preview` capabilities (structured
  JSON output, compliance matrix generation, threat vector construction) are
  identical across both authentication paths. The only difference is the API
  endpoint routing.

## 📋 Hackathon Compliance Checklist

| Rule | Status | Evidence |
|------|--------|----------|
| **Originality Mandate** | ✅ PASS | All code in `sandbox/` is 100% new; no legacy Express/Flutter code reused |
| **Legacy Code Ban** | ✅ PASS | Zero imports from `../../backend/src` or `../../frontend` |
| **Repository Isolation Rule** | ✅ PASS | All work within `Google-Cloud-Hackathon/sandbox/` — fresh directory |
| **Orchestration Platform** | ✅ PASS | Google Cloud Agent Builder runtime with Gemini 3 Flash model inference |
| **Connectivity Rule (MCP)** | ✅ PASS | MongoDB Atlas MCP server with 10 registered tools via HTTP adapter |
| **No Competing AI Platforms** | ✅ PASS | Zero OpenAI, Anthropic, or AWS Bedrock dependencies |
| **Google Native Routing** | ✅ PASS | All model calls use `@google/genai` SDK with `vertexai: true` (ADC) |
| **Open Source License** | ✅ PASS | Apache 2.0 LICENSE file at repo root |
| **Production-grade** | ✅ PASS | Dockerfile, health checks, non-root user, Cloud Run ready |
| **MongoDB Indexes** | ✅ PASS | Automatic `ensureIndexes()` on MCP startup + documented manual indexes |
| **Financial Services Track** | ✅ PASS | Insider threat detection, data exfiltration guardian, compliance matrix generation |
| **Telemetry & Observability** | ✅ PASS | Enterprise-hardened logging at every pipeline milestone, `test-telemetry.ps1` smoke tests |

---

## ⚡ Telemetry & Testing

Three PowerShell test suites validate the full pipeline end-to-end:

### `run-all-tests.ps1` — Full Test Suite Orchestrator
Runs all 3 suites in sequence. Takes approximately 5–6 minutes. Target: `http://localhost:8080`.

### `test-all-10.ps1` — 13 Endpoint Smoke Test
Exercises all 13 API endpoints including health check, identity registration,
compliance matrix generation (via Gemini), guardian deploy, ingest (multiple
event types), session review, session listing, terminate, and delete. Takes ~46s.

### `test-telemetry.ps1` — 18 Event Types + Lifecycle
Deep observability smoke tests — validates all 12 event types (`KEYSTROKE`,
`PASTE_TRIGGER`, `CODE_DELTA`, `TAB_SWITCH`, `WINDOW_BLUR`, `COPY_ATTEMPT`,
`DEVELOPER_TOOLS_OPEN`, `FULLSCREEN_EXIT`, `EXTERNAL_APP_SWITCH`, `SUBMIT`,
`EDIT`, `PASTE`) plus full lifecycle (health → identity → generate → deploy →
ingest events → review). Takes ~32s.

### `test-stress.ps1` — 50 Concurrent Request Burst
Fires 25 Gemini generate requests (5 waves of 5, respecting server concurrency
semaphore) and 25 ingest requests (5 waves of 5, MongoDB-paced at ~5/sec).
Validates zero failures under concurrent load. Takes ~251s.

```powershell
# Run all 3 test suites
pwsh -File sandbox/run-all-tests.ps1

# Individual tests
pwsh -File sandbox/test-all-10.ps1       # 13 endpoint smoke
pwsh -File sandbox/test-telemetry.ps1    # 18 event types + lifecycle
pwsh -File sandbox/test-stress.ps1       # 50 concurrent burst (5 waves of 5)
```

---

**Live App**: [https://webscraping-464710.web.app/](https://webscraping-464710.web.app/)

---

Built with ❤️ for the Google Cloud Rapid Agent Hackathon 2026 — Financial Services Track.

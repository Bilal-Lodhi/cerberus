# 🔒 Cerberus FinSec — Compliance Dashboard

Flutter-based analytical compliance dashboard for the Cerberus FinSec insider threat
& data exfiltration guardian platform. Part of the **Google Cloud Financial Services
Track** — Rapid Agent Hackathon 2026.

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

## Table of Contents

- [🏆 Full Test Suite — All 3 Suites Passed](#-full-test-suite--all-3-suites-passed-june-9-2026)
- [Purpose](#-purpose)
- [Architecture](#-architecture)
- [Getting Started](#-getting-started)
  - [Prerequisites](#prerequisites)
  - [Run the Dashboard](#run-the-dashboard)
- [Key Features](#-key-features)
  - [Compliance Matrix Generation](#compliance-matrix-generation)
  - [Live Insider Threat Monitoring](#live-insider-threat-monitoring)
  - [Real-Time Risk Notification UI](#real-time-risk-notification-ui)
- [Session Drawer Categorization & Refresh](#session-drawer-categorization--refresh)
- [Close, Kill & Delete Session Controls](#close-kill--terminate-delete-session-controls)
- [Event Deduplication Pipeline](#-event-deduplication-pipeline)
- [Code Workspace Telemetry — Copy, Paste & Tab Detection](#-code-workspace-telemetry--copy-paste--tab-detection)
- [Generate Panel UX Enhancements](#-generate-panel-ux-enhancements)
- [Identity Setup](#identity-setup)
- [Input Validation & Resilience](#-input-validation--resilience)
- [Session Persistence & Post-Restart Recovery](#-session-persistence--post-restart-recovery)
- [Session Lock — Workspace Freeze on Risk Alert](#-session-lock--workspace-freeze-on-risk-alert)
- [AI Studio API Key Support](#-ai-studio-api-key-support)
- [State Management](#-state-management)
- [API Integration](#-api-integration)

---

## 🎯 Purpose

The Flutter frontend serves as the **compliance operator's control panel** for
monitoring live employee sessions, generating compliance matrices, reviewing risk
assessment reports, and visualizing behavioral anomaly timelines in real-time.

## 🏗 Architecture

```
lib/
├── main.dart                    # App entry point, Provider setup
├── app.dart                     # MaterialApp + routing configuration
├── models/                      # Data classes (fromJson/toJson)
│   ├── health_model.dart
│   ├── generate_model.dart      # ComplianceMatrix, MatrixMetadata, ThreatVector
│   ├── guardian_model.dart      # MicroEvent, RiskAssessmentPayload, RiskFlag
│   └── identity_model.dart      # IdentityPayload, IdentityResponse
├── providers/                   # ChangeNotifier state management
│   ├── health_provider.dart
│   ├── generate_provider.dart   # Matrix generation + cancel/resume
│   ├── guardian_provider.dart   # Micro-event ingestion + risk streaming
│   ├── review_provider.dart     # Session review aggregation
│   ├── theme_provider.dart
│   └── identity_provider.dart   # Employee identity + department
├── screens/
│   ├── dashboard_screen.dart    # Main compliance monitoring hub
│   └── identity_setup_screen.dart # Employee registration form
├── services/
│   └── api_service.dart         # HTTP client (Hono API + MCP adapter)
├── theme/
│   └── app_theme.dart           # Cerberus FinSec branding & dark theme
└── widgets/
    ├── generate_panel.dart       # ComplianceMatrix bottom sheet + deploy dialog
    ├── code_workspace_panel.dart # Live terminal workspace monitor
    ├── security_metrics_panel.dart # Risk gauge + behavioral flag timeline
    └── risk_notification.dart     # Expandable risk banner + dialog (tabbed detail, paste snippets, behavioral context, keystroke metrics, animated gauge)
```

## 🚀 Getting Started

### Prerequisites

- **Flutter SDK** ≥ 3.24
- **Running Hono API** on `http://localhost:8080` (or configured backend URL)
- **Running MCP Server** on `http://localhost:3001`

### Run the Dashboard

```bash
cd sandbox/frontend
flutter pub get
flutter run -d chrome --dart-define=API_BASE_URL=http://localhost:8080
```

> **🔐 For Judges: Two Authentication Options — AI Studio Key Recommended**
>
> The backend API supports **two** Gemini authentication methods. **Option A (AI Studio API key)
> is strongly recommended** for judging because `gemini-3-flash-preview` is not yet available on
> Vertex AI in all regions, and using `GCP_LOCATION=global` on Vertex AI can fail with 404 errors
> during the preview phase.
>
> **Option A — AI Studio API Key (RECOMMENDED ✅):**
> 1. Get a free API key at [https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)
> 2. Set `GEMINI_API_KEY=your-key-here` in `sandbox/hono-api/.env`
> 3. That's it — no `gcloud` CLI, no ADC, no GCP project needed
> 4. Start the backend and the dashboard will work immediately
>
> **Option B — Vertex AI via ADC (falls back if no API key is set):**
> 1. Run `gcloud auth application-default login` once on your machine
> 2. Set `GCP_PROJECT_ID` and `GCP_LOCATION=global` in `sandbox/hono-api/.env`
> 3. ⚠️ `gemini-3-flash-preview` may not be available; the app auto-falls back to `gemini-2.5-flash`
>
> **Priority:** If `GEMINI_API_KEY` is set, it takes precedence over Vertex AI/ADC.
> The frontend requires no code changes — all auth is handled server-side by the Hono API.

The dashboard connects to the Hono API backend. Configure the API base URL in
`lib/services/api_service.dart` if not running on `localhost:8080`.

## 🔧 Key Features

### Compliance Matrix Generation
The `generate_panel.dart` widget provides a bottom sheet (`ComplianceSheet`) for:
- Configuring compliance domain, target system, and threat vector count
- Real-time generation progress with cancel/resume support
- Post-generation deploy dialog to activate an `ActiveSession`

### Live Insider Threat Monitoring
The `security_metrics_panel.dart` widget displays:
- Color-coded risk severity gauge (low → critical)
- Real-time behavioral anomaly timeline
- Expandable risk flag cards with confidence scores

### Identity Setup
The `identity_setup_screen.dart` allows operators to register employee personas with:
- Display name, employee ID, and role
- Automatic session token attachment via `X-Session-Token` header

## 🛡️ Input Validation & Resilience

### Prompt Validation in GeneratePanel

The compliance matrix generation bottom sheet (`generate_panel.dart`) performs
client-side input validation before dispatching API requests:

- **Empty Prompt Guard**: If the audit prompt field is empty when the operator
  taps "Generate," an inline error message ("Audit prompt is required") is
  displayed directly below the text field with dedicated `errorBorder` and
  `focusedErrorBorder` styling using the Material 3 theme's `error` color.
- **Required Field Indicator**: The "Audit Prompt" label displays a red
  asterisk (`*`) suffix, clearly marking it as a mandatory field for
  operators.
- **Auto-Clearing Error**: The error text clears automatically as soon as the
  operator begins typing in the prompt field, providing a non-blocking UX
  that does not require a separate dismiss action.
- **Unchanged API-Level Guards**: The backend (`POST /api/v1/generate`)
  independently validates the `prompt` field and returns a structured 400
  error with `correlationId` if validation fails, ensuring defense-in-depth
  against both empty strings and non-object bodies.

### Target System Validation

A separate `_showErrorDialog` intercepts submissions where the target system
dropdown has not been selected, preventing the API from receiving `""` as
a system context value. This dialog must be explicitly dismissed before the
operator can retry.

---

## 🔄 Session Persistence & Post-Restart Recovery

The compliance dashboard maintains session state across server restarts and
Cloud Run cold starts through a client-side fallback chain in `ApiService`:

### Dual-Endpoint Fetch Strategy

`ApiService.fetchSessions()` uses a primary + fallback pattern for populating
the session drawer:

1. **Primary — `GET /api/v1/sessions`** (MongoDB-backed review endpoint):
   Queries the durable review endpoint with a 15-second timeout. This endpoint
   reads directly from MongoDB Atlas via the MCP sidecar, so data survives
   server restarts, Cloud Run scale-to-zero wake events, and container evictions.

2. **Fallback — `GET /api/v1/guardian/sessions`** (in-memory registry):
   If the review endpoint returns empty data or times out (e.g., MCP sidecar
   unreachable, MongoDB connectivity issues), the client automatically calls
   the Guardian's hybrid session endpoint. This endpoint first checks the
   in-memory `activeSessions` Map, and if empty, falls through to the MCP
   `list_sessions` MongoDB query — ensuring sessions are visible even when
   only the Hono API is reachable.

### Drawer UX Enhancement

The session drawer (`dashboard_screen.dart`) now displays:

- **Primary label**: `employeeId` (bold, `FontWeight.w600`) — the employee UID
  is shown as the main list item title, making it immediately clear which
  employee each session belongs to
- **Subtitle**: Session ID + event count + status (e.g., "active", "flagged")
  on two lines with `maxLines: 2` and `TextOverflow.ellipsis`

This replaces the previous behavior where `sessionId` was the primary label
and only the event count was shown as a single-line subtitle.

### Resilience Guarantees

- The dashboard drawer populates correctly after a server restart — sessions
  deploy one minute ago are still visible
- If MongoDB is unreachable but in-memory sessions exist, the fallback
  endpoint ensures the drawer is not empty
- `try/catch` on the primary fetch prevents network errors from crashing the
  drawer — the method silently falls through to the backup endpoint
- 15-second timeout prevents the UI from hanging on slow MongoDB queries

---

## 🔔 Real-Time Risk Notification UI

The compliance dashboard features a full risk notification system that surfaces
insider threat incidents in real-time, implemented in `risk_notification.dart`:

- **Integrated Risk Notification Banner**: A dismissible banner is embedded
  directly within `SecurityMetricsPanel`, appearing when `alertTriggered` is
  `true` or the `anomalyRiskIndex` reaches ≥ 45. Tap the permanent **DETAILS**
  `ElevatedButton.icon` to expand into the full incident dialog.
- **Expandable Incident Dialog**: Tabbed detail view with **Flags** and
  **Incident** tabs, collapsible paste snippet sections, code snapshot viewer,
  behavioral context grid, keystroke metrics display, and dimension score bars
  with color-coded severity levels.
- **Copy Report**: One-tap copy of the full risk assessment report to clipboard
  for compliance audit trails.
- **Animated Risk Gauge**: A custom animated gauge widget renders the composite
  risk score (0–100) with smooth interpolation and color transitions from green
  (safe) → yellow (elevated) → red (critical).
- **Full Incident Persistence**: Incidents survive browser refresh, process
  restart, and Cloud Run cold starts through MCP `store_suspicion_report` to
  MongoDB Atlas and post-restart rehydration via `GET /api/v1/sessions/:id`.
- **Auto-Surface on Alert**: `GuardianProvider` automatically surfaces the
  notification banner when `alertTriggered` flips `true` or the risk score
  crosses the configurable threshold.

---

## 📂 Session Drawer Categorization & Refresh

The session drawer (`dashboard_screen.dart`) organizes sessions into
collapsible category groups for efficient navigation in high-volume
compliance environments:

### Session Categories

Sessions are automatically sorted by lifecycle state:

| Category | Statuses | Indicator |
|----------|----------|-----------|
| **Active Sessions** | `active`, `in_progress` | Green dot |
| **Flagged Sessions** | `flagged` | Amber warning |
| **Under Investigation** | `investigating` | Blue info |
| **Closed Sessions** | `closed`, `cleared` | Grey neutral |

Each category group displays a count badge and can be independently expanded
or collapsed by the operator, reducing visual clutter.

### Drawer Refresh Button

A dedicated **refresh** `IconButton` in the drawer header triggers a full
re-fetch of session data through the dual-endpoint fallback chain:

1. Primary: `GET /api/v1/sessions` (MongoDB-backed, 15s timeout)
2. Fallback: `GET /api/v1/guardian/sessions` (in-memory registry)

An `isLoading` spinner in `ReviewProvider` provides visual feedback during
the refresh, and the drawer UI rebuilds reactively when new data arrives.

---

## 🛑 Close, Kill & Terminate (Delete) Session Controls

The dashboard provides two distinct session lifecycle controls accessible
from the session drawer and the code workspace toolbar:

### Close Session

Gracefully terminates an active monitoring session via
`POST /api/v1/guardian/sessions/:id/close`:
- Sets session status to `"closed"` in-memory and persists to MongoDB Atlas
- Preserves all historical data (events, suspicion reports, risk payloads)
- Session moves to the **Closed Sessions** category in the drawer

### Delete (Terminate) Session

Permanently deletes a session via `DELETE /api/v1/sessions/:id`:
- Removes the session from the in-memory registry
- Sends a RESTful `DELETE` HTTP request with proper CORS preflight handling
  (`Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`)
- **Irreversibly deletes** the session document and all associated micro-events
  from MongoDB Atlas
- A confirmation dialog with a warning appears before dispatch

### UI Integration

- **Close button** (grey, `close` icon) — visible on each session tile for
  sessions in `active` or `in_progress` status
- **Delete button** (red, `delete_forever` icon) — shown on long-press or
  when expanding the tile's action menu
- **Code workspace overflow menu** (`code_workspace_panel.dart`) also exposes
  close and delete (kill) actions for the currently monitored session

---

## 🔁 Event Deduplication Pipeline

The dashboard processes telemetry events at high frequency from the code
workspace and polling loops. To avoid redundant Gemini inference calls,
repeated risk notifications, and duplicate event storage, a four-tier
deduplication pipeline is active:

### Tier 3 — Frontend Risk Payload Dedup

`GuardianProvider._addEventIfNew()` suppresses duplicate
`RiskAssessmentPayload` entries in the live events timeline. Deduplication
is by UUID (`riskAssessmentId`) primarily, with a fallback comparison of
`generatedAt`, `overallRiskScore`, and flag identities. This prevents the
Flutter polling loop from re-emitting identical payloads that the backend
has already acknowledged.

### Tier 4 — Polling Fallback Cache

`ApiService._lastPolledRiskPayload` caches the most recent payload yielded
through the polling fallback stream. New payloads are only emitted when
`riskAssessmentId` differs or structural signal fields (score, flags,
dimension scores) change. `resetPollingCache()` clears this cache when
switching sessions, ensuring the new session always receives fresh data
without stale carryover from the previous session.

> **Tiers 1 & 2** operate on the Hono API backend — see the
> [sandbox README](../README.md#-event-deduplication-pipeline) for
> code-hash dedup and micro-event fingerprint dedup details.

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

## 🔒 Session Lock — Workspace Freeze on Risk Alert

When the Guardian detects a high-severity insider threat (anomaly risk index ≥ 75
or a `CRITICAL` flag), the frontend code workspace automatically locks:

- **Workspace Freeze**: The Flutter code editor (`code_workspace_panel.dart`)
  transitions to read-only mode, preventing further keystrokes and paste
  operations. A lock overlay with a shield icon and "WORKSPACE LOCKED —
  High-Severity Threat Detected" message covers the editor pane.
- **Backend Session Freeze**: The Guardian route sets the session status to
  `"frozen"` in the in-memory registry and persists the freeze state to MongoDB
  Atlas. All subsequent ingest requests for the frozen session receive a
  `403 Forbidden` with `sessionFrozen: true`.
- **Unlock Authorization**: Only a manual review with an explicit unlock
  command (`POST /api/v1/guardian/sessions/:id/unlock`) restores the session to
  active state. The unlock requires a `reviewerId` and `unlockReason`, which are
  logged to the compliance audit trail in MongoDB Atlas.
- **Frontend Feedback**: `GuardianProvider` and `code_workspace_panel.dart`
  surface the lock status through `isFrozen` and `frozenReason` fields. The
  security metrics panel displays a persistent frozen-state banner with the
  triggering risk assessment ID and timestamp.

## 🤖 AI Studio API Key Support

The Flutter dashboard supports both Vertex AI (ADC) and Google AI Studio API key
authentication paths for Gemini inference:

- **Configuration**: Set `GEMINI_API_KEY` in `sandbox/hono-api/.env` to use the
  AI Studio endpoint. The frontend requires no code changes — the API key is
  handled server-side by the Hono API layer. All `ApiService` calls remain
  unchanged.
- **Fallback Priority**: When both `GEMINI_API_KEY` and ADC are available on the
  backend, the API key takes precedence for local development. Cloud Run
  deployments default to ADC unless `GEMINI_API_KEY` is explicitly set.
- **Model Compatibility**: All Gemini capabilities (structured JSON output,
  compliance matrix generation, threat vector construction) are identical across
  both authentication paths from the frontend's perspective.

---

## 📦 State Management

Uses **Provider** (`ChangeNotifier`) for reactive state management:
- `GenerateProvider` — matrix generation lifecycle (loading, result, error, cancelled)
- `GuardianProvider` — real-time micro-event stream processing
- `ReviewProvider` — aggregated session review data
- `IdentityProvider` — employee identity registration and persistence
- `ThemeProvider` — dark/light mode toggle
- `HealthProvider` — backend connectivity status

## 🔗 API Integration

All HTTP calls route through `ApiService` (`lib/services/api_service.dart`):
- `POST /api/v1/generate` — Compliance matrix generation
- `POST /api/v1/generate/cancel` — Cancel in-flight generation
- `POST /api/v1/guardian/ingest` — Micro-event telemetry ingestion (batched events)
- `POST /api/v1/guardian/deploy` — Deploy active monitoring session
- `GET /api/v1/guardian/sessions/:id` — Live session risk state
- `POST /api/v1/guardian/sessions/:id/close` — Gracefully close an active session
- `DELETE /api/v1/sessions/:id` — Irreversibly delete a session (with CORS preflight support)
- `GET /api/v1/sessions` — List all sessions
- `GET /api/v1/sessions/:id` — Fetch session audit review
- `POST /api/v1/identity/set` — Register employee identity
- `GET /api/v1/identity/me` — Get current identity

Each request includes `X-Generation-Request-Id` (UUID v4) for correlation
and `X-Session-Token` for identity context.

Ingest payloads use batched `MicroEvent[]` with valid `eventType` values:
`KEYSTROKE`, `PASTE_TRIGGER`, `CODE_DELTA`, `TAB_SWITCH`, `WINDOW_BLUR`,
`COPY_ATTEMPT`, `DEVELOPER_TOOLS_OPEN`, `FULLSCREEN_EXIT`, `EXTERNAL_APP_SWITCH`,
`SUBMIT`, `EDIT`, `PASTE`.

---

Built with Flutter + Dart for the Cerberus FinSec platform.

**Live App**: [https://webscraping-464710.web.app/](https://webscraping-464710.web.app/)

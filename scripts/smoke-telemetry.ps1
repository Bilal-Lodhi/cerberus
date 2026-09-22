# ═══════════════════════════════════════════════════════════════════
# Cerberus — telemetry smoke test (12 event types + lifecycle)
# ═══════════════════════════════════════════════════════════════════
# Registers an operator identity, authors a threat scenario matrix, deploys
# a monitored session, sends one ingest request per micro-event type, then
# reads the session review payload. Deploy and review are the lifecycle
# steps exercised here; terminate and delete are covered by smoke-api.ps1.
#
# This is a manual verification aid, NOT the automated test suite. The
# automated suite is `npm test` and requires no running server.
#
# USAGE
#   # with the API in development mode (CERBERUS_DEV_MODE=true):
#   pwsh -File scripts/smoke-telemetry.ps1
#
#   # with authentication enabled:
#   $env:CERBERUS_API_KEY = "<your key>"
#   pwsh -File scripts/smoke-telemetry.ps1 -BaseUrl http://localhost:8080
#
# PREREQUISITES
#   npm run build && npm start      (or: npm run dev)
#
# NOTE: step 4 calls the configured AI provider and may take 45-180 seconds.
# Ingest steps use a 120s client timeout because a paste above the configured
# threshold triggers a synchronous risk-analysis call, which takes 10-30s on a
# real model. The previous 30s ceiling aborted requests the server was still
# working on.
# ═══════════════════════════════════════════════════════════════════

param(
  [string]$BaseUrl = "http://localhost:8080",
  [string]$ApiKey  = $env:CERBERUS_API_KEY,
  [string]$SessionId = "telemetry-smoke-session",
  [string]$EmployeeId = "op-trader-001"
)

$ErrorActionPreference = "Continue"
$Total  = 18
$Passed = 0
$Failed = 0

# ── Auth headers ────────────────────────────────────────────────────
# Every request below carries the operator credential except GET /health,
# which is public (see apps/api/src/middleware/auth.ts).
$Auth = @{}
if ($ApiKey -and $ApiKey.Trim().Length -gt 0) {
  $Auth["Authorization"] = "Bearer $($ApiKey.Trim())"
} else {
  Write-Host "[info] no CERBERUS_API_KEY set - assuming development mode" -ForegroundColor DarkYellow
}

function Merge-Headers {
  param([hashtable]$Extra = @{})
  $headers = @{}
  foreach ($k in $Auth.Keys) { $headers[$k] = $Auth[$k] }
  foreach ($k in $Extra.Keys) { $headers[$k] = $Extra[$k] }
  return $headers
}

Write-Host ""
Write-Host "CERBERUS TELEMETRY SMOKE TEST - 12 EVENT TYPES + LIFECYCLE" -ForegroundColor Cyan
Write-Host "  Target: $BaseUrl"
Write-Host ""

# ─── 1. Health Check (public) ───────────────────────────────────────
Write-Host "[1/$Total] Health check..." -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod -Uri "$BaseUrl/health" -Method GET -TimeoutSec 5
  Write-Host "  PASS - status: $($r.status)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  FAIL - backend not running at $BaseUrl" -ForegroundColor Red
  Write-Host "     Start with: npm run dev   (or: npm run build && npm start)" -ForegroundColor Yellow
  $Failed++
}

# ─── 2. Register Identity ──────────────────────────────────────────
Write-Host ""
Write-Host "[2/$Total] Register identity..." -ForegroundColor Cyan
try {
  $body = @{ displayName="Alice Chen"; employeeId=$EmployeeId; role="Senior Quant Trader" } | ConvertTo-Json
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/identity/set" -Method POST -ContentType "application/json" -Body $body -Headers (Merge-Headers) -TimeoutSec 10
  $token = $r.sessionToken
  Write-Host "  PASS - sessionToken: $token" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  FAIL - $_" -ForegroundColor Red
  $Failed++
}

# ─── 3. Get Identity ───────────────────────────────────────────────
Write-Host ""
Write-Host "[3/$Total] Get current identity..." -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/identity/me" -Method GET -Headers (Merge-Headers @{'X-Session-Token'=$token}) -TimeoutSec 10
  Write-Host "  PASS - $($r.identity.displayName) / $($r.identity.role)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  FAIL - $_" -ForegroundColor Red
  $Failed++
}

# ─── 4. Author Threat Scenario Matrix ──────────────────────────────
Write-Host ""
Write-Host "[4/$Total] Author threat scenario matrix (AI provider - 45-120s)..." -ForegroundColor Cyan
Write-Host "  Calling the configured AI provider..." -ForegroundColor DarkYellow
try {
  $body = @{
    prompt = "Author threat scenarios for cross-border SWIFT transfer monitoring covering AML and KYC mandates"
    roleContext = "swift-gateway"
    vectorCount = 5
    severityMix = @{ low=0.25; medium=0.35; high=0.25; critical=0.15 }
  } | ConvertTo-Json
  # 600s: the provider allows 3 attempts at a 180s timeout each, so a 5-vector
  # matrix can legitimately take several minutes. The old 180s ceiling aborted
  # requests the server was still working on.
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/scenarios" -Method POST -ContentType "application/json" -Body $body -Headers (Merge-Headers) -TimeoutSec 600
  $matrixId = $r.matrix.metadata.matrixId
  Write-Host "  PASS - matrixId: $matrixId (persisted: $($r.persisted))" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  FAIL - $_" -ForegroundColor Red
  $matrixId = "telemetry-matrix-fallback"
  $Failed++
}

# ─── 5. Deploy Session ─────────────────────────────────────────────
Write-Host ""
Write-Host "[5/$Total] Deploy session..." -ForegroundColor Cyan
try {
  $deployBody = @{
    employeeUid = $EmployeeId
    sessionId   = $SessionId
    matrixId    = $matrixId
    targetSystem = "Core Trading Ledger"
  } | ConvertTo-Json
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/deploy" -Method POST -ContentType "application/json" -Body $deployBody -Headers (Merge-Headers) -TimeoutSec 10
  Write-Host "  PASS - session=$($r.sessionId) mongoDoc=$($r.mongoDocumentId)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  FAIL - $_ (may already exist, continuing)" -ForegroundColor Yellow
  $Failed++
}

# ─── EVENT TYPE 1: KEYSTROKE ───────────────────────────────────────
Write-Host ""
Write-Host "[6/$Total] KEYSTROKE event..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-keystroke-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="KEYSTROKE"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ key="A"; deltaMs=45 }
    clientMetadata=@{ userAgent="Flutter/Dart"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -Headers (Merge-Headers) -TimeoutSec 120
  Write-Host "  PASS - processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  FAIL - $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 2: PASTE_TRIGGER ───────────────────────────────────
Write-Host ""
Write-Host "[7/$Total] PASTE_TRIGGER event (suspicious paste)..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-paste-trigger-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="PASTE_TRIGGER"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ pasteContent="function exfiltrateData() { return fetch('/api/export', {method:'POST',body:JSON.stringify(sensitiveData)}); }"; deltaMs=120 }
    clientMetadata=@{ userAgent="Mozilla/5.0"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -Headers (Merge-Headers) -TimeoutSec 120
  Write-Host "  PASS - processed: $($r.processedCount), alertTriggered: $($r.alertTriggered), riskIndex: $($r.anomalyRiskIndex)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  FAIL - $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 3: CODE_DELTA ──────────────────────────────────────
Write-Host ""
Write-Host "[8/$Total] CODE_DELTA event..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-codedelta-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="CODE_DELTA"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ diffPatch="+ function transferFunds(account) { ... }"; changedFile="main.dart" }
    clientMetadata=@{ userAgent="Flutter/Dart"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -Headers (Merge-Headers) -TimeoutSec 120
  Write-Host "  PASS - processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  FAIL - $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 4: TAB_SWITCH ──────────────────────────────────────
Write-Host ""
Write-Host "[9/$Total] TAB_SWITCH event..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-tabswitch-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="TAB_SWITCH"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ visibilityState="hidden" }
    clientMetadata=@{ userAgent="Mozilla/5.0"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -Headers (Merge-Headers) -TimeoutSec 120
  Write-Host "  PASS - processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  FAIL - $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 5: WINDOW_BLUR ─────────────────────────────────────
Write-Host ""
Write-Host "[10/$Total] WINDOW_BLUR event..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-blur-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="WINDOW_BLUR"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ focusDurationMs=3500 }
    clientMetadata=@{ userAgent="Flutter/Dart"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -Headers (Merge-Headers) -TimeoutSec 120
  Write-Host "  PASS - processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  FAIL - $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 6: COPY_ATTEMPT ────────────────────────────────────
Write-Host ""
Write-Host "[11/$Total] COPY_ATTEMPT event..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-copy-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="COPY_ATTEMPT"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ selectionLength=245; selectionPreview="transferToOffshore" }
    clientMetadata=@{ userAgent="Flutter/Dart"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -Headers (Merge-Headers) -TimeoutSec 120
  Write-Host "  PASS - processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  FAIL - $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 7: DEVELOPER_TOOLS_OPEN ────────────────────────────
Write-Host ""
Write-Host "[12/$Total] DEVELOPER_TOOLS_OPEN event..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-devtools-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="DEVELOPER_TOOLS_OPEN"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ panelName="Console" }
    clientMetadata=@{ userAgent="Chrome/130"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -Headers (Merge-Headers) -TimeoutSec 120
  Write-Host "  PASS - processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  FAIL - $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 8: FULLSCREEN_EXIT ─────────────────────────────────
Write-Host ""
Write-Host "[13/$Total] FULLSCREEN_EXIT event..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-fs-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="FULLSCREEN_EXIT"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ fullscreenDurationMs=12000 }
    clientMetadata=@{ userAgent="Flutter/Dart"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -Headers (Merge-Headers) -TimeoutSec 120
  Write-Host "  PASS - processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  FAIL - $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 9: EXTERNAL_APP_SWITCH ─────────────────────────────
Write-Host ""
Write-Host "[14/$Total] EXTERNAL_APP_SWITCH event..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-extapp-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="EXTERNAL_APP_SWITCH"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ targetApp="Telegram"; windowTitle="Trade Secrets Chat" }
    clientMetadata=@{ userAgent="Flutter/Dart"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -Headers (Merge-Headers) -TimeoutSec 120
  Write-Host "  PASS - processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  FAIL - $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 10: SUBMIT ─────────────────────────────────────────
Write-Host ""
Write-Host "[15/$Total] SUBMIT event..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-submit-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="SUBMIT"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ codeLength=512; language="dart" }
    clientMetadata=@{ userAgent="Flutter/Dart"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -Headers (Merge-Headers) -TimeoutSec 120
  Write-Host "  PASS - processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  FAIL - $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 11: EDIT ───────────────────────────────────────────
Write-Host ""
Write-Host "[16/$Total] EDIT event (normal typing)..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-edit-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="EDIT"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ newText="void main() {`n  print('hello');`n}"; changeLength=15 }
    clientMetadata=@{ userAgent="Flutter/Dart"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -Headers (Merge-Headers) -TimeoutSec 120
  Write-Host "  PASS - processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  FAIL - $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 12: PASTE ──────────────────────────────────────────
Write-Host ""
Write-Host "[17/$Total] PASTE event (large paste)..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-paste-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="PASTE"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ newText="void main() {`n  print('hello');`n  // Pasted: suspicious cross-border transfer`n  SwiftTransfer.execute(bic: 'OFFSHOREBNK', amount: 500000.00, currency: 'USD');`n}"; changeLength=150 }
    clientMetadata=@{ userAgent="Flutter/Dart"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -Headers (Merge-Headers) -TimeoutSec 120
  Write-Host "  PASS - processed: $($r.processedCount), alertTriggered: $($r.alertTriggered)" -ForegroundColor Green
  if ($r.riskPayload) {
    Write-Host "         riskScore: $($r.riskPayload.overallRiskScore), flags: $($r.riskPayload.flags.Count)" -ForegroundColor DarkGray
  }
  $Passed++
} catch {
  Write-Host "  FAIL - $_" -ForegroundColor Red
  $Failed++
}

# ─── Review API ────────────────────────────────────────────────────
Write-Host ""
Write-Host "[18/$Total] Review API - GET /api/v1/sessions/$SessionId..." -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/sessions/$SessionId" -Method GET -Headers (Merge-Headers) -TimeoutSec 10
  Write-Host "  PASS - status: $($r.data.status), timeline: $($r.data.timeline.Count)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  FAIL - $_" -ForegroundColor Red
  $Failed++
}

# ─── FINAL SUMMARY ─────────────────────────────────────────────────
Write-Host ""
Write-Host "CERBERUS TELEMETRY SMOKE TEST - SUMMARY" -ForegroundColor Cyan
Write-Host "  Passed  : $Passed / $Total"
if ($Failed -gt 0) {
  Write-Host "  Failed  : $Failed / $Total" -ForegroundColor Red
} else {
  Write-Host "  Failed  : $Failed / $Total" -ForegroundColor DarkGray
}
if ($Failed -eq 0) {
  Write-Host "  Verdict : all 12 event types and the deploy/review lifecycle succeeded"
} else {
  Write-Host "  Verdict : $Failed check(s) failed - see the output above" -ForegroundColor Red
}
Write-Host ""

if ($Failed -gt 0) { exit 1 } else { exit 0 }

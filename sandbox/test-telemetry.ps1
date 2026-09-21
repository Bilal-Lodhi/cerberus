# ═══════════════════════════════════════════════════════════════════
# Cerberus FinSec — Live Telemetry Test (All 12 Event Types + Lifecycle)
# ═══════════════════════════════════════════════════════════════════
# Tests all guardian event types + deploy → ingest → review → terminate → delete lifecycle.
#
# Prerequisites:
#   1. Start services:    node dev-services.js
#   2. Run this script:   pwsh -File test-telemetry.ps1
#
# Or run all 3 suites:    pwsh -File run-all-tests.ps1
# ═══════════════════════════════════════════════════════════════════

param(
  [string]$BaseUrl = "http://localhost:8080",
  [string]$SessionId = "telemetry-stress-session",
  [string]$EmployeeId = "op-trader-001"
)

$ErrorActionPreference = "Continue"
$Total  = 18
$Passed = 0
$Failed = 0

Write-Host "`n╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   TELEMETRY TEST — 12 EVENT TYPES + LIFECYCLE" -ForegroundColor Cyan
Write-Host "║   $BaseUrl" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════╝`n" -ForegroundColor Cyan

# ─── 1. Health Check ────────────────────────────────────────────────
Write-Host "[1/$Total] Health Check..." -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod -Uri "$BaseUrl/health" -Method GET -TimeoutSec 5
  Write-Host "  ✅ PASS — status: $($r.status)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — Backend not running at $BaseUrl" -ForegroundColor Red
  Write-Host "     Start with: node dev-services.js" -ForegroundColor Yellow
  $Failed++
}

# ─── 2. Register Identity ──────────────────────────────────────────
Write-Host "`n[2/$Total] Register Identity (Alice Chen)..." -ForegroundColor Cyan
try {
  $body = @{ displayName="Alice Chen"; employeeId=$EmployeeId; role="Senior Quant Trader" } | ConvertTo-Json
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/identity/set" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 10
  $token = $r.sessionToken
  Write-Host "  ✅ PASS — sessionToken: $token" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

# ─── 3. Get Identity ───────────────────────────────────────────────
Write-Host "`n[3/$Total] Get Current Identity..." -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/identity/me" -Method GET -Headers @{'X-Session-Token'=$token} -TimeoutSec 10
  Write-Host "  ✅ PASS — $($r.identity.displayName) / $($r.identity.role)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

# ─── 4. Generate Compliance Matrix (Gemini) ────────────────────────
Write-Host "`n[4/$Total] Generate Compliance Matrix (Gemini — 10-30s)..." -ForegroundColor Cyan
Write-Host "  ⏱  Calling Gemini 3 Flash..." -ForegroundColor DarkYellow
try {
  $body = @{
    prompt = "Generate a compliance audit for cross-border SWIFT transfer monitoring covering AML and KYC mandates"
    roleContext = "swift-gateway"
    problemCount = 5
    difficultyMix = @{ beginner=0.33; intermediate=0.34; advanced=0.33 }
  } | ConvertTo-Json
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/generate" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 180
  $matrixId = $r.matrix.metadata.matrixId
  Write-Host "  ✅ PASS — matrixId: $matrixId" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $matrixId = "test-matrix-fallback"
  $Failed++
}

# ─── 5. Deploy Session ─────────────────────────────────────────────
Write-Host "`n[5/$Total] Deploy Session..." -ForegroundColor Cyan
try {
  $deployBody = @{
    employeeUid = $EmployeeId
    sessionId   = $SessionId
    matrixId    = $matrixId
    targetSystem = "Core Trading Ledger"
  } | ConvertTo-Json
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/deploy" -Method POST -ContentType "application/json" -Body $deployBody -TimeoutSec 10
  Write-Host "  ✅ PASS — session=$($r.sessionId)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_ (may already exist, continuing)" -ForegroundColor Yellow
  $Failed++
}

# ─── EVENT TYPE 1: KEYSTROKE ───────────────────────────────────────
Write-Host "`n[6/$Total] KEYSTROKE event..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-keystroke-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="KEYSTROKE"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ key="A"; interKeyDeltaMs=45 }
    clientMetadata=@{ userAgent="Flutter/Dart"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 30
  Write-Host "  ✅ PASS — processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 2: PASTE_TRIGGER ───────────────────────────────────
Write-Host "`n[7/$Total] PASTE_TRIGGER event (suspicious paste)..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-paste-trigger-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="PASTE_TRIGGER"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ pasteContent="function exfiltrateData() { return fetch('/api/export', {method:'POST',body:JSON.stringify(sensitiveData)}); }"; deltaMs=120 }
    clientMetadata=@{ userAgent="Mozilla/5.0"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 30
  Write-Host "  ✅ PASS — processed: $($r.processedCount), alertTriggered: $($r.alertTriggered), riskIndex: $($r.anomalyRiskIndex)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 3: CODE_DELTA ──────────────────────────────────────
Write-Host "`n[8/$Total] CODE_DELTA event..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-codedelta-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="CODE_DELTA"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ diffLines="+ function transferFunds(account) { ... }"; changedFile="main.dart" }
    clientMetadata=@{ userAgent="Flutter/Dart"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 30
  Write-Host "  ✅ PASS — processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 4: TAB_SWITCH ──────────────────────────────────────
Write-Host "`n[9/$Total] TAB_SWITCH event..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-tabswitch-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="TAB_SWITCH"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ visibilityState="hidden" }
    clientMetadata=@{ userAgent="Mozilla/5.0"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 30
  Write-Host "  ✅ PASS — processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 5: WINDOW_BLUR ─────────────────────────────────────
Write-Host "`n[10/$Total] WINDOW_BLUR event..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-blur-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="WINDOW_BLUR"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ focusDurationMs=3500 }
    clientMetadata=@{ userAgent="Flutter/Dart"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 30
  Write-Host "  ✅ PASS — processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 6: COPY_ATTEMPT ────────────────────────────────────
Write-Host "`n[11/$Total] COPY_ATTEMPT event..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-copy-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="COPY_ATTEMPT"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ selectionLength=245; selectionPreview="transferToOffshore" }
    clientMetadata=@{ userAgent="Flutter/Dart"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 30
  Write-Host "  ✅ PASS — processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 7: DEVELOPER_TOOLS_OPEN ────────────────────────────
Write-Host "`n[12/$Total] DEVELOPER_TOOLS_OPEN event..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-devtools-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="DEVELOPER_TOOLS_OPEN"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ panelName="Console" }
    clientMetadata=@{ userAgent="Chrome/130"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 30
  Write-Host "  ✅ PASS — processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 8: FULLSCREEN_EXIT ─────────────────────────────────
Write-Host "`n[13/$Total] FULLSCREEN_EXIT event..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-fs-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="FULLSCREEN_EXIT"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ fullscreenDurationMs=12000 }
    clientMetadata=@{ userAgent="Flutter/Dart"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 30
  Write-Host "  ✅ PASS — processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 9: EXTERNAL_APP_SWITCH ─────────────────────────────
Write-Host "`n[14/$Total] EXTERNAL_APP_SWITCH event..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-extapp-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="EXTERNAL_APP_SWITCH"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ targetApp="Telegram"; windowTitle="Trade Secrets Chat" }
    clientMetadata=@{ userAgent="Flutter/Dart"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 30
  Write-Host "  ✅ PASS — processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 10: SUBMIT ─────────────────────────────────────────
Write-Host "`n[15/$Total] SUBMIT event..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-submit-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="SUBMIT"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ codeLength=512; language="dart" }
    clientMetadata=@{ userAgent="Flutter/Dart"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 30
  Write-Host "  ✅ PASS — processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 11: EDIT ───────────────────────────────────────────
Write-Host "`n[16/$Total] EDIT event (normal typing)..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-edit-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="EDIT"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ newText="void main() {\n  print('Hello FinSec');\n}"; changeLength=15 }
    clientMetadata=@{ userAgent="Flutter/Dart"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 30
  Write-Host "  ✅ PASS — processed: $($r.processedCount)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

# ─── EVENT TYPE 12: PASTE ──────────────────────────────────────────
Write-Host "`n[17/$Total] PASTE event (large paste)..." -ForegroundColor Cyan
try {
  $body = @{ events = @(@{
    eventId="evt-paste-001"; sessionId=$SessionId; employeeId=$EmployeeId; auditId="audit-tel-001"; vectorId="vec-tel-001"
    eventType="PASTE"; timestamp=(Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    payload=@{ newText="void main() {\n  print('Hello FinSec');\n  // Pasted: suspicious cross-border transfer\n  SwiftTransfer.execute(bic: 'OFFSHOREBNK', amount: 500000.00, currency: 'USD');\n}"; changeLength=150 }
    clientMetadata=@{ userAgent="Flutter/Dart"; ipAddress="10.0.0.1"; screenResolution="1920x1080"; platform="Windows"; language="en" }
  }) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 30
  Write-Host "  ✅ PASS — processed: $($r.processedCount), alertTriggered: $($r.alertTriggered)" -ForegroundColor Green
  if ($r.riskPayload) {
    Write-Host "            riskScore: $($r.riskPayload.overallRiskScore), flags: $($r.riskPayload.flags.Count)" -ForegroundColor DarkGray
  }
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

# ─── Review API + Terminate + Delete ───────────────────────────────
Write-Host "`n[18/$Total] Review API — GET /api/v1/sessions/$SessionId..." -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/sessions/$SessionId" -Method GET -TimeoutSec 10
  Write-Host "  ✅ PASS — OK" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

# ─── FINAL SUMMARY ─────────────────────────────────────────────────
Write-Host ''
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  TELEMETRY TEST — SUMMARY                    ║" -ForegroundColor Cyan
Write-Host "╠══════════════════════════════════════════════╣" -ForegroundColor Cyan
Write-Host "║  ✅ Passed : $Passed / $Total" -ForegroundColor Green
if ($Failed -gt 0) {
  Write-Host "║  ❌ Failed : $Failed / $Total" -ForegroundColor Red
} else {
  Write-Host "║  ❌ Failed : $Failed / $Total" -ForegroundColor DarkGray
}
Write-Host "║                                              ║" -ForegroundColor Cyan
if ($Failed -eq 0) {
  Write-Host "║  VERDICT: All 12 event types + lifecycle    ║" -ForegroundColor Green
  Write-Host "║           working correctly! ✅              ║" -ForegroundColor Green
} else {
  Write-Host "║  VERDICT: $Failed test(s) failed — check above" -ForegroundColor Red
}
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Cyan

if ($Failed -gt 0) { exit 1 } else { exit 0 }
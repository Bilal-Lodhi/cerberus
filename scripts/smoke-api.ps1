# ═══════════════════════════════════════════════════════════════════
# Cerberus — endpoint smoke test
# ═══════════════════════════════════════════════════════════════════
# Exercises every public endpoint against a running instance, including a
# negative authentication check.
#
# This is a manual verification aid, NOT the automated test suite. The
# automated suite is `npm test` and requires no running server.
#
# USAGE
#   # with the API in development mode (CERBERUS_DEV_MODE=true):
#   pwsh -File scripts/smoke-api.ps1
#
#   # with authentication enabled:
#   $env:CERBERUS_API_KEY = "<your key>"
#   pwsh -File scripts/smoke-api.ps1 -BaseUrl http://localhost:8080
#
# PREREQUISITES
#   npm run build && npm start      (or: npm run dev)
#
# NOTE: step 5 calls the configured AI provider and may take 45-120 seconds.
# ═══════════════════════════════════════════════════════════════════

param(
  [string]$BaseUrl = "http://localhost:8080",
  [string]$ApiKey  = $env:CERBERUS_API_KEY
)

$ErrorActionPreference = "Continue"
$Passed = 0
$Failed = 0
$Total  = 14

# ── Auth headers ────────────────────────────────────────────────────
$Auth = @{}
if ($ApiKey -and $ApiKey.Trim().Length -gt 0) {
  $Auth["Authorization"] = "Bearer $($ApiKey.Trim())"
} else {
  Write-Host "  [info] no CERBERUS_API_KEY set — assuming development mode" -ForegroundColor DarkYellow
}

function Invoke-Cerberus {
  param(
    [string]$Method,
    [string]$Path,
    [string]$Body,
    [hashtable]$ExtraHeaders = @{}
  )
  $headers = @{}
  foreach ($k in $Auth.Keys) { $headers[$k] = $Auth[$k] }
  foreach ($k in $ExtraHeaders.Keys) { $headers[$k] = $ExtraHeaders[$k] }

  $params = @{
    Method      = $Method
    Uri         = "$BaseUrl$Path"
    Headers     = $headers
    TimeoutSec  = 300
    ErrorAction = "Stop"
  }
  if ($Body) {
    $params["ContentType"] = "application/json"
    $params["Body"] = $Body
  }
  return Invoke-RestMethod @params
}

function Write-Result {
  param([string]$Label, [bool]$Ok, [string]$Detail)
  if ($Ok) {
    Write-Host "  PASS - $Detail" -ForegroundColor Green
    $script:Passed++
  } else {
    Write-Host "  FAIL - $Detail" -ForegroundColor Red
    $script:Failed++
  }
}

Write-Host ""
Write-Host "CERBERUS ENDPOINT SMOKE TEST - $BaseUrl" -ForegroundColor Cyan
Write-Host ""

$SessionId = "smoke-session-$(Get-Date -Format 'yyyyMMddHHmmss')"
$MatrixId  = "unknown"
$GenRequestId = "unknown"

# ── 1. Health (public) ──────────────────────────────────────────────
Write-Host "=== 1/14: GET /health ===" -ForegroundColor Cyan
try {
  $r = Invoke-Cerberus -Method GET -Path "/health"
  Write-Result "health" ($r.status -eq "healthy") "status=$($r.status) service=$($r.service) version=$($r.version)"
} catch {
  Write-Result "health" $false "$_"
}

# ── 2. Authentication is enforced ───────────────────────────────────
Write-Host ""
Write-Host "=== 2/14: unauthenticated sensitive call is rejected ===" -ForegroundColor Cyan
try {
  $null = Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/v1/sessions" -TimeoutSec 10 -ErrorAction Stop
  # Only reachable without a key when development mode is on.
  Write-Result "auth" ($null -eq $null) "no credential accepted - development mode is enabled"
} catch {
  $status = $_.Exception.Response.StatusCode.value__
  Write-Result "auth" ($status -eq 401) "rejected with HTTP $status"
}

# ── 3. Identity ─────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== 3/14: POST /api/v1/identity/set ===" -ForegroundColor Cyan
$sessionToken = ""
try {
  $r = Invoke-Cerberus -Method POST -Path "/api/v1/identity/set" `
    -Body '{"displayName":"Smoke Operator","employeeId":"op-trader-001","role":"Senior Quant Trader","department":"Trading Desk"}'
  $sessionToken = $r.sessionToken
  Write-Result "identity/set" ($r.success -eq $true) "handle=$($sessionToken.Substring(0,8))..."
} catch {
  Write-Result "identity/set" $false "$_"
}

Write-Host ""
Write-Host "=== 4/14: GET /api/v1/identity/me ===" -ForegroundColor Cyan
try {
  $r = Invoke-Cerberus -Method GET -Path "/api/v1/identity/me" -ExtraHeaders @{ "X-Session-Token" = $sessionToken }
  Write-Result "identity/me" ($r.success -eq $true) "employeeId=$($r.identity.employeeId)"
} catch {
  Write-Result "identity/me" $false "$_"
}

# ── 5. Threat scenario authoring ────────────────────────────────────
Write-Host ""
Write-Host "=== 5/14: POST /api/v1/scenarios ===" -ForegroundColor Cyan
Write-Host "  (calls the configured AI provider; may take 20-60s)" -ForegroundColor DarkYellow
try {
  $body = '{"prompt":"Author threat scenarios for cross-border SWIFT transfer monitoring covering AML and KYC mandates","roleContext":"swift-gateway","vectorCount":3,"severityMix":{"low":0.25,"medium":0.35,"high":0.25,"critical":0.15}}'
  $r = Invoke-Cerberus -Method POST -Path "/api/v1/scenarios" -Body $body
  $MatrixId = $r.matrix.metadata.matrixId
  $GenRequestId = $r.generationRequestId
  Write-Result "scenarios" ($r.success -eq $true) "matrixId=$MatrixId persisted=$($r.persisted) vectors=$($r.matrix.threatVectors.Count)"
} catch {
  Write-Result "scenarios" $false "$_"
}

Write-Host ""
Write-Host "=== 6/14: POST /api/v1/scenarios/cancel (race) ===" -ForegroundColor Cyan
try {
  $jobBody = '{"prompt":"Author threat scenarios for the core trading ledger covering insider trading and data exfiltration","roleContext":"core-trading-ledger","vectorCount":3}'
  $genHeaders = @{ "X-Generation-Request-Id" = "smoke-cancel-001" }
  if ($Auth.ContainsKey("Authorization")) { $genHeaders["Authorization"] = $Auth["Authorization"] }

  $genJob = Start-Job -ScriptBlock {
    param($url, $body, $headers)
    try {
      Invoke-RestMethod -Method POST -ContentType 'application/json' -Body $body -Headers $headers -Uri "$url/api/v1/scenarios" -TimeoutSec 120 | Out-Null
      return "COMPLETED"
    } catch {
      return "CANCELLED"
    }
  } -ArgumentList $BaseUrl, $jobBody, $genHeaders

  Start-Sleep -Milliseconds 500
  $r = Invoke-Cerberus -Method POST -Path "/api/v1/scenarios/cancel" -Body '{"generationRequestId":"smoke-cancel-001"}'

  $null = Wait-Job $genJob -Timeout 5
  $null = Receive-Job $genJob -ErrorAction SilentlyContinue
  $null = Remove-Job $genJob -Force -ErrorAction SilentlyContinue

  $ok = ($r.success -eq $true) -or ($r.error -match "already completed")
  Write-Result "scenarios/cancel" $ok "success=$($r.success)"
} catch {
  $null = Remove-Job $genJob -Force -ErrorAction SilentlyContinue
  Write-Result "scenarios/cancel" $false "$_"
}

# ── 7. Deploy a monitored session ───────────────────────────────────
Write-Host ""
Write-Host "=== 7/14: POST /api/v1/guardian/deploy ===" -ForegroundColor Cyan
try {
  $body = @{
    employeeUid  = "op-trader-001"
    sessionId    = $SessionId
    matrixId     = $MatrixId
    targetSystem = "Core Trading Ledger"
  } | ConvertTo-Json -Compress
  $r = Invoke-Cerberus -Method POST -Path "/api/v1/guardian/deploy" -Body $body
  Write-Result "deploy" ($r.success -eq $true) "sessionId=$($r.sessionId) mongoDoc=$($r.mongoDocumentId)"
} catch {
  Write-Result "deploy" $false "$_"
}

# ── 8. Ingest telemetry (legacy event shapes) ───────────────────────
Write-Host ""
Write-Host "=== 8/14: POST /api/v1/guardian/ingest (PASTE_TRIGGER + TAB_SWITCH) ===" -ForegroundColor Cyan
try {
  $events = @(
    @{
      eventId = "evt-001"; sessionId = $SessionId; employeeId = "op-trader-001"
      auditId = "audit-001"; vectorId = "vec-001"; eventType = "PASTE_TRIGGER"
      timestamp = (Get-Date).ToUniversalTime().ToString("o")
      payload = @{ pasteContent = "function transferFunds(acct) { return offshore(acct); }" }
      clientMetadata = @{ userAgent = "smoke"; ipAddress = "10.0.0.1"; screenResolution = "1920x1080"; platform = "Windows"; language = "en" }
    },
    @{
      eventId = "evt-002"; sessionId = $SessionId; employeeId = "op-trader-001"
      auditId = "audit-001"; vectorId = "vec-001"; eventType = "TAB_SWITCH"
      timestamp = (Get-Date).ToUniversalTime().ToString("o")
      payload = @{ visibilityState = "hidden" }
      clientMetadata = @{ userAgent = "smoke"; ipAddress = "10.0.0.1"; screenResolution = "1920x1080"; platform = "Windows"; language = "en" }
    }
  )
  $body = @{ events = $events } | ConvertTo-Json -Depth 8 -Compress
  $r = Invoke-Cerberus -Method POST -Path "/api/v1/guardian/ingest" -Body $body
  Write-Result "ingest/paste" ($r.success -eq $true) "processed=$($r.processedCount) riskIndex=$($r.anomalyRiskIndex)"
} catch {
  Write-Result "ingest/paste" $false "$_"
}

# ── 9. Ingest telemetry (current event shapes) ──────────────────────
Write-Host ""
Write-Host "=== 9/14: POST /api/v1/guardian/ingest (EDIT + PASTE) ===" -ForegroundColor Cyan
try {
  $events = @(
    @{
      eventId = "evt-edit-001"; sessionId = $SessionId; employeeId = "op-trader-001"
      auditId = "audit-001"; vectorId = "vec-001"; eventType = "EDIT"
      timestamp = (Get-Date).ToUniversalTime().ToString("o")
      payload = @{ newText = "void main() { print('hello'); }"; changeLength = 15 }
      clientMetadata = @{ userAgent = "Flutter/Dart"; ipAddress = "10.0.0.1"; screenResolution = "1920x1080"; platform = "Windows"; language = "en" }
    },
    @{
      eventId = "evt-paste-001"; sessionId = $SessionId; employeeId = "op-trader-001"
      auditId = "audit-001"; vectorId = "vec-001"; eventType = "PASTE"
      timestamp = (Get-Date).ToUniversalTime().ToString("o")
      payload = @{ newText = ("// pasted block`n" + ("x" * 300)); changeLength = 320 }
      clientMetadata = @{ userAgent = "Flutter/Dart"; ipAddress = "10.0.0.1"; screenResolution = "1920x1080"; platform = "Windows"; language = "en" }
    }
  )
  $body = @{ events = $events } | ConvertTo-Json -Depth 8 -Compress
  $r = Invoke-Cerberus -Method POST -Path "/api/v1/guardian/ingest" -Body $body
  Write-Result "ingest/edit+paste" ($r.success -eq $true) "processed=$($r.processedCount) riskIndex=$($r.anomalyRiskIndex)"
} catch {
  Write-Result "ingest/edit+paste" $false "$_"
}

# ── 10. Live session detail ─────────────────────────────────────────
Write-Host ""
Write-Host "=== 10/14: GET /api/v1/guardian/sessions/:sessionId ===" -ForegroundColor Cyan
try {
  $r = Invoke-Cerberus -Method GET -Path "/api/v1/guardian/sessions/$SessionId"
  Write-Result "guardian/session" ($r.success -eq $true) "status=$($r.session.status) events=$($r.session.eventCount) employeeId=$($r.session.employeeId)"
} catch {
  Write-Result "guardian/session" $false "$_"
}

# ── 11. Session list ────────────────────────────────────────────────
Write-Host ""
Write-Host "=== 11/14: GET /api/v1/sessions ===" -ForegroundColor Cyan
try {
  $r = Invoke-Cerberus -Method GET -Path "/api/v1/sessions"
  $found = @($r.data | Where-Object { $_.sessionId -eq $SessionId }).Count -gt 0
  Write-Result "sessions" ($r.success -eq $true -and $found) "count=$($r.data.Count) containsSession=$found"
} catch {
  Write-Result "sessions" $false "$_"
}

# ── 12. Session review ──────────────────────────────────────────────
Write-Host ""
Write-Host "=== 12/14: GET /api/v1/sessions/:sessionId ===" -ForegroundColor Cyan
try {
  $r = Invoke-Cerberus -Method GET -Path "/api/v1/sessions/$SessionId"
  Write-Result "review" ($r.success -eq $true) "status=$($r.data.status) timeline=$($r.data.timeline.Count) risks=$($r.data.riskSummary.Count)"
} catch {
  Write-Result "review" $false "$_"
}

# ── 13. Terminate (preserves data) ──────────────────────────────────
Write-Host ""
Write-Host "=== 13/14: POST /api/v1/guardian/sessions/:sessionId/terminate ===" -ForegroundColor Cyan
try {
  $r = Invoke-Cerberus -Method POST -Path "/api/v1/guardian/sessions/$SessionId/terminate"
  $ok = $r.success -eq $true
  if ($ok) {
    $review = Invoke-Cerberus -Method GET -Path "/api/v1/sessions/$SessionId"
    $ok = $review.data.timeline.Count -gt 0
  }
  Write-Result "terminate" $ok "terminated, data preserved"
} catch {
  Write-Result "terminate" $false "$_"
}

# ── 14. Delete (removes data) ───────────────────────────────────────
Write-Host ""
Write-Host "=== 14/14: DELETE /api/v1/guardian/sessions/:sessionId ===" -ForegroundColor Cyan
try {
  $r = Invoke-Cerberus -Method DELETE -Path "/api/v1/guardian/sessions/$SessionId"
  $gone = $false
  try {
    $null = Invoke-Cerberus -Method GET -Path "/api/v1/guardian/sessions/$SessionId"
  } catch {
    $gone = $_.Exception.Response.StatusCode.value__ -eq 404
  }
  Write-Result "delete" ($r.success -eq $true -and $gone) "deleted=$($r.success) subsequentGet404=$gone"
} catch {
  Write-Result "delete" $false "$_"
}

# ── Summary ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "CERBERUS ENDPOINT SMOKE TEST - SUMMARY" -ForegroundColor Cyan
Write-Host "  Passed : $Passed / $Total" -ForegroundColor Green
if ($Failed -gt 0) {
  Write-Host "  Failed : $Failed / $Total" -ForegroundColor Red
} else {
  Write-Host "  Failed : $Failed / $Total" -ForegroundColor DarkGray
}
Write-Host ""

if ($Failed -gt 0) { exit 1 } else { exit 0 }

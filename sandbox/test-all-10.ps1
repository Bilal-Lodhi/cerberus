# ═══════════════════════════════════════════════════════════════════
# Cerberus FinSec — 12 Endpoint Smoke Test
# ═══════════════════════════════════════════════════════════════════
# Usage:
#   pwsh -File test-all-10.ps1
#   pwsh -File test-all-10.ps1 -BaseUrl http://localhost:8080
# ═══════════════════════════════════════════════════════════════════

param(
  [string]$BaseUrl = "http://localhost:8080"
)

$ErrorActionPreference = "Continue"
$Passed  = 0
$Failed  = 0
$Total   = 13

Write-Host "`n╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   12 ENDPOINT SMOKE TEST — $BaseUrl" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════╝`n" -ForegroundColor Cyan

Write-Host '=== 1/12: GET /health ===' -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod -Uri "$BaseUrl/health" -Method GET -TimeoutSec 10
  Write-Host "  ✅ PASS — $($r | ConvertTo-Json -Depth 2)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

Write-Host ''
Write-Host '=== 2/12: POST /api/v1/identity/set ===' -ForegroundColor Cyan
try {
  $body = '{"displayName":"Alice Chen","employeeId":"op-trader-001","role":"Senior Quant Trader"}'
  $r = Invoke-RestMethod -Method POST -ContentType 'application/json' -Body $body -Uri "$BaseUrl/api/v1/identity/set" -TimeoutSec 10
  $token = $r.sessionToken
  Write-Host "  ✅ PASS — sessionToken: $token" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

Write-Host ''
Write-Host '=== 3/12: GET /api/v1/identity/me ===' -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod -Method GET -Headers @{'X-Session-Token'=$token} -Uri "$BaseUrl/api/v1/identity/me" -TimeoutSec 10
  Write-Host "  ✅ PASS — $($r | ConvertTo-Json -Depth 2)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

Write-Host ''
Write-Host '=== 4/12: POST /api/v1/generate ===' -ForegroundColor Cyan
Write-Host '  ⏱  This calls Gemini — may take 20-60 seconds...' -ForegroundColor DarkYellow
try {
  $body = '{"prompt":"Generate a compliance audit for cross-border SWIFT transfer monitoring covering AML and KYC mandates","roleContext":"swift-gateway","problemCount":5,"difficultyMix":{"beginner":0.33,"intermediate":0.34,"advanced":0.33}}'
   $r = Invoke-RestMethod -Method POST -ContentType 'application/json' -Body $body -Uri "$BaseUrl/api/v1/generate" -TimeoutSec 300
  $matrixId = $r.matrix.metadata.matrixId
  $genRequestId = $r.generationRequestId
  Write-Host "  ✅ PASS — matrixId: $matrixId" -ForegroundColor Green
  Write-Host "            generationRequestId: $genRequestId" -ForegroundColor DarkGray
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
  $matrixId = "unknown"
  $genRequestId = "unknown"
}

Write-Host ''
Write-Host '=== 5/12: POST /api/v1/generate/cancel ===' -ForegroundColor Cyan
Write-Host '  ⏱  Fire generate + immediately cancel (race test)...' -ForegroundColor DarkYellow
try {
  # Fire a fresh generate request that we will immediately cancel
  $jobBody = '{"prompt":"Generate a compliance audit for cross-border SWIFT transfer monitoring covering AML and KYC mandates","roleContext":"swift-gateway","problemCount":5,"difficultyMix":{"beginner":0.33,"intermediate":0.34,"advanced":0.33}}'
  $genHeaders = @{'X-Generation-Request-Id'='cancel-test-req-001'}
  
  # Launch generate in background via a separate PowerShell job
  $genJob = Start-Job -ScriptBlock {
    param($url, $body, $headers)
    try {
      Invoke-RestMethod -Method POST -ContentType 'application/json' -Body $body -Headers $headers -Uri "$url/api/v1/generate" -TimeoutSec 120
      return "OK"
    } catch {
      return "CANCELLED"
    }
  } -ArgumentList $BaseUrl, $jobBody, $genHeaders
  
  # Give it a moment to reach the server, then cancel
  Start-Sleep -Milliseconds 500
  
  $cancelBody = '{"generationRequestId":"cancel-test-req-001"}'
  $r = Invoke-RestMethod -Method POST -ContentType 'application/json' -Body $cancelBody -Uri "$BaseUrl/api/v1/generate/cancel" -TimeoutSec 10
  
  # Clean up background job
  $null = Wait-Job $genJob -Timeout 5
  $null = Receive-Job $genJob -ErrorAction SilentlyContinue
  $null = Remove-Job $genJob -Force -ErrorAction SilentlyContinue
  
  if ($r.success -eq $true) {
    Write-Host "  ✅ PASS — cancelled in-flight generation" -ForegroundColor Green
    $Passed++
  } elseif ($r.error -match "already completed") {
    Write-Host "  ✅ PASS — generation already completed (valid race condition)" -ForegroundColor Green
    $Passed++
  } else {
    Write-Host "  ❌ FAIL — unexpected response: $($r | ConvertTo-Json -Depth 2)" -ForegroundColor Red
    $Failed++
  }
} catch {
  # Clean up background job
  $null = Remove-Job $genJob -Force -ErrorAction SilentlyContinue
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

Write-Host ''
Write-Host '=== 6/12: POST /api/v1/guardian/deploy ===' -ForegroundColor Cyan
try {
  $body = "{`"employeeUid`":`"op-trader-001`",`"sessionId`":`"active-ledger-audit-v2`",`"matrixId`":`"$matrixId`",`"targetSystem`":`"Core Trading Ledger`"}"
  $r = Invoke-RestMethod -Method POST -ContentType 'application/json' -Body $body -Uri "$BaseUrl/api/v1/guardian/deploy" -TimeoutSec 10
  Write-Host "  ✅ PASS — $($r | ConvertTo-Json -Depth 2)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

Write-Host ''
Write-Host '=== 7/12: POST /api/v1/guardian/ingest (PASTE_TRIGGER + TAB_SWITCH) ===' -ForegroundColor Cyan
try {
  $body = '{"events":[{"eventId":"evt-001","sessionId":"active-ledger-audit-v2","employeeId":"op-trader-001","auditId":"audit-001","vectorId":"vec-001","eventType":"PASTE_TRIGGER","timestamp":"2026-06-01T15:00:00.000Z","payload":{"pasteContent":"function exploitLedger() { transferFunds(offshore); }"},"clientMetadata":{"userAgent":"Mozilla/5.0","ipAddress":"10.0.0.1","screenResolution":"1920x1080","platform":"Windows","language":"en"}},{"eventId":"evt-002","sessionId":"active-ledger-audit-v2","employeeId":"op-trader-001","auditId":"audit-001","vectorId":"vec-001","eventType":"TAB_SWITCH","timestamp":"2026-06-01T15:00:05.000Z","payload":{"visibilityState":"hidden"},"clientMetadata":{"userAgent":"Mozilla/5.0","ipAddress":"10.0.0.1","screenResolution":"1920x1080","platform":"Windows","language":"en"}}]}'
  $r = Invoke-RestMethod -Method POST -ContentType 'application/json' -Body $body -Uri "$BaseUrl/api/v1/guardian/ingest" -TimeoutSec 10
  Write-Host "  ✅ PASS — processed: $($r.processedCount), riskIndex: $($r.anomalyRiskIndex)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

Write-Host ''
Write-Host '=== 7b/12: POST /api/v1/guardian/ingest (EDIT + PASTE with newText/changeLength) ===' -ForegroundColor Cyan
try {
  $body = '{"events":[{"eventId":"evt-edit-001","sessionId":"active-ledger-audit-v2","employeeId":"op-trader-001","auditId":"audit-001","vectorId":"vec-001","eventType":"EDIT","timestamp":"2026-06-02T09:30:00.000Z","payload":{"newText":"void main() {\n  print(\"hello\");\n}","changeLength":15},"clientMetadata":{"userAgent":"Flutter/Dart","ipAddress":"10.0.0.1","screenResolution":"1920x1080","platform":"Windows","language":"en"}},{"eventId":"evt-paste-001","sessionId":"active-ledger-audit-v2","employeeId":"op-trader-001","auditId":"audit-001","vectorId":"vec-001","eventType":"PASTE","timestamp":"2026-06-02T09:30:05.000Z","payload":{"newText":"void main() {\n  print(\"hello world\");\n  // pasted malicious snippet\n  transferToOffshore();\n}","changeLength":65},"clientMetadata":{"userAgent":"Flutter/Dart","ipAddress":"10.0.0.1","screenResolution":"1920x1080","platform":"Windows","language":"en"}}]}'
  $r = Invoke-RestMethod -Method POST -ContentType 'application/json' -Body $body -Uri "$BaseUrl/api/v1/guardian/ingest" -TimeoutSec 10
  Write-Host "  ✅ PASS — processed: $($r.processedCount), riskIndex: $($r.anomalyRiskIndex)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

Write-Host ''
Write-Host '=== 8/12: GET /api/v1/guardian/sessions/:sessionId ===' -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/sessions/active-ledger-audit-v2" -Method GET -TimeoutSec 10
  Write-Host "  ✅ PASS — $($r | ConvertTo-Json -Depth 2)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

Write-Host ''
Write-Host '=== 9/12: GET /api/v1/sessions ===' -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/sessions" -Method GET -TimeoutSec 10
  Write-Host "  ✅ PASS — $($r | ConvertTo-Json -Depth 2)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

Write-Host ''
Write-Host '=== 10/12: GET /api/v1/sessions/:sessionId ===' -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/sessions/active-ledger-audit-v2" -Method GET -TimeoutSec 10
  Write-Host "  ✅ PASS — $($r | ConvertTo-Json -Depth 2)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

Write-Host ''
Write-Host '=== 11/12: POST /api/v1/guardian/sessions/:sessionId/terminate (preserves audit trail) ===' -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/v1/guardian/sessions/active-ledger-audit-v2/terminate" -TimeoutSec 10
  Write-Host "  ✅ PASS — session terminated (data preserved)" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

Write-Host ''
Write-Host '=== 12/12: DELETE /api/v1/guardian/sessions/:sessionId (permanently deletes) ===' -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod -Method DELETE -Uri "$BaseUrl/api/v1/guardian/sessions/active-ledger-audit-v2" -TimeoutSec 10
  Write-Host "  ✅ PASS — session permanently deleted" -ForegroundColor Green
  $Passed++
} catch {
  Write-Host "  ❌ FAIL — $_" -ForegroundColor Red
  $Failed++
}

Write-Host ''
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  12 ENDPOINT SMOKE TEST — SUMMARY            ║" -ForegroundColor Cyan
Write-Host "╠══════════════════════════════════════════════╣" -ForegroundColor Cyan
Write-Host "║  ✅ Passed : $Passed / $Total" -ForegroundColor Green
if ($Failed -gt 0) {
  Write-Host "║  ❌ Failed : $Failed / $Total" -ForegroundColor Red
} else {
  Write-Host "║  ❌ Failed : $Failed / $Total" -ForegroundColor DarkGray
}
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Cyan

if ($Failed -gt 0) { exit 1 } else { exit 0 }
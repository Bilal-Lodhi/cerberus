# ═══════════════════════════════════════════════════════════════════
# Cerberus FinSec — Full Test Suite Runner
# ═══════════════════════════════════════════════════════════════════
# Runs all 3 test suites sequentially:
#   1. test-all-10.ps1      — 12 endpoint smoke test
#   2. test-telemetry.ps1   — 12 event types + lifecycle
#   3. test-stress.ps1      — 50 concurrent request burst
#
# USAGE:
#   pwsh -File sandbox/run-all-tests.ps1
#   pwsh -File sandbox/run-all-tests.ps1 -BaseUrl http://localhost:8080
#
# PREREQUISITES:
#   node dev-services.js
# ═══════════════════════════════════════════════════════════════════

param(
  [string]$BaseUrl = "http://localhost:8080"
)

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Passed  = 0
$Failed  = 0
$GlobalStart = Get-Date

Write-Host @"

╔══════════════════════════════════════════════════════════════╗
║  CERBERUS FINSEC — FULL TEST SUITE                          ║
║  Target: $BaseUrl                                           ║
╚══════════════════════════════════════════════════════════════╝

"@ -ForegroundColor Cyan

# ─── PRE-FLIGHT: Check server is alive ──────────────────────────
Write-Host "━━━ PRE-FLIGHT CHECK ━━━" -ForegroundColor Magenta
try {
  $h = Invoke-RestMethod -Uri "$BaseUrl/health" -Method GET -TimeoutSec 5
  Write-Host "  ✅ Server ONLINE — $($h.status)" -ForegroundColor Green
} catch {
  Write-Host "  ❌ Server OFFLINE at $BaseUrl" -ForegroundColor Red
  Write-Host "     Start with: node dev-services.js" -ForegroundColor Yellow
  exit 1
}

# ═══════════════════════════════════════════════════════════
# SUITE 1: 12 Endpoint Smoke Test
# ═══════════════════════════════════════════════════════════
Write-Host "`n━━━ SUITE 1/3: 12 ENDPOINT SMOKE TEST ━━━" -ForegroundColor Magenta
$s1Start = Get-Date
$script = Join-Path $ScriptDir "test-all-10.ps1"
& pwsh -File $script -BaseUrl $BaseUrl
$exitCode = $LASTEXITCODE
$s1Elapsed = "{0:N0}s" -f ((Get-Date) - $s1Start).TotalSeconds

if ($exitCode -eq 0) {
  Write-Host "`n  ✅ SUITE 1 PASSED (took $s1Elapsed)" -ForegroundColor Green
  $Passed++
} else {
  Write-Host "  ❌ SUITE 1 FAILED (exit: $exitCode, took $s1Elapsed)" -ForegroundColor Red
  $Failed++
}

# ═══════════════════════════════════════════════════════════
# SUITE 2: Telemetry — 12 Event Types + Lifecycle
# ═══════════════════════════════════════════════════════════
Write-Host "`n━━━ SUITE 2/3: TELEMETRY — 12 EVENT TYPES + LIFECYCLE ━━━" -ForegroundColor Magenta
$s2Start = Get-Date
$script = Join-Path $ScriptDir "test-telemetry.ps1"
& pwsh -File $script -BaseUrl $BaseUrl
$exitCode = $LASTEXITCODE
$s2Elapsed = "{0:N0}s" -f ((Get-Date) - $s2Start).TotalSeconds

if ($exitCode -eq 0) {
  Write-Host "`n  ✅ SUITE 2 PASSED (took $s2Elapsed)" -ForegroundColor Green
  $Passed++
} else {
  Write-Host "  ❌ SUITE 2 FAILED (exit: $exitCode, took $s2Elapsed)" -ForegroundColor Red
  $Failed++
}

# ═══════════════════════════════════════════════════════════
# SUITE 3: 50 Concurrent Request Burst
# ═══════════════════════════════════════════════════════════
Write-Host "`n━━━ SUITE 3/3: 50 CONCURRENT REQUEST BURST ━━━" -ForegroundColor Magenta
$s3Start = Get-Date
$script = Join-Path $ScriptDir "test-stress.ps1"
& pwsh -File $script -BaseUrl $BaseUrl
$exitCode = $LASTEXITCODE
$s3Elapsed = "{0:N0}s" -f ((Get-Date) - $s3Start).TotalSeconds

if ($exitCode -eq 0) {
  Write-Host "`n  ✅ SUITE 3 PASSED (took $s3Elapsed)" -ForegroundColor Green
  $Passed++
} else {
  Write-Host "  ❌ SUITE 3 FAILED (exit: $exitCode, took $s3Elapsed)" -ForegroundColor Red
  $Failed++
}

# ═══════════════════════════════════════════════════════════
# FINAL REPORT
# ═══════════════════════════════════════════════════════════
$totalElapsed = "{0:N0}s" -f ((Get-Date) - $GlobalStart).TotalSeconds
$total   = $Passed + $Failed
$verdict = if ($Failed -eq 0) { "✅ ALL TESTS PASSED" } else { "⚠ $Failed SUITE(S) FAILED" }

Write-Host @"

╔══════════════════════════════════════════════════════════════╗
║           CERBERUS FINSEC — TEST REPORT                     ║
╠══════════════════════════════════════════════════════════════╣
║  Passed : $Passed / $total
║  Failed : $Failed / $total
║  Time   : $totalElapsed
║  VERDICT: $verdict
╚══════════════════════════════════════════════════════════════╝

"@ -ForegroundColor Cyan

if ($Failed -gt 0) { exit 1 }
exit 0
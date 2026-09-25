# ═══════════════════════════════════════════════════════════════════
# Cerberus — full verification suite runner
# ═══════════════════════════════════════════════════════════════════
# Runs the three HTTP suites sequentially against a running instance:
#   1. smoke-api.ps1        — endpoint smoke test (14 checks)
#   2. smoke-telemetry.ps1  — 12 event types + deploy/review lifecycle
#   3. stress-telemetry.ps1 — 50-request staged concurrent burst
#
# This is a manual verification aid, NOT the automated test suite. The
# automated suite is `npm test` and requires no running server.
#
# USAGE
#   # with the API in development mode (CERBERUS_DEV_MODE=true):
#   pwsh -File scripts/verify-all.ps1
#
#   # with authentication enabled:
#   $env:CERBERUS_API_KEY = "<your key>"
#   pwsh -File scripts/verify-all.ps1 -BaseUrl http://localhost:8080
#
#   # keep AI spend down: each scenario request is a paid AI call
#   pwsh -File scripts/verify-all.ps1 -GenerateCount 1 -IngestCount 5
#
# PREREQUISITES
#   npm run build && npm start      (or: npm run dev)
# ═══════════════════════════════════════════════════════════════════

param(
  [string]$BaseUrl = "http://localhost:8080",
  [string]$ApiKey  = $env:CERBERUS_API_KEY,
  # Forwarded to stress-telemetry.ps1. Each scenario request is a paid AI call,
  # so these are exposed here rather than buried: running this suite unmodified
  # spends $GenerateCount AI requests.
  [int]$GenerateCount   = 25,
  [int]$IngestCount     = 25,
  [int]$IngestBatchSize = 3
)

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Passed  = 0
$Failed  = 0
$GlobalStart = Get-Date

if (-not $ApiKey) { $ApiKey = "" }

# Passed to the sub-suites only when non-empty.
#
# `pwsh -File script.ps1 -ApiKey ""` does NOT pass an empty string: PowerShell drops
# the empty argument, so the child sees `-ApiKey` with no value and fails with
# "Missing an argument for parameter 'ApiKey'". That broke the documented dev-mode
# usage — `pwsh -File scripts/verify-all.ps1` with no key — which is the mode most
# people run first. Splatting an array omits the parameter entirely instead.
$apiKeyArgs = if ($ApiKey.Trim().Length -gt 0) { @('-ApiKey', $ApiKey) } else { @() }

Write-Host ""
Write-Host "CERBERUS FULL VERIFICATION SUITE" -ForegroundColor Cyan
Write-Host "  Target : $BaseUrl"
if ($ApiKey.Trim().Length -gt 0) {
  Write-Host "  Auth   : Authorization: Bearer <key>"
} else {
  Write-Host "  Auth   : no key supplied - assuming development mode" -ForegroundColor DarkYellow
}
Write-Host ""

# ─── PRE-FLIGHT: Check server is alive ──────────────────────────
Write-Host "--- PRE-FLIGHT CHECK ---" -ForegroundColor Magenta
try {
  $h = Invoke-RestMethod -Uri "$BaseUrl/health" -Method GET -TimeoutSec 5
  Write-Host "  PASS - server online, status=$($h.status)" -ForegroundColor Green
} catch {
  Write-Host "  FAIL - server offline at $BaseUrl" -ForegroundColor Red
  Write-Host "     Start with: npm run dev   (or: npm run build && npm start)" -ForegroundColor Yellow
  exit 1
}

# ═══════════════════════════════════════════════════════════
# SUITE 1: Endpoint smoke test
# ═══════════════════════════════════════════════════════════
Write-Host ""
Write-Host "--- SUITE 1/3: ENDPOINT SMOKE TEST ---" -ForegroundColor Magenta
$s1Start = Get-Date
$script = Join-Path $ScriptDir "smoke-api.ps1"
& pwsh -File $script -BaseUrl $BaseUrl @apiKeyArgs
$exitCode = $LASTEXITCODE
$s1Elapsed = "{0:N0}s" -f ((Get-Date) - $s1Start).TotalSeconds

if ($exitCode -eq 0) {
  Write-Host ""
  Write-Host "  SUITE 1 PASSED (took $s1Elapsed)" -ForegroundColor Green
  $Passed++
} else {
  Write-Host "  SUITE 1 FAILED (exit: $exitCode, took $s1Elapsed)" -ForegroundColor Red
  $Failed++
}

# ═══════════════════════════════════════════════════════════
# SUITE 2: Telemetry — 12 event types + lifecycle
# ═══════════════════════════════════════════════════════════
Write-Host ""
Write-Host "--- SUITE 2/3: TELEMETRY - 12 EVENT TYPES + DEPLOY/REVIEW LIFECYCLE ---" -ForegroundColor Magenta
$s2Start = Get-Date
$script = Join-Path $ScriptDir "smoke-telemetry.ps1"
& pwsh -File $script -BaseUrl $BaseUrl @apiKeyArgs
$exitCode = $LASTEXITCODE
$s2Elapsed = "{0:N0}s" -f ((Get-Date) - $s2Start).TotalSeconds

if ($exitCode -eq 0) {
  Write-Host ""
  Write-Host "  SUITE 2 PASSED (took $s2Elapsed)" -ForegroundColor Green
  $Passed++
} else {
  Write-Host "  SUITE 2 FAILED (exit: $exitCode, took $s2Elapsed)" -ForegroundColor Red
  $Failed++
}

# ═══════════════════════════════════════════════════════════
# SUITE 3: Staged concurrent burst
# ═══════════════════════════════════════════════════════════
Write-Host ""
Write-Host "--- SUITE 3/3: 50-REQUEST STAGED CONCURRENT BURST ---" -ForegroundColor Magenta
$s3Start = Get-Date
$script = Join-Path $ScriptDir "stress-telemetry.ps1"
& pwsh -File $script -BaseUrl $BaseUrl @apiKeyArgs `
  -GenerateCount $GenerateCount -IngestCount $IngestCount -IngestBatchSize $IngestBatchSize
$exitCode = $LASTEXITCODE
$s3Elapsed = "{0:N0}s" -f ((Get-Date) - $s3Start).TotalSeconds

if ($exitCode -eq 0) {
  Write-Host ""
  Write-Host "  SUITE 3 PASSED (took $s3Elapsed)" -ForegroundColor Green
  $Passed++
} else {
  Write-Host "  SUITE 3 FAILED (exit: $exitCode, took $s3Elapsed)" -ForegroundColor Red
  $Failed++
}

# ═══════════════════════════════════════════════════════════
# FINAL REPORT
# ═══════════════════════════════════════════════════════════
$totalElapsed = "{0:N0}s" -f ((Get-Date) - $GlobalStart).TotalSeconds
$total   = $Passed + $Failed
$verdict = if ($Failed -eq 0) { "ALL SUITES PASSED" } else { "$Failed SUITE(S) FAILED" }

Write-Host ""
Write-Host "CERBERUS FULL VERIFICATION SUITE - REPORT" -ForegroundColor Cyan
Write-Host "  Passed  : $Passed / $total"
Write-Host "  Failed  : $Failed / $total"
Write-Host "  Time    : $totalElapsed"
Write-Host "  Verdict : $verdict"
Write-Host ""

if ($Failed -gt 0) { exit 1 }
exit 0

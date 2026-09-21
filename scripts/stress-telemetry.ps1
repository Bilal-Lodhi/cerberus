# ═══════════════════════════════════════════════════════════════════
# Cerberus — staged concurrency and burst test
# ═══════════════════════════════════════════════════════════════════
# Fires a staged burst of HTTP requests against a running instance to
# observe behaviour under load:
#   - N x POST /api/v1/scenarios        (scenario authoring; each one calls
#                                        the configured AI provider)
#   - N x POST /api/v1/guardian/ingest  (batched micro-events, paced)
#
# Both phases run in waves so the request rate is predictable. The ingest
# waves are spaced by $IngestWaveDelay seconds; nothing here assumes a
# server-side concurrency limit, and no rate limit is enforced by the API.
#
# This is a manual verification aid, NOT the automated test suite. The
# automated suite is `npm test` and requires no running server.
#
# USAGE
#   # with the API in development mode (CERBERUS_DEV_MODE=true):
#   pwsh -File scripts/stress-telemetry.ps1
#
#   # with authentication enabled:
#   $env:CERBERUS_API_KEY = "<your key>"
#   pwsh -File scripts/stress-telemetry.ps1 -BaseUrl http://localhost:8080 `
#     -GenerateCount 25 -IngestCount 25 -IngestBatchSize 3
#
# PREREQUISITES
#   npm run build && npm start      (or: npm run dev)
#
# NOTE: the scenario phase calls the configured AI provider for every
# request and can be slow and costly. Lower -GenerateCount when testing.
# ═══════════════════════════════════════════════════════════════════

param(
  [string]$BaseUrl = "http://localhost:8080",
  [string]$ApiKey  = $env:CERBERUS_API_KEY,
  [int]$GenerateCount = 25,         # scenario authoring requests
  [int]$IngestCount    = 25,        # micro-event ingest requests
  [int]$IngestBatchSize = 3         # events per ingest request
)

$ErrorActionPreference = "Continue"
$TotalRequests = $GenerateCount + $IngestCount

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
Write-Host "CERBERUS STAGED CONCURRENCY AND BURST TEST" -ForegroundColor Cyan
Write-Host "  Target                : $BaseUrl"
Write-Host "  Scenario requests     : ${GenerateCount} (each calls the AI provider)"
Write-Host "  Ingest requests       : ${IngestCount} x ${IngestBatchSize} events (paced)"
Write-Host "  TOTAL requests        : ${TotalRequests}"
Write-Host ""

# ─── Global Stats ──────────────────────────────────────────────
$global:Lock            = [System.Threading.Mutex]::new()
$global:StartTime       = Get-Date
$global:GenSent         = 0
$global:GenOK           = 0
$global:GenFail         = 0
$global:GenTotalLatency = 0
$global:IngestSent      = 0
$global:IngestOK        = 0
$global:IngestFail      = 0
$global:IngestLatency   = 0
$global:GenMinLatency   = 999999
$global:GenMaxLatency   = 0
$global:IngestMinLatency = 999999
$global:IngestMaxLatency = 0

function Sync-UpdateGen($ok, $fail, $latencyMs) {
  [void]$global:Lock.WaitOne()
  $global:GenSent++
  if ($ok) { $global:GenOK++; $global:GenTotalLatency += $latencyMs
    if ($latencyMs -lt $global:GenMinLatency) { $global:GenMinLatency = $latencyMs }
    if ($latencyMs -gt $global:GenMaxLatency) { $global:GenMaxLatency = $latencyMs }
  } else { $global:GenFail++ }
  [void]$global:Lock.ReleaseMutex()
}

function Sync-UpdateIngest($ok, $fail, $latencyMs) {
  [void]$global:Lock.WaitOne()
  $global:IngestSent++
  if ($ok) { $global:IngestOK++; $global:IngestLatency += $latencyMs
    if ($latencyMs -lt $global:IngestMinLatency) { $global:IngestMinLatency = $latencyMs }
    if ($latencyMs -gt $global:IngestMaxLatency) { $global:IngestMaxLatency = $latencyMs }
  } else { $global:IngestFail++ }
  [void]$global:Lock.ReleaseMutex()
}

# ─── Progress Bar ──────────────────────────────────────────────
function Show-Progress($label, $done, $total) {
  $pct  = [math]::Round(100 * $done / $total, 0)
  $bar  = "#" * [math]::Floor($pct / 2) + "-" * (50 - [math]::Floor($pct / 2))
  $elapsed = [math]::Round(((Get-Date) - $global:StartTime).TotalSeconds, 1)
  Write-Host "`r  [$label] [$bar] ${done}/${total} (${pct}%) - ${elapsed}s elapsed" -NoNewline
}

# ═══════════════════════════════════════════════════════════════
# PHASE 0: Health Check (public)
# ═══════════════════════════════════════════════════════════════
Write-Host "[PHASE 0] Health check..." -ForegroundColor Magenta
try {
  $h = Invoke-RestMethod -Uri "$BaseUrl/health" -Method GET -TimeoutSec 5
  Write-Host "  PASS - server online, status=$($h.status)" -ForegroundColor Green
} catch {
  Write-Host "  FATAL - server not reachable at $BaseUrl" -ForegroundColor Red
  Write-Host "     Start with: npm run dev   (or: npm run build && npm start)" -ForegroundColor Yellow
  exit 1
}

# ═══════════════════════════════════════════════════════════════
# PHASE 1: Deploy test session (needed for ingest)
# ═══════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "[PHASE 1] Deploying test session..." -ForegroundColor Magenta
$SessionId = "burst-session-$(Get-Date -Format 'HHmmss')"

$deployBody = @{
  employeeUid  = "op-trader-001"
  sessionId    = $SessionId
  matrixId     = "burst-matrix"
  targetSystem = "Core Trading Ledger - burst test"
} | ConvertTo-Json

try {
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/deploy" -Method POST `
    -ContentType "application/json" -Body $deployBody -Headers (Merge-Headers) -TimeoutSec 10
  Write-Host "  PASS - session deployed: $SessionId" -ForegroundColor Green
} catch {
  Write-Host "  WARN - deploy failed (continuing): $($_.Exception.Message)" -ForegroundColor Yellow
}

# ═══════════════════════════════════════════════════════════════
# PHASE 2: SCENARIO AUTHORING REQUESTS - WAVES
# ═══════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "[PHASE 2] Firing ${GenerateCount} scenario authoring requests..." -ForegroundColor Magenta
Write-Host "  (Waves of 5 - each request calls the configured AI provider)" -ForegroundColor DarkGray
Write-Host ""

$genPrompts = @(
  "Author threat scenarios for a SOX trading desk audit",
  "Author threat scenarios for AML monitoring on cross-border payments",
  "Author threat scenarios for FINRA high-frequency trading compliance",
  "Author threat scenarios for KYC verification of institutional clients",
  "Author threat scenarios for MiFID II transaction reporting",
  "Author threat scenarios for algorithmic trading risk",
  "Author threat scenarios for GDPR handling of financial customer records",
  "Author threat scenarios for Basel III capital adequacy reporting"
)

$GenWaveSize = 5    # Fire 5 at a time
$GenWaveDelay = 0   # 0 - next wave starts as soon as the current wave completes
$GenWaves     = [math]::Ceiling($GenerateCount / $GenWaveSize)

$genStartTime = Get-Date
$genGlobalIdx = 0

for ($genWave = 1; $genWave -le $GenWaves; $genWave++) {
  $remaining = $GenerateCount - (($genWave - 1) * $GenWaveSize)
  $thisWave  = [math]::Min($GenWaveSize, $remaining)
  $genElapsedSoFar = [math]::Round(((Get-Date) - $genStartTime).TotalSeconds, 1)

  $pct = [math]::Round(($genWave - 1) / $GenWaves * 100)
  $bar = "#" * [math]::Floor($pct / 5) + "-" * (20 - [math]::Floor($pct / 5))
  Write-Host "  [SCENARIOS] [$bar] ($genWave/$GenWaves) - ${genElapsedSoFar}s elapsed, firing ${thisWave} concurrent requests..." -ForegroundColor DarkYellow

  $waveResults = 1..$thisWave | ForEach-Object -Parallel {
    $idx      = ($using:genWave - 1) * $using:GenWaveSize + $_
    $BaseUrl  = $using:BaseUrl
    $prompts  = $using:genPrompts
    $key      = $using:ApiKey
    $prompt   = $prompts[$idx % $prompts.Count]
    $headers  = @{}
    if ($key) { $headers["Authorization"] = "Bearer $key" }
    $body     = (@{
      prompt        = "$prompt - batch item $idx"
      roleContext   = "trading-desk-audit"
      vectorCount   = 2
      severityMix   = @{ low = 0.2; medium = 0.5; high = 0.2; critical = 0.1 }
    } | ConvertTo-Json -Compress)

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
      $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/scenarios" -Method POST `
        -ContentType "application/json" -Body $body -Headers $headers -TimeoutSec 120
      $sw.Stop()
      $latency = $sw.Elapsed.TotalMilliseconds
      $matrixId = if ($r.matrix.metadata.matrixId) { $r.matrix.metadata.matrixId } else { "N/A" }
      return @{ ok=$true; idx=$idx; latencyMs=$latency; matrixId=$matrixId }
    } catch {
      $sw.Stop()
      return @{ ok=$false; idx=$idx; latencyMs=$sw.Elapsed.TotalMilliseconds; error=$_.Exception.Message }
    }
  } -ThrottleLimit $thisWave

  foreach ($r in $waveResults) {
    Sync-UpdateGen $r.ok $false $r.latencyMs
    if ($r.ok) {
      Write-Host "    [SCENARIO #$($r.idx)] PASS $([math]::Round($r.latencyMs,0))ms -> matrix=$($r.matrixId)" -ForegroundColor DarkGreen
    } else {
      Write-Host "    [SCENARIO #$($r.idx)] FAIL $([math]::Round($r.latencyMs,0))ms - $($r.error)" -ForegroundColor DarkRed
    }
  }
}

$genElapsed = [math]::Round(((Get-Date) - $genStartTime).TotalSeconds, 1)
Write-Host ""
Write-Host "  Scenario burst complete in ${genElapsed}s" -ForegroundColor Green

# ═══════════════════════════════════════════════════════════════
# PHASE 3: MICRO-EVENT INGEST REQUESTS - PACED CONCURRENT
# ═══════════════════════════════════════════════════════════════
$EventTypes = @("KEYSTROKE","EDIT","PASTE","PASTE_TRIGGER","CODE_DELTA","TAB_SWITCH",
                 "WINDOW_BLUR","COPY_ATTEMPT","DEVELOPER_TOOLS_OPEN","FULLSCREEN_EXIT",
                 "EXTERNAL_APP_SWITCH","SUBMIT")

$IngestWaveSize = 5    # Fire 5 at a time
$IngestWaveDelay = 1   # 1 second between waves
$IngestWaves    = [math]::Ceiling($IngestCount / $IngestWaveSize)

Write-Host ""
Write-Host "[PHASE 3] Firing ${IngestCount} ingest requests, ${IngestBatchSize} events each..." -ForegroundColor Magenta
Write-Host "  (Waves of ${IngestWaveSize} with a ${IngestWaveDelay}s gap, so the write rate stays predictable)" -ForegroundColor DarkGray
Write-Host ""

$ingestStartTime = Get-Date

for ($wave = 1; $wave -le $IngestWaves; $wave++) {
  $remaining = $IngestCount - (($wave - 1) * $IngestWaveSize)
  $thisWave  = [math]::Min($IngestWaveSize, $remaining)

  Write-Host "  Wave $wave/$IngestWaves - firing ${thisWave} concurrent ingest requests..." -ForegroundColor DarkYellow

  $waveResults = 1..$thisWave | ForEach-Object -Parallel {
    $idx       = $_
    $waveIdx   = $using:wave
    $BaseUrl   = $using:BaseUrl
    $SessionId = $using:SessionId
    $types     = $using:EventTypes
    $batchSize = $using:IngestBatchSize
    $key       = $using:ApiKey
    $headers   = @{}
    if ($key) { $headers["Authorization"] = "Bearer $key" }

    $events = @()
    for ($b = 1; $b -le $batchSize; $b++) {
      $eventType = $types[($idx + $waveIdx * 7 + $b) % $types.Count]
      $events += [ordered]@{
        eventId        = "burst-${waveIdx}-${idx}-${b}-$(Get-Random -Min 1000 -Max 9999)"
        sessionId      = $SessionId
        employeeId     = "op-trader-001"
        auditId        = "audit-burst"
        vectorId       = "vec-burst"
        eventType      = $eventType
        timestamp      = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        payload        = @{ changeLength = (Get-Random -Min 5 -Max 50); newText = "// Burst test wave $waveIdx request $idx event $b" }
        clientMetadata = @{
          userAgent        = "StressTest/3.0"
          ipAddress        = "10.0.$(Get-Random -Min 1 -Max 255).$(Get-Random -Min 1 -Max 255)"
          screenResolution = "1920x1080"
          platform         = "Windows"
          language         = "en"
        }
      }
    }

    $body = @{ events = @($events) } | ConvertTo-Json -Depth 6 -Compress
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
      $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/ingest" -Method POST `
        -ContentType "application/json" -Body $body -Headers $headers -TimeoutSec 20
      $sw.Stop()
      return @{ ok=$true; idx=$idx; latencyMs=$sw.Elapsed.TotalMilliseconds; riskIdx=$r.anomalyRiskIndex }
    } catch {
      $sw.Stop()
      return @{ ok=$false; idx=$idx; latencyMs=$sw.Elapsed.TotalMilliseconds; error=$_.Exception.Message }
    }
  } -ThrottleLimit $thisWave

  foreach ($r in $waveResults) {
    Sync-UpdateIngest $r.ok $false $r.latencyMs
    if ($r.ok) {
      Write-Host "    [INGEST W${wave} #$($r.idx)] PASS $([math]::Round($r.latencyMs,0))ms riskIdx=$($r.riskIdx)" -ForegroundColor DarkGreen
    } else {
      Write-Host "    [INGEST W${wave} #$($r.idx)] FAIL $([math]::Round($r.latencyMs,0))ms - $($r.error)" -ForegroundColor DarkRed
    }
  }

  $ingestDone = ($wave * $IngestWaveSize)
  if ($ingestDone -gt $IngestCount) { $ingestDone = $IngestCount }
  Show-Progress "INGEST" $ingestDone $IngestCount

  if ($wave -lt $IngestWaves) {
    Start-Sleep -Seconds $IngestWaveDelay
  }
}

$ingestElapsed = [math]::Round(((Get-Date) - $ingestStartTime).TotalSeconds, 1)
Write-Host ""
Write-Host "  Ingest burst complete in ${ingestElapsed}s" -ForegroundColor Green

# ═══════════════════════════════════════════════════════════════
# PHASE 4: Verify session state
# ═══════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "[PHASE 4] Session verification..." -ForegroundColor Magenta
Start-Sleep -Seconds 2

try {
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/sessions/$SessionId" -Method GET -Headers (Merge-Headers) -TimeoutSec 10
  $s = if ($r.session) { $r.session } else { $r.data }
  Write-Host "  sessionId      : $($s.sessionId)" -ForegroundColor Green
  Write-Host "  eventCount     : $($s.eventCount)" -ForegroundColor Green
  Write-Host "  riskIndex      : $($s.riskIndex)" -ForegroundColor Green
  Write-Host "  alertTriggered : $($s.alertTriggered)" -ForegroundColor Green
  Write-Host "  status         : $($s.status)" -ForegroundColor Green
} catch {
  Write-Host "  VERIFY FAIL: $($_.Exception.Message)" -ForegroundColor Red
}

# List all sessions
try {
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/sessions" -Method GET -Headers (Merge-Headers) -TimeoutSec 10
  Write-Host "  totalSessions  : $($r.data.Count)" -ForegroundColor Green
} catch {
  Write-Host "  SESSIONS LIST: $($_.Exception.Message)" -ForegroundColor Red
}

# ═══════════════════════════════════════════════════════════════
# PHASE 5: Terminate (preserves the audit trail)
# ═══════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "[PHASE 5] Terminate session (preserves the audit trail)..." -ForegroundColor Magenta
try {
  $r = Invoke-RestMethod -Uri "$BaseUrl/api/v1/guardian/sessions/$SessionId/terminate" -Method POST -Headers (Merge-Headers) -TimeoutSec 10
  Write-Host "  PASS - $($r.message)" -ForegroundColor Green
} catch {
  Write-Host "  WARN - $($_.Exception.Message)" -ForegroundColor Yellow
}

# ═══════════════════════════════════════════════════════════════
# REPORT
# ═══════════════════════════════════════════════════════════════
$totalElapsed = [math]::Round(((Get-Date) - $global:StartTime).TotalSeconds, 1)

$genAvgLat  = if ($global:GenOK -gt 0) { [math]::Round($global:GenTotalLatency / $global:GenOK, 0) } else { 0 }
$ingAvgLat  = if ($global:IngestOK -gt 0) { [math]::Round($global:IngestLatency / $global:IngestOK, 0) } else { 0 }
$genRate    = if ($genElapsed -gt 0) { [math]::Round($GenerateCount / $genElapsed, 1) } else { 0 }
$ingRate    = if ($ingestElapsed -gt 0) { [math]::Round($IngestCount / $ingestElapsed, 1) } else { 0 }
$genSuccess = if ($GenerateCount -gt 0) { [math]::Round(100 * $global:GenOK / $GenerateCount, 2) } else { 0 }
$ingSuccess = if ($IngestCount -gt 0) { [math]::Round(100 * $global:IngestOK / $IngestCount, 2) } else { 0 }
$totalOK    = $global:GenOK + $global:IngestOK
$totalFail  = $global:GenFail + $global:IngestFail
$totalRate  = if ($totalElapsed -gt 0) { [math]::Round($TotalRequests / $totalElapsed, 1) } else { 0 }

Write-Host ""
Write-Host "CERBERUS STAGED CONCURRENCY AND BURST TEST - REPORT" -ForegroundColor Cyan
Write-Host "  Total elapsed        : ${totalElapsed}s"
Write-Host "  Total requests       : ${TotalRequests} (${totalOK} OK / ${totalFail} FAIL)"
Write-Host "  Overall rate         : ${totalRate} req/sec"
Write-Host "  -- scenario authoring --"
Write-Host "  Sent                 : ${GenerateCount}"
Write-Host "  Success              : $($global:GenOK) (${genSuccess}%)"
Write-Host "  Failed               : $($global:GenFail)"
Write-Host "  Avg latency          : ${genAvgLat}ms"
Write-Host "  Min / max latency    : $($global:GenMinLatency)ms / $($global:GenMaxLatency)ms"
Write-Host "  Throughput           : ${genRate} req/sec"
Write-Host "  -- micro-event ingest --"
Write-Host "  Sent                 : ${IngestCount} (${IngestBatchSize} events per request)"
Write-Host "  Success              : $($global:IngestOK) (${ingSuccess}%)"
Write-Host "  Failed               : $($global:IngestFail)"
Write-Host "  Avg latency          : ${ingAvgLat}ms"
Write-Host "  Min / max latency    : $($global:IngestMinLatency)ms / $($global:IngestMaxLatency)ms"
Write-Host "  Throughput           : ${ingRate} req/sec"
Write-Host ""

if ($totalFail -eq 0) {
  Write-Host "  Zero failures - ${TotalRequests} requests completed without an error response." -ForegroundColor Green
} elseif ($totalFail -lt ($TotalRequests * 0.05)) {
  Write-Host "  ${totalFail} failure(s), under 5% of ${TotalRequests} requests." -ForegroundColor Yellow
} else {
  Write-Host "  ${totalFail} failure(s), 5% or more of ${TotalRequests} requests - check the server logs." -ForegroundColor Red
}

if ($totalFail -gt ($TotalRequests * 0.05)) { exit 1 }
exit 0

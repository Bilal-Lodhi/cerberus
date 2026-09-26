<#
.SYNOPSIS
    Restore a Cerberus backup, and verify the restore against the backup manifest.

.DESCRIPTION
    Restoring is the half of the procedure that is usually untested, so this script
    is deliberately more cautious than the backup:

      - It refuses to restore over the database the backup came from unless
        -AllowSameDatabase is passed. Restoring onto live data is a destructive act
        and should never be one typo away.
      - It refuses to overwrite a non-empty target unless -Drop is passed.
      - It compares the restored document counts against the manifest and fails if
        they differ, so "the restore ran" is not mistaken for "the restore worked".

    The recommended drill is to restore into a scratch database, verify, and drop
    it. See docs/operations/backup-restore.md.

.PARAMETER Backup
    Directory produced by backup-cerberus.ps1, e.g. ./backups/cerberus-20260101-120000

.PARAMETER Uri
    MongoDB connection string, for the local-tools path.

.PARAMETER Container
    Name of a running MongoDB container holding the mongorestore tools.

.PARAMETER TargetDatabase
    Database to restore into. Defaults to the source database's name with `_restore`
    appended, which is safe by construction.

.PARAMETER Drop
    Drop each collection before restoring it.

.PARAMETER AllowSameDatabase
    Permit restoring into the database named in the manifest. Destructive.

.EXAMPLE
    # The drill: restore into a scratch database and verify.
    ./scripts/restore-cerberus.ps1 -Backup ./backups/cerberus-20260101-120000 -Container cerberus-mongo
#>

[CmdletBinding(DefaultParameterSetName = 'Uri')]
param(
    [Parameter(Mandatory = $true)]
    [string]$Backup,

    [Parameter(ParameterSetName = 'Uri')]
    [string]$Uri = 'mongodb://127.0.0.1:27017',

    [Parameter(ParameterSetName = 'Container', Mandatory = $true)]
    [string]$Container,

    [string]$TargetDatabase,
    [switch]$Drop,
    [switch]$AllowSameDatabase
)

$ErrorActionPreference = 'Stop'

# ── Read and check the manifest first ────────────────────────────────────────
$manifestPath = Join-Path $Backup 'manifest.json'
if (-not (Test-Path $manifestPath)) {
    throw "No manifest.json in $Backup. Take the backup with backup-cerberus.ps1 so there is something to verify against."
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$sourceDatabase = $manifest.database

if (-not $TargetDatabase) {
    $TargetDatabase = "$sourceDatabase`_restore"
    Write-Host "[restore] no -TargetDatabase given; using '$TargetDatabase'"
}

if ($TargetDatabase -eq $sourceDatabase -and -not $AllowSameDatabase) {
    throw "Refusing to restore '$sourceDatabase' over itself. Pass -AllowSameDatabase if that is genuinely intended, or name a different -TargetDatabase."
}

$dump = Join-Path $Backup $sourceDatabase
if (-not (Test-Path $dump)) { throw "No dump directory at $dump" }

Write-Host "[restore] backup taken  $($manifest.takenAtUtc)"
Write-Host "[restore] source db     $sourceDatabase"
Write-Host "[restore] target db     $TargetDatabase"

# ── Refuse to clobber a non-empty target by accident ─────────────────────────
$localTools = [bool](Get-Command mongorestore -ErrorAction SilentlyContinue)
$countScript = 'db.getCollectionNames().sort().forEach(n => print(n, db.getCollection(n).countDocuments({})))'

function Get-Counts([string]$database) {
    $raw = if ($localTools) {
        & mongosh "$Uri/$database" --quiet --eval $countScript
    }
    else {
        docker exec $Container mongosh "$database" --quiet --eval $countScript
    }
    $result = [ordered]@{}
    foreach ($line in @($raw)) {
        $parts = "$line".Trim() -split '\s+'
        if ($parts.Count -eq 2 -and $parts[1] -match '^\d+$') { $result[$parts[0]] = [int]$parts[1] }
    }
    return $result
}

$existing = Get-Counts $TargetDatabase
$existingTotal = ($existing.Values | Measure-Object -Sum).Sum
if ($existingTotal -gt 0 -and -not $Drop) {
    throw "Target database '$TargetDatabase' already holds $existingTotal document(s). Pass -Drop to replace them, or choose another -TargetDatabase."
}

# ── Restore ──────────────────────────────────────────────────────────────────
#
# Both paths pass the dump ROOT — the parent of the database directory — not the
# database directory itself. mongorestore derives the source namespace from the
# directory layout (`<root>/<db>/<collection>.bson`), so pointing it at `<root>/<db>`
# makes it look for `<root>/<db>/<db>/...` and silently restore nothing. It reports
# "don't know what to do with file ..., skipping" and exits 0, which is why the
# verification step below matters more than the exit code.
if ($localTools) {
    Write-Host '[restore] using local mongorestore'
    $restoreArgs = @("--uri=$Uri", "--nsFrom=$sourceDatabase.*", "--nsTo=$TargetDatabase.*")
    if ($Drop) { $restoreArgs += '--drop' }
    $restoreArgs += $Backup
    & mongorestore @restoreArgs
    if ($LASTEXITCODE -ne 0) { throw "mongorestore failed with exit code $LASTEXITCODE" }
}
elseif ($Container) {
    Write-Host "[restore] using mongorestore inside container '$Container'"
    $inner = "/tmp/cerberus-restore-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    docker exec $Container mkdir -p $inner | Out-Null
    # Copy the database directory INTO the scratch root, giving `<inner>/<db>`.
    docker cp "$dump" "${Container}:${inner}/$(Split-Path $dump -Leaf)"
    if ($LASTEXITCODE -ne 0) { throw "docker cp failed with exit code $LASTEXITCODE" }

    $restoreArgs = @(
        'mongorestore',
        "--nsFrom=$sourceDatabase.*",
        "--nsTo=$TargetDatabase.*"
    )
    if ($Drop) { $restoreArgs += '--drop' }
    $restoreArgs += $inner

    docker exec $Container @restoreArgs
    if ($LASTEXITCODE -ne 0) {
        docker exec $Container rm -rf $inner | Out-Null
        throw "mongorestore in the container failed with exit code $LASTEXITCODE"
    }
    docker exec $Container rm -rf $inner | Out-Null
}
else {
    throw 'mongorestore is not on PATH and no -Container was given. Install the MongoDB database tools, or pass -Container <name>.'
}

# ── Verify against the manifest ──────────────────────────────────────────────
Write-Host ''
Write-Host '[restore] verifying against the manifest'
$restored = Get-Counts $TargetDatabase
$failures = @()

foreach ($property in $manifest.collections.PSObject.Properties) {
    $collection = $property.Name
    $expected = [int]$property.Value
    $actual = if ($restored.Contains($collection)) { [int]$restored[$collection] } else { 0 }
    $mark = if ($expected -eq $actual) { 'ok  ' } else { 'FAIL' }
    Write-Host ("  {0} {1,-24} expected {2,-8} got {3}" -f $mark, $collection, $expected, $actual)
    if ($expected -ne $actual) { $failures += $collection }
}

if ($failures.Count -gt 0) {
    throw "Restore verification failed for: $($failures -join ', '). The restore is NOT usable."
}

# ── Verify the uniqueness and retention guarantees the counts cannot see ─────
#
# A count comparison is blind to indexes. `mongorestore` exits 0 whether or not it restored
# them, and a dump taken with `--noIndexRestore` — or restored that way — comes back with
# every document and none of the constraints. Two rows sharing a `riskAssessmentId` would
# then be accepted by a database that is supposed to forbid it, and nothing would say so
# until the next write that should have been rejected. Two paid-operation claims sharing an
# idempotency key would be worse: the second one means a retry spent a second time.
#
# The TTL indexes are checked here for the same reason even though they fail differently: a
# lost TTL index changes no answer at all, it just lets a collection grow without limit.
# `operation_claims` holds one record per caller-supplied idempotency key, so it is the
# collection where that matters most — and the one easiest to forget, because nothing
# breaks visibly.
#
# The list lives in `scripts/release/critical-indexes.json`, shared with the
# backup/restore drill and asserted against the real store by
# `apps/api/test/release/critical-indexes.test.ts` — so it cannot name an index the product
# does not create, and the product cannot add one the list omits.
Write-Host ''
Write-Host '[restore] verifying the critical indexes'

$criticalPath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'release/critical-indexes.json'
if (-not (Test-Path $criticalPath)) {
    throw "The critical-index list is missing at '$criticalPath', so a restore cannot be checked for its uniqueness guarantees. Restore it, or fix the path."
}
$criticalDocument = Get-Content $criticalPath -Raw | ConvertFrom-Json
$critical = $criticalDocument.indexes
$criticalTtl = $criticalDocument.ttlIndexes
if (-not $criticalTtl) { $criticalTtl = @() }

# A here-string rather than a one-line nested-arrow expression: the one-liner had an
# unbalanced parenthesis, which mongosh reported as `Unexpected token, expected ","` and
# which the verification then read as "no unique indexes at all" — a false failure on a
# perfectly good restore. Readable and balanced beats compact.
#
# Each line is prefixed with its kind, so one pass over the server's indexes answers both
# questions and the parser cannot confuse a TTL index for a unique one.
$indexScript = @'
db.getCollectionNames().sort().forEach(function (collection) {
  db.getCollection(collection).getIndexes().forEach(function (index) {
    var keys = Object.keys(index.key).join("+");
    if (index.unique) print("unique", collection, keys);
    if (typeof index.expireAfterSeconds === "number") {
      print("ttl", collection, keys, index.expireAfterSeconds);
    }
  });
});
'@


function Get-ServerIndexes([string]$database, [string]$kind, [int]$tokenCount) {
    $raw = if ($localTools) {
        & mongosh "$Uri/$database" --quiet --eval $indexScript
    }
    else {
        docker exec $Container mongosh "$database" --quiet --eval $indexScript
    }
    # An array, not a HashSet: PowerShell **unrolls** a collection returned from a
    # function, so a HashSet comes back as an array of its elements and a `.Contains()`
    # call on it fails. `-contains` works on a scalar or an array, so `@(...)` around the
    # call makes this correct however many indexes there are.
    $result = @()
    foreach ($line in @($raw)) {
        $parts = "$line".Trim() -split '\s+'
        if ($parts.Count -eq $tokenCount -and $parts[0] -eq $kind) {
            # Everything after the kind and the collection, joined with ':' — so a unique
            # index is `<collection>:<keys>` and a TTL index is
            # `<collection>:<keys>:<expireAfterSeconds>`.
            $result += ($parts[1..($parts.Count - 1)] -join ':')
        }
    }
    return $result
}

$restoredIndexes = @(Get-ServerIndexes $TargetDatabase 'unique' 3)
$restoredTtl = @(Get-ServerIndexes $TargetDatabase 'ttl' 4)
$missingIndexes = @()

Write-Host "  unique indexes found: $(if ($restoredIndexes.Count -gt 0) { $restoredIndexes -join ', ' } else { 'none' })"
Write-Host "  TTL indexes found:    $(if ($restoredTtl.Count -gt 0) { $restoredTtl -join ', ' } else { 'none' })"

foreach ($entry in $critical) {
    # The key pattern is compared as the driver reports it: field names in order, joined
    # with '+'. `{ sessionId: 1, eventId: 1 }` becomes `sessionId+eventId`.
    $keys = ($entry.key.PSObject.Properties.Name) -join '+'
    $needle = "$($entry.collection):$keys"
    $present = $restoredIndexes -contains $needle
    $mark = if ($present) { 'ok  ' } else { 'FAIL' }
    Write-Host ("  {0} unique {1}" -f $mark, $needle)
    if (-not $present) { $missingIndexes += $needle }
}

foreach ($entry in $criticalTtl) {
    $keys = ($entry.key.PSObject.Properties.Name) -join '+'
    # `$(...)` around each variable rather than `$name:` — PowerShell reads `$keys:` as a
    # scope qualifier and fails with "':' was not followed by a valid variable name
    # character", which is a parse error rather than a wrong string.
    $needle = "$($entry.collection):$($keys):$($entry.expireAfterSeconds)"
    $present = $restoredTtl -contains $needle
    $mark = if ($present) { 'ok  ' } else { 'FAIL' }
    Write-Host ("  {0} ttl    {1}" -f $mark, $needle)
    if (-not $present) { $missingIndexes += $needle }
}

if ($missingIndexes.Count -gt 0) {
    throw "The restore is missing these indexes: $($missingIndexes -join ', '). Every document came back, but the constraints and retention bounds that keep them in order did not — a restored database would accept duplicates the product forbids, or grow without limit. Do not use this restore."
}

Write-Host ''
Write-Host "[restore] OK - $TargetDatabase matches the backup, with its uniqueness and retention guarantees"
Write-Host "[restore] drop the scratch database when the drill is done:"
Write-Host "          mongosh `"$Uri`" --eval 'db.getSiblingDB(`"$TargetDatabase`").dropDatabase()'"

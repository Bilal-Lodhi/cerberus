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

Write-Host ''
Write-Host "[restore] OK - $TargetDatabase matches the backup"
Write-Host "[restore] drop the scratch database when the drill is done:"
Write-Host "          mongosh `"$Uri`" --eval 'db.getSiblingDB(`"$TargetDatabase`").dropDatabase()'"

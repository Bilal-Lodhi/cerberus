<#
.SYNOPSIS
    Back up a Cerberus MongoDB database, and verify the backup is usable.

.DESCRIPTION
    Cerberus ships no backup tooling of its own: it writes to MongoDB, so the
    backup mechanism is MongoDB's. This script exists to make that a single
    command that also *verifies* what it produced, because an unverified backup is
    a guess.

    It dumps the database, counts the documents per collection, writes a manifest
    beside the dump, and fails if the dump is missing or empty. It never writes a
    credential into the manifest.

    Two ways to reach the database:

      - local tools   mongodump on PATH, connecting to -Uri
      - a container   -Container names a running mongo container; the dump is taken
                      inside it and copied out, so no network reachability is needed

    The container path is used automatically when mongodump is not on PATH and
    -Container is given.

.PARAMETER Uri
    MongoDB connection string, for the local-tools path.

.PARAMETER Database
    Database to back up. Defaults to `cerberus`.

.PARAMETER Out
    Destination directory. A timestamped subdirectory is created inside it.

.PARAMETER Container
    Name of a running MongoDB container holding the mongodump tools.

.EXAMPLE
    ./scripts/backup-cerberus.ps1 -Uri "mongodb://127.0.0.1:27017"

.EXAMPLE
    ./scripts/backup-cerberus.ps1 -Container cerberus-mongo
#>

[CmdletBinding(DefaultParameterSetName = 'Uri')]
param(
    [Parameter(ParameterSetName = 'Uri')]
    [string]$Uri = 'mongodb://127.0.0.1:27017',

    [Parameter(ParameterSetName = 'Container', Mandatory = $true)]
    [string]$Container,

    [string]$Database = 'cerberus',
    [string]$Out = './backups'
)

$ErrorActionPreference = 'Stop'

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$root = Join-Path $Out "cerberus-$stamp"
$dump = Join-Path $root $Database

# Create the ROOT only, never `$dump`. Both mongodump --out and `docker cp` create
# the database directory themselves, and `docker cp` into an existing directory
# nests the source inside it — producing `<root>/<db>/<db>/*.bson` and a backup that
# verifies as empty.
New-Item -ItemType Directory -Force -Path $root | Out-Null
Write-Host "[backup] database=$Database"
Write-Host "[backup] target=$root"

# ── Take the dump ────────────────────────────────────────────────────────────
$localTools = [bool](Get-Command mongodump -ErrorAction SilentlyContinue)

if ($localTools) {
    Write-Host '[backup] using local mongodump'
    & mongodump --uri="$Uri" --db="$Database" --out="$root"
    if ($LASTEXITCODE -ne 0) { throw "mongodump failed with exit code $LASTEXITCODE" }
}
elseif ($Container) {
    Write-Host "[backup] using mongodump inside container '$Container'"
    # Dump inside the container (it can reach its own MongoDB on localhost), then
    # copy the result out. Avoids depending on how the container sees the host.
    $inner = "/tmp/cerberus-backup-$stamp"
    docker exec $Container rm -rf $inner | Out-Null
    docker exec $Container mongodump --db="$Database" --out="$inner"
    if ($LASTEXITCODE -ne 0) { throw "mongodump in the container failed with exit code $LASTEXITCODE" }
    # Copy the database directory into the ROOT, so it lands at `<root>/<db>`.
    docker cp "${Container}:${inner}/${Database}" "$root"
    if ($LASTEXITCODE -ne 0) { throw "docker cp failed with exit code $LASTEXITCODE" }
    docker exec $Container rm -rf $inner | Out-Null
}
else {
    throw 'mongodump is not on PATH and no -Container was given. Install the MongoDB database tools, or pass -Container <name>.'
}

# ── Verify the dump is real ──────────────────────────────────────────────────
$bsonFiles = @(Get-ChildItem -Path $dump -Filter *.bson -File -ErrorAction SilentlyContinue)
if ($bsonFiles.Count -eq 0) {
    throw "The dump at $dump contains no .bson files. The backup is not usable."
}

$empty = @($bsonFiles | Where-Object { $_.Length -eq 0 })
if ($empty.Count -gt 0) {
    throw "These collections dumped to 0 bytes, which means the backup is incomplete: $($empty.Name -join ', ')"
}

# ── Record what it contains, so a restore can be checked against it ──────────
$counts = [ordered]@{}
$countScript = 'db.getCollectionNames().sort().forEach(n => print(n + " " + db.getCollection(n).countDocuments({})))'

if ($localTools) {
    $raw = & mongosh "$Uri/$Database" --quiet --eval $countScript
}
else {
    $raw = docker exec $Container mongosh "$Database" --quiet --eval $countScript
}

foreach ($line in @($raw)) {
    $parts = "$line".Trim() -split '\s+'
    if ($parts.Count -eq 2 -and $parts[1] -match '^\d+$') {
        $counts[$parts[0]] = [int]$parts[1]
    }
}

$manifest = [ordered]@{
    takenAtUtc   = (Get-Date).ToUniversalTime().ToString('o')
    database     = $Database
    # Deliberately no URI: it can carry a username and password, and a manifest
    # sits next to the data it describes.
    source       = if ($localTools) { 'local mongodump' } else { "container:$Container" }
    collections  = $counts
    totalDocuments = ($counts.Values | Measure-Object -Sum).Sum
    files        = @($bsonFiles | ForEach-Object { [ordered]@{ name = $_.Name; bytes = $_.Length } })
}

$manifestPath = Join-Path $root 'manifest.json'
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding utf8

Write-Host ''
Write-Host "[backup] verified $($bsonFiles.Count) collection file(s), $($manifest.totalDocuments) document(s)"
foreach ($entry in $counts.GetEnumerator()) {
    Write-Host ("  {0,-24} {1}" -f $entry.Key, $entry.Value)
}
Write-Host "[backup] manifest: $manifestPath"
Write-Host "[backup] OK"

# Backup and restore

Cerberus has **no backup mechanism of its own**. It writes to MongoDB, so the
backup mechanism is MongoDB's — and the only thing Cerberus can add is a procedure
that is actually verified, because an unverified backup is a guess.

Two scripts do that:

| Script | What it does |
| --- | --- |
| `scripts/backup-cerberus.ps1` | Dumps the database, counts every collection, writes a manifest, and **fails if the dump is empty, if a collection that holds documents dumped to 0 bytes, or if a collection that holds documents produced no dump file at all** |
| `scripts/restore-cerberus.ps1` | Restores into a target database, **refuses to clobber by accident**, and **compares the restored counts against the manifest** |

Neither script is required to run Cerberus. They exist so that "we have backups"
is a claim with evidence behind it.

## What to back up

The whole `cerberus` database. Every collection is evidence:

| Collection | Holds |
| --- | --- |
| `monitored_sessions` | Session documents and aggregate counters |
| `micro_events` | The telemetry record, one document per event |
| `risk_assessments` | Every risk payload, including `codeSnapshot`, `pasteSnippets`, `behavioralContext` |
| `reference_documents` | The operator-managed similarity corpus |
| `threat_scenarios` | Authored scenario matrices |
| `schema_migrations` | The migration ledger |

`schema_migrations` is small and easy to overlook. Restoring without it makes the
migration runner think the database is fresh, so it will re-apply migrations that
have already run. Include it.

## What is **not** backed up, and why

| Thing | Why not |
| --- | --- |
| **Configuration and secrets** | `.env` holds the API key, the MCP token and the OpenAI key. A backup that contains credentials is a liability, and the manifest deliberately records the source as `local mongodump` or `container:<name>` rather than the connection string, which can carry a password. Back up your secret store separately. |
| **The Flutter console build** | Built from `apps/console` on demand. Reproducible from the repository. |
| **In-memory session state** | Deliberately not authoritative. See [development/session-state-model.md](../development/session-state-model.md). |

## Taking a backup

```powershell
# Against a MongoDB reachable at the default URI (needs mongodump on PATH)
./scripts/backup-cerberus.ps1 -Uri "mongodb://127.0.0.1:27017"

# Against a containerised MongoDB that does not expose the tools to the host
./scripts/backup-cerberus.ps1 -Container cerberus-mongo
```

Both produce `./backups/cerberus-<UTC timestamp>/`:

```
cerberus-20260925-175736/
  manifest.json
  cerberus/
    micro_events.bson
    monitored_sessions.bson
    ...
```

The manifest is what makes the backup verifiable:

```json
{
  "takenAtUtc": "2026-09-25T17:57:36Z",
  "database": "cerberus",
  "source": "container:cerberus-tools",
  "collections": {
    "micro_events": 3,
    "monitored_sessions": 2,
    "reference_documents": 1,
    "risk_assessments": 1,
    "threat_scenarios": 1
  },
  "totalDocuments": 8,
  "files": [ { "name": "micro_events.bson", "bytes": 177 }, ... ]
}
```

## Restoring

**Restore into a scratch database first.** That is the whole point of the drill, and
the script defaults to it: with no `-TargetDatabase`, it restores into
`<source>_restore` rather than over the original.

```powershell
./scripts/restore-cerberus.ps1 -Backup ./backups/cerberus-20260925-175736 -Container cerberus-mongo
```

```
[restore] no -TargetDatabase given; using 'cerberus_restore'
[restore] verifying against the manifest
  ok   micro_events             expected 3        got 3
  ok   monitored_sessions       expected 2        got 2
  ok   reference_documents      expected 1        got 1
  ok   risk_assessments         expected 1        got 1
  ok   threat_scenarios         expected 1        got 1
[restore] OK - cerberus_restore matches the backup
```

Then drop the scratch database.

### Restoring for real

To replace live data, restore over the source database — which the script refuses
unless you say so:

```powershell
./scripts/restore-cerberus.ps1 -Backup <dir> -Container cerberus-mongo `
    -TargetDatabase cerberus -AllowSameDatabase -Drop
```

Before doing that, **stop the API and the MCP adapter**. A running instance holds
session state in memory that a restore will not update, so it will keep writing
counters derived from state the restore just replaced. After restoring, start the
MCP adapter first (it owns migrations and indexes), then the API.

### Three things the script refuses

| Situation | Message |
| --- | --- |
| Restoring over the source database without `-AllowSameDatabase` | `Refusing to restore 'cerberus' over itself.` |
| Restoring into a non-empty target without `-Drop` | `Target database 'cerberus_drill' already holds 8 document(s).` |
| A backup directory with no manifest | `No manifest.json in <dir>.` |

Each of those is a way to lose data with one typo, so each is a stop rather than a
prompt.

### The uniqueness guarantees, which a count cannot see

A count comparison is blind to indexes, and `mongorestore` exits 0 whether or not it
restored them. A dump taken with `--noIndexRestore` — or restored that way — comes back
with every document and none of the constraints, so two rows sharing a
`riskAssessmentId` would be accepted by a database that is supposed to forbid it, and
nothing would say so until the next write that should have been rejected.

So the restore verifies the critical indexes too:

```
[restore] verifying the critical indexes
  unique indexes found: micro_events:sessionId+eventId, monitored_sessions:sessionId, …
  ok   monitored_sessions:sessionId
  ok   micro_events:sessionId+eventId
  ok   risk_assessments:riskAssessmentId
  ok   reference_documents:referenceId
  ok   threat_scenarios:metadata.matrixId
  ok   schema_migrations:migrationId

[restore] OK - cerberus_restored matches the backup, with its uniqueness guarantees
```

The list lives in `scripts/release/critical-indexes.json`, and
`apps/api/test/release/critical-indexes.test.ts` asserts it against a real store in
**both** directions: every entry must be an index the product creates, and the product
must not create a unique index the list omits. Without the second direction a new
uniqueness guarantee could be added and never verified after a restore.

## Why the verification step is the important one

`mongorestore` **exits 0 when it restores nothing.** Point it at the wrong
directory level and it prints `don't know what to do with file ..., skipping` for
every collection, reports `0 document(s) restored successfully`, and succeeds. An
exit-code check would pass and the deployment would come back empty.

The script therefore compares the restored document counts against the manifest and
fails if any differ. Verified by tampering with a manifest to claim 99 documents in
a collection that holds 3:

```
FAIL micro_events             expected 99       got 3
ok   monitored_sessions       expected 2        got 2
...
Restore verification failed for: micro_events. The restore is NOT usable.
exit code: 1
```

The **drill** below does exactly that tampering, as one of its checks, so the property is
verified on demand rather than only when someone happens to try it.

That is the check that makes this procedure worth having.

## What this does not give you

Stated plainly, because the gaps are what matter during an incident:

- **No scheduled backups.** Nothing runs on a timer. If nobody runs the script,
  there is no backup.
- **No point-in-time recovery.** A `mongodump` is a snapshot at one instant. There
  is no oplog capture, so the recovery point objective is "whenever the last backup
  was taken", and everything written since is gone.
- **No off-host storage.** The script writes where you tell it to. A backup on the
  same disk as the database is not a backup.
- **No encryption.** The dump is plain BSON. It contains telemetry about named
  employees, so treat it with the same care as the database itself — and note that
  it will not carry MongoDB's at-rest encryption settings.
- **No automatic retention.** Old backups accumulate until you delete them.

A real deployment needs scheduled, off-host, access-controlled backups. This
procedure is the part Cerberus can honestly own: taking a correct one, and proving
it can be restored.

## Restoring an older backup and migrations

Restoring a backup taken before a migration re-applies that migration on the next
connect, because the ledger comes back with the dump. That is the intended
behaviour, and it is why `schema_migrations` must be in the backup.

If you restore a backup taken *after* a migration into a build that predates it, the
runner refuses with `The database has migrations this build does not know about` —
the code would be older than the data. See
[upgrade.md](upgrade.md#when-a-migration-refuses-to-run).

## The drill, end to end

Run this before you need it. It is the only way to know the procedure works in your
environment.

**By hand**, against your own deployment:

```powershell
# 1. Back up
./scripts/backup-cerberus.ps1 -Container cerberus-mongo

# 2. Restore into a scratch database (the default target)
./scripts/restore-cerberus.ps1 -Backup ./backups/<timestamp> -Container cerberus-mongo

# 3. Confirm the data is readable, not merely counted
docker exec cerberus-mongo mongosh cerberus_restore --quiet --eval `
  'printjson(db.risk_assessments.findOne({}))'

# 4. Drop the scratch database
docker exec cerberus-mongo mongosh cerberus_restore --quiet --eval 'db.dropDatabase()'
```

Step 3 matters: counts can match while the content is wrong, and reading one
document back is what rules that out.

**As one command**, with no dependence on your own deployment:

```bash
npm run verify:backup
```

`scripts/release/backup-restore-drill.mjs` creates its own disposable `mongo:7` container,
seeds a documented fixture — **one empty collection**, five non-empty ones, the critical
indexes, and a migration ledger — and then walks the whole procedure, judging every step on
the scripts' own output rather than on an exit code:

| Check | Why it is judged on the output |
| --- | --- |
| The backup succeeds and writes a manifest | A missing manifest is only visible in what it printed |
| The manifest counts every collection, including the empty one | The 0-byte case above |
| The manifest carries no connection string | A manifest sits next to the data it describes |
| The restore succeeds and verifies counts **and** indexes | `mongorestore` exits 0 when it restores nothing |
| The restored database holds the documents | Counts can match while the content is wrong |
| Restoring over the source is refused | Judged on the message, not just a non-zero exit |
| Restoring over a non-empty target without `-Drop` is refused | Same |
| A manifest whose counts disagree with the dump is refused | The verification is what makes a restore *verifiable* rather than merely *successful* |

It is also a step in `npm run verify:release`. It removes its container whatever happened;
`--keep` leaves it for inspection.

## Why a 0-byte collection file is not a failure

`mongodump` writes a **0-byte** `.bson` file for a collection that exists and holds zero
documents. That is a complete, usable dump — but the script used to treat *any* 0-byte file
as an incomplete backup, so `npm run backup` **failed on a perfectly healthy deployment**
whose `risk_assessments` or `threat_scenarios` were still empty. That is every fresh
deployment, until an analysis runs or a scenario is authored.

The check is now **count-aware**, and it is stricter rather than looser:

| Case | Before | Now |
| --- | --- | --- |
| A collection holds 0 documents and dumps to 0 bytes | **failed** (false positive) | ok |
| A collection holds documents and dumps to 0 bytes | failed | **failed** |
| A collection holds documents and produced no dump file at all | passed | **failed** |

The document counts are read *before* the dump is judged, because file size alone cannot
tell a legitimately empty collection from a failed one.

**A second defect was found by running the drill.** The count script embedded a `"`, which
Windows PowerShell 5.1 mangles when passing it to `docker exec`: mongosh received a
truncated script, printed a `SyntaxError`, and the manifest recorded **0 documents for every
collection** while the backup itself was fine. That is worse than no manifest at all — the
restore compares the restored counts against the manifest, so an empty manifest makes that
comparison **vacuous**, and a restore that brought back nothing would have been reported as
verified.

The count script no longer contains a quote (mongosh's `print` joins its arguments with a
space, so none is needed), and the backup now **fails loudly if the count read produces
nothing**, so no future variant of the same problem can produce a vacuous manifest.
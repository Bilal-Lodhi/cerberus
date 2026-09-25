# Upgrading Cerberus

Cerberus ships schema and data migrations. Upgrading is: back up, look at the
plan, apply, restart. This document covers each step and what to do when a
migration refuses to run.

## Before you start

Take a backup. Migrations here are written to be safe — idempotent, and failing
before they mutate — but "safe" is not "reversible", and there are no
down-migrations by design. A backup is the only way back.

```bash
mongodump --uri="$MONGODB_URI" --db=cerberus --out=./cerberus-backup-$(date +%F)
```

Verify the dump is not empty before you trust it:

```bash
ls -la ./cerberus-backup-*/cerberus/    # expect one .bson per collection
```

## 1. Look at the plan

```bash
npm run migrate:dry-run
```

This connects, reads the migration ledger, prints what is pending, and **changes
nothing** — it does not even read the telemetry collections. Migrations that
rewrite existing documents are marked:

```
[migrate] database: cerberus (dry run)
  pending  0001-dedupe-micro-event-identity [rewrites data]
           Remove duplicate micro_events documents that share (sessionId, eventId), so the unique identity index can be created.
[migrate] dry run: nothing was changed
```

If nothing is pending, the database is already current and you can go straight to
restarting the services.

## 2. Apply

```bash
npm run migrate
```

You do not strictly have to run this: **the API and the MCP adapter apply pending
migrations when they connect**, so restarting is usually enough. Run it explicitly
when you want the plan applied and reported separately from a service start, or
when a migration previously refused.

What you will see on a database that needs the dedupe:

```
[migrations] applying 0001-dedupe-micro-event-identity
[migrations]   1 duplicated event identity/identities found
[migrations]   removed 1 duplicate document(s)
[migrations] applied 0001-dedupe-micro-event-identity
```

## 3. Restart

Restart the MCP adapter and the API, in that order — the adapter owns the
persistence layer, and the API reports a degraded state if it cannot reach it.
Migrations are applied by whichever connects first; the second sees them recorded
and does nothing.

## 4. Confirm

```bash
npm run migrate:dry-run     # expect every migration "applied"
curl -s http://localhost:8080/health
```

## When a migration refuses to run

One failure mode is expected, and it is deliberate.

### `... copies that are NOT identical, so they are not duplicates`

```
[migrate] FAILED: 1 (sessionId, eventId) pair(s) have copies that are NOT
identical, so they are not duplicates and removing either version would lose
data. Resolve them before re-running this migration. Pairs: ses-1/evt-3.
Nothing has been deleted.
```

Two documents claim the same `(sessionId, eventId)` but disagree about what the
event *was*. They are not duplicates, so removing either would destroy whichever
version was meant. The migration cannot decide that, so it does not: it names the
pairs, writes nothing, and leaves the migration unapplied.

This is the intended behaviour, not a bug. To resolve it, inspect each named pair:

```bash
mongosh "$MONGODB_URI" --eval '
  db.micro_events.find({ sessionId: "ses-1", eventId: "evt-3" }).forEach(d => printjson(d))
'
```

Then decide, per pair, which document is the event — and delete the other
explicitly. The migration will never do this for you. Once the pairs are resolved:

```bash
npm run migrate
```

### `The database has migrations this build does not know about`

```
[migrate] FAILED: The database has migrations this build does not know about:
9999-from-the-future. The running code is older than the data.
```

The code is older than the database. That is the one direction where proceeding
would be a guess, so it refuses. Deploy the newer build, or restore the backup you
took before those migrations were applied.

## What the migration ledger holds

`schema_migrations` records what this database has been through:

```javascript
{ migrationId: "0001-dedupe-micro-event-identity",
  description: "...",
  appliedAt: ISODate("..."),
  detail: "1 duplicated event identity/identities found; removed 1 duplicate document(s)" }
```

`detail` is where a migration that removed documents records how many. That is the
only durable account of what it did, so read it before assuming a cleanup was a
no-op.

## Downgrading

There is no supported downgrade. The migration type has no `down` member, so a
reverse migration cannot be written without changing the framework — and for a
data migration a `down` would be a fiction, because the removed documents are
gone.

Rolling back means restoring a backup taken before the upgrade. Take one.

## Version compatibility

| Component | Reads `schema_migrations` | Applies migrations |
| --- | --- | --- |
| `@cerberus/mcp-mongodb` | yes | yes, on connect |
| `@cerberus/api` | no — it has no database connection | no; the adapter does it |
| `npm run migrate` | yes | yes, on demand |

The API never touches MongoDB directly, so it cannot migrate anything. That is why
the adapter starts first.

# Upgrading Cerberus

Cerberus ships schema and data migrations. Upgrading is: back up, look at the
plan, apply, restart. This document covers each step and what to do when a
migration refuses to run.

## Running migrations from more than one process

The migration ledger carries a **unique index on `migrationId`**, created by the runner
before its first write. Two processes starting at the same time both read a pending plan,
and without the index both would insert a row for the same migration — so the ledger would
stop being a faithful account of what the database has been through, which is its whole
purpose. A duplicate-key error on the insert is treated as "another runner recorded this"
rather than as a failure, and one lost race does not abandon the run: the later migrations
still apply.

Two runners may still **execute** the same migration concurrently, and that is safe by
design: every migration is idempotent and fails before mutating, so the second execution is
a no-op rather than a second rewrite. There is no claim protocol and no lease, because the
documented deployment is one API and one adapter against one database.

If you are running a second instance concurrently, stop one of them before upgrading. That
is simpler than reasoning about interleaved rewrites. The ledger's `detail` field records
what each migration actually did, so you can see afterwards whether a run was a no-op.

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
nothing**. It does not touch the telemetry or assessment collections; a migration that
reports what it would change reads only the collection it would change, and writes
nothing. Migrations that rewrite existing documents are marked:

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

## Migration 0005 — the live-list normal form

`0005-normalise-session-list-fields` is the first migration here that exists to make a **read**
bounded rather than to repair a defect. The live session list used to read every session document
ever created and discard the finished ones in memory; it is now answered by a filtered query and
two indexes, and those only work if the stored documents are in a normal form.

It writes two fields, and nothing else:

| Field | What it becomes |
| --- | --- |
| `status` | the value the API was already computing from it: `active`, `locked` or `terminated`. A missing, `null`, unknown, case-variant or wrong-typed status becomes `active`. |
| `liveListUpdatedAt` | the instant the list's liveness rule compares against, derived from `updatedAt`, then `deployedAt`, then `createdAt`. |

**`updatedAt` and every other timestamp are left exactly as they are**, and no document is deleted.
That is deliberate: the read surfaces display those fields, and rewriting them would change the
answer for the malformed documents this migration exists to preserve. The reasoning, with the
counterexample, is in
[live-list-equivalence-model.md](../development/live-list-equivalence-model.md) §9.3.

A document with **no verifiable instant at all** — `updatedAt`, `deployedAt` and `createdAt` all
absent, or the first of them present and unreadable — keeps a sentinel that means "conservatively
never expires", which is what the list already did with it. The migration never reads the clock: a
row dated to the moment the migration ran would start expiring one monitoring window later, which
is a different answer.

### The dry run tells you what it would change

`npm run migrate:dry-run` asks a pending migration what it would do, and `0005` answers from the
same code path it applies with:

```
[migrate]   pending  0005-normalise-session-list-fields [rewrites data]
  scanned 5021 document(s): status 40 missing and 12 unrecognised normalised, 4969 already normal
  liveListUpdatedAt: 5010 from updatedAt, 5 from deployedAt, 2 from createdAt, 4 unverifiable, 0 already normal
  4969 document(s) unchanged, 52 rewritten (dry run: nothing written)
```

Counts only — no session id, status or content is printed or recorded in the ledger. A re-run is a
no-op at the storage layer: it plans no writes and modifies none.

### Rolling upgrade ordering

| Question | Answer |
| --- | --- |
| Can the migration run before the new build? | Yes, and that is the ordinary path: `connect()` applies the migrations **before** it creates indexes and before any route serves. |
| Can the old build tolerate normalised rows? | Yes. The status it writes is the value the old build already computed, and every timestamp it reads is untouched. |
| Can the new build start before the migration finishes? | It cannot start *during* one: `connect()` awaits the migration pass, and a failure stops the process rather than serving. If a database is left with a pending migration and a process is started with `migrate: false`, the list reads the collection exactly as the previous build did and **warns once** — correct, and not yet faster. |
| Can two replicas race the migration safely? | The runner is idempotent and the ledger's unique index makes double-recording impossible, so the second execution is a no-op. Stop one instance anyway; see the top of this document. |
| What about a document an **older** process writes after the migration? | It is still visible. Every write path sets a `Date` `updatedAt` and a durable status, which is the branch of the predicate that needs no derived field. |

### Editing a session document by hand

The bounded query reads `status` and `liveListUpdatedAt`. A direct database edit that changes
`status` **must** keep the document in the normal form — a status outside `active | locked |
terminated` is not matched by the predicate, and a document with no `liveListUpdatedAt` is only
visible while its `updatedAt` is a `Date`. The API never produces such a document; a hand edit can.
If in doubt, write the document through the API instead.

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

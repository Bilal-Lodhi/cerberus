# Migrating from v0.1.0 to v0.2.0

`v0.2.0` is a durability release, and most of it is additive. **Two changes can
require action**, and both are described here with what to do about them.

There are three documents with similar names. This one is the version-to-version
guide:

| Document | What it is |
| --- | --- |
| **This document** | What changed between `v0.1.0` and `v0.2.0`, and what to do about it |
| [operations/upgrade.md](operations/upgrade.md) | The general upgrade procedure: back up, read the plan, apply, confirm |
| [migration.md](migration.md) | The migration framework, and separately the historical collection/tool rename |

## Before you start

Take a backup and verify it. `v0.2.0` introduces the first migration, and a migration
is the one operation where a backup is the only way back — there are no
down-migrations by design.

```bash
npm run backup
ls -la ./backups/<timestamp>/cerberus/    # expect one .bson per collection
```

## Change 1 — the unique index needs a migration

**This is the one that will stop a `v0.1.0` deployment from starting.**

`v0.2.0` adds a unique index on `micro_events.(sessionId, eventId)` so a retried batch
is stored once, including after a restart. `v0.1.0`'s ingestion path wrote every event
in a retried batch, so a database that ran it may hold duplicates — and a unique index
**cannot be created over duplicates**.

### What happens

The MCP adapter applies migrations **before** creating indexes, so on first start it
runs `0001-dedupe-micro-event-identity`:

- **A clean database:** no-op. The migration records itself and the index is created.
- **A database with exact duplicates:** the copies are removed, the count is recorded
  in the `schema_migrations` ledger, and the index is created.

  ```
  [migrations] applying 0001-dedupe-micro-event-identity
  [migrations]   1 duplicated event identity/identities found
  [migrations]   removed 1 duplicate document(s)
  [MCP-HTTP] listening on 127.0.0.1:3001 ...
  ```

- **A database where a pair's copies disagree:** the migration **refuses**, having
  written nothing, and names the pairs:

  ```
  [migrate] FAILED: 1 (sessionId, eventId) pair(s) have copies that are NOT
  identical, so they are not duplicates and removing either version would lose
  data. Pairs: ses-1/evt-3. Nothing has been deleted.
  ```

  Two documents claim the same event identity but disagree about what the event *was*.
  They are not duplicates, and the migration will not guess which version was meant.

### What to do

Nothing, for the first two cases. For the third, inspect each named pair and decide:

```bash
mongosh "$MONGODB_URI" --eval '
  db.micro_events.find({ sessionId: "ses-1", eventId: "evt-3" }).forEach(d => printjson(d))
'
```

Delete the one that is not the event, explicitly. Then:

```bash
npm run migrate
```

**Check the plan before you upgrade** if you want to know which case you are in:

```bash
npm run migrate:dry-run
```

It prints what is pending, marks migrations that rewrite data, and changes nothing —
it does not even read the telemetry collections.

## Change 2 — an event without `eventId` is rejected

`MicroEvent.eventId` was already a required field of the declared contract; the route
simply did not enforce it. It is now the durable idempotency key, so an event that
cannot be identified cannot be deduplicated, and the request is refused:

```json
{
  "success": false,
  "error": "Each event must contain a non-empty 'eventId'",
  "code": "MISSING_EVENT_ID"
}
```

**What to do:** if any client sends events without an `eventId`, add one. It must be
stable per event — the same value on a retry is what makes the retry safe. The bundled
console already sends one.

Do **not** generate a fresh `eventId` per attempt: that defeats the deduplication and
is the one way to make this change harmful.

## Change 3 — new response fields (additive)

Nothing to do; listed so the change is not a surprise.

| Endpoint | Added |
| --- | --- |
| `POST /api/v1/guardian/ingest` | `acceptedCount`, `duplicateCount` — `processedCount` keeps its meaning (the batch size) |
| `GET /api/v1/guardian/sessions`, `GET /api/v1/sessions` | `fullscreenExitCount` |

## Change 4 — `GET /ready` exists, and `/health` changed meaning

`/health` no longer claims to know whether the service can *serve* — it is liveness
only, and always answers `200` while the process is responsive. Readiness moved to
`GET /ready`, which answers `200` or `503`.

**What to do:** point load balancers and orchestrator readiness probes at `/ready`.
Leave restart probes on `/health`. Swapping them is the specific mistake the split
exists to prevent — see [operations/health-probes.md](operations/health-probes.md).

The Dockerfile and `docker-compose.yml` already use `/ready`.

## Change 5 — rate limiting is on by default

In-process token buckets per route category. If you run a load test or a bulk import
and start seeing `429 RATE_LIMITED`:

```bash
CERBERUS_RATE_LIMIT_ENABLED=false     # or raise the AI ceiling:
CERBERUS_AI_REQUESTS_PER_MINUTE=60
```

Note that an unrecognised value for `CERBERUS_RATE_LIMIT_ENABLED` is a **startup
error**, not a silent `false` — a typo must not turn a control off.

Per-caller limiting is a reverse-proxy concern; the API has one shared key and
therefore no caller to key on.

## Change 6 — session review output is now correct

A `v0.1.0` defect: the review reported the **oldest** risk assessment as
`finalRiskScore`, and derived the `flagged` status from it, because the route assumed
an ordering the store does not provide. `terminalContent` was also empty after a
restart.

**What to do:** nothing, but if you have been reading `finalRiskScore` from a
`v0.1.0` deployment, the value was wrong and any decision made from it should be
re-checked. The fix is in `v0.2.0`.

## What did not change

- No route was removed or renamed.
- No MCP tool was removed. `update_session_terminal_content` remains available; the
  API still does not call it, and the review path recovers the workspace from the
  newest assessment's `codeSnapshot`.
- No collection was renamed. The historical-name mapping is unchanged — see
  [migration.md](migration.md).
- No persisted field changed type. `monitored_sessions` gained a counter it always
  should have written (`fullscreenExitCount`), and `micro_events` gained an index.
- The configuration surface gained variables; none was removed.

## Verifying the upgrade

```bash
npm run migrate:dry-run                  # expect every migration "applied"
curl -s http://localhost:8080/health     # 200
curl -s http://localhost:8080/ready      # 200
```

Then confirm the two properties this release exists for:

1. **Counters survive a restart.** Note a session's `eventCount`, restart the API,
   ingest one event, and confirm the count is the old value plus one — not one.
2. **A retry is not double-counted.** Re-send a batch you already sent and confirm
   the response reports `acceptedCount: 0` with `duplicateCount` equal to the batch
   size, and the counters unchanged.

## Rolling back

There is no supported downgrade. The migration framework has no `down` member,
because reversing a data migration would be a fiction — the removed documents are
gone.

Rolling back means restoring the backup you took before upgrading. That is why step
one is step one.

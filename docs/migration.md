# Migration

Two different things are called "migration" here, and they are unrelated:

1. **Schema and data migrations** — Cerberus ships a migration framework that
   brings an existing database up to date. See
   [Schema and data migrations](#schema-and-data-migrations) below, and
   [operations/upgrade.md](operations/upgrade.md) for the procedure.
2. **The historical rename** — this repository is a fresh extraction that uses
   Cerberus-native names throughout. There is no compatibility shim for the old
   names. That is the rest of this document.

## Schema and data migrations

The framework is `packages/mcp-mongodb/src/migrations.ts`. It exists because the
first durable-identity change was not a pure addition: creating a unique index on
`(sessionId, eventId)` **fails** on a database that already holds duplicates, and
those duplicates are exactly what the pre-fix ingestion path produced. Without a
migration, that deployment could not start.

What it guarantees:

| Property | How |
| --- | --- |
| **Ordered, append-only** | `MIGRATIONS` is a list; order comes from position, so there is no numeric prefix to get wrong. |
| **Idempotent** | Applying twice is a no-op, and the ledger is not what makes it so — a crash between the work and the ledger write must be recoverable. |
| **Fails before mutating** | A migration that cannot complete safely throws *before* writing, so a failure leaves the database as it was. |
| **Never silently destructive** | A migration that removes documents records how many, and refuses rather than guessing when documents disagree. |
| **Never applied twice** | `schema_migrations` records each applied id; an id the build does not know about is refused, because the code would be older than the data. |
| **Inspectable first** | `npm run migrate:dry-run` prints the plan, marking migrations that rewrite data, and changes nothing. |

There are **no down-migrations**. Reversing a data migration is usually impossible
to do honestly — the removed rows are gone — so the registry's type has no `down`
member. Rolling back means restoring a backup.

Migrations run **before** index creation, and the order is load-bearing: the unique
identity index cannot be built over duplicates, so creating indexes first would
turn a repairable database into one that will not start.

### Current migrations

| Id | Rewrites data | What it does |
| --- | --- | --- |
| `0001-dedupe-micro-event-identity` | yes | Removes `micro_events` documents that share `(sessionId, eventId)` **and are otherwise identical**, so the unique identity index can be created. Refuses, having written nothing, if any pair's copies disagree. |
| `0002-dedupe-risk-assessment-identity` | yes | Removes `risk_assessments` documents that share a `riskAssessmentId` **and are otherwise identical** apart from `_generatedAt`, so the unique identity index can be created. Refuses, having written nothing, if any pair's copies disagree. |
| `0003-rename-fullscreen-exit-to-focus-loss` | yes | Renames `monitored_sessions.fullscreenExitCount` to `focusLossCount`. The counter was incremented by **both** `WINDOW_BLUR` and `FULLSCREEN_EXIT`, so its name described one of the two events that produced it; browser telemetry cannot distinguish them, so it has always measured focus loss. A document holding both fields keeps the **larger**, so a mixed database cannot lose the higher total. **No score moves** — the penalty was gated on the counter being positive, never on which event produced it. |
The volatile field differs by collection — `_ingestedAt` for an event, `_generatedAt`
for an assessment — so `classifyDuplicateGroups` takes the ignored fields as a
parameter. Passing the wrong one turns a repairable duplicate into a refusal.

### The upgrade gate

`npm run test:migrations` proves the upgrade path end to end against a real MongoDB: it
seeds a database in a **published release's** shape, runs the documented sequence — dry
run, migrate, validate, re-run — and asserts the result. The historical shape of `v0.2.0`
and `v0.3.0` is described once in `apps/api/test/support/release-fixture.ts`, derived from
the published release notes rather than from the code, so it cannot drift from the state it
claims to represent.

It is also a step in `npm run verify:release`; see
[release/verification-harness.md](release/verification-harness.md#the-upgrade-gate).

### Collections

| Collection | Holds |
| --- | --- |
| `schema_migrations` | The migration ledger: which migrations this database has had applied, when, and what each reported. |

The ledger carries a **unique index on `migrationId`**, created by the runner before
its first write. Two processes starting together both read a pending plan, and without
the index both would insert a row for the same migration — so the ledger would stop
being a faithful account of what the database has been through. A duplicate-key error
on the insert is treated as "another runner recorded this" rather than as a failure.
See [operations/upgrade.md](operations/upgrade.md#running-migrations-from-more-than-one-process).
| `reference_corpus_meta` | One counter document holding the reference-corpus size, so the corpus ceiling can be enforced with an atomic conditional `$inc` rather than a count-then-insert that races. Not domain data. |

---

# Migration from the historical schema

This repository is a fresh extraction of the Cerberus codebase. It uses
Cerberus-native names throughout and **does not support the historical names as
aliases, fallbacks or compatibility shims.**

Concretely:

- `packages/mcp-mongodb/src/mongo-client.ts` resolves collection names only from
  `COLLECTION_NAMES` in `packages/mcp-mongodb/src/tool-names.ts`. There is no
  runtime lookup of the old collection names.
- The MCP tool registry in `packages/mcp-mongodb/src/tools.ts` is typed as
  `Record<McpToolName, ToolHandler>`, so an old tool name is not merely
  undocumented — it fails the TypeScript build if added without a handler, and
  at runtime the HTTP adapter returns `404 Unknown tool: <name>`.
- There is no dual-write path, no read-through of legacy documents and no
  feature flag that restores the old behaviour.

If you have data or client code that uses the historical names, you must rename
it before Cerberus 0.1.0 can read it. See
[If you have existing data](#4-if-you-have-existing-data).

## 1. MongoDB collections

| Historical | Current | Notes |
| --- | --- | --- |
| `test_suites` | `threat_scenarios` | Authored scenario matrices. |
| `assessment_sessions` | `monitored_sessions` | Session documents and aggregate counters. |
| `micro_events` | `micro_events` | **Unchanged.** The name was already domain-neutral. |
| `suspicion_reports` | `risk_assessments` | Risk assessment payloads. |

Database name:

| Historical | Current |
| --- | --- |
| `gorilla_agents` | `cerberus` |

The default database name is the constant `DEFAULT_DATABASE_NAME` in
`packages/mcp-mongodb/src/tool-names.ts`, overridable with
`MONGODB_DATABASE`.

## 2. MCP tools

| Historical | Current | Notes |
| --- | --- | --- |
| `store_test_suite` | `store_threat_scenario` | |
| `get_test_suite` | `get_threat_scenario` | Argument `matrixId` unchanged. |
| `create_session` | `create_session` | **Unchanged.** |
| `update_session_code` | `update_session_terminal_content` | Argument `submittedCode` → `terminalContent`. |
| `delete_session` | `delete_session` | **Unchanged.** |
| `append_micro_event` | `append_micro_event` | **Unchanged.** |
| `ingest_micro_events` | `ingest_micro_events` | **Unchanged.** |
| `store_suspicion_report` | `store_risk_assessment` | Argument `report` unchanged. |
| `update_session_counts` | `update_session_counts` | **Unchanged.** |
| `set_session_status` | `set_session_status` | **Unchanged.** |
| `get_session_review` | `get_session_review` | **Unchanged.** |
| `get_candidate_report` | `get_employee_risk_history` | Argument `candidateId` → `employeeId`. |
| `list_sessions` | `list_sessions` | **Unchanged.** |
| `health_check` | `health_check` | **Unchanged.** |

The authoritative current list lives in `MCP_TOOL_NAMES`
(`packages/mcp-mongodb/src/tool-names.ts`), with an API-side copy in
`apps/api/src/services/mcp-tool-names.ts`.

## 3. Field renames

| Historical | Current |
| --- | --- |
| `candidateId` | `employeeId` |
| `assessmentId` | `auditId` |
| `problemId` | `vectorId` |
| `submittedCode` | `terminalContent` |
| `suspicionPayload` / `suspicionReports` | `riskPayload` / `riskAssessments` |
| `plagiarismReport` | `exfiltrationReport` |
| `difficultyMix` | `severityMix` |
| `problemCount` | `vectorCount` |
| `GeneratedTestSuite` / `GeneratedComplianceMatrix` | `ThreatScenarioMatrix` |
| `suiteId` | `matrixId` |

Two of these appear in the current contracts:

- `RiskAssessmentPayload` in `apps/api/src/types.ts` carries `employeeId` and
  `auditId`.
- `ThreatScenarioMetadata` carries `matrixId`, and
  `ThreatScenarioRequest` carries `vectorCount` and `severityMix`.

`exfiltrationReport` is the field name on `RiskAssessmentPayload`
(`apps/api/src/types.ts`), produced by the risk-analysis parser in
`apps/api/src/ai/parsers.ts`.

## 4. If you have existing data

No migration tooling ships in this release. There is no `cerberus migrate`
command, no schema-version field and no upgrade path in the codebase.

A one-off rename script would be needed, and it has to touch three things:

1. **Collections.** Rename the collections in the target database, for example
   with the MongoDB shell:

   ```javascript
   // Run against the historical database.
   use gorilla_agents

   db.test_suites.renameCollection("threat_scenarios")
   db.assessment_sessions.renameCollection("monitored_sessions")
   db.suspicion_reports.renameCollection("risk_assessments")
   // micro_events keeps its name.
   ```

   Renaming a collection does not rename the database. If you also want the
   database called `cerberus`, either point `MONGODB_DATABASE` at the existing
   name or copy the collections across.

2. **Document fields.** Rewrite the renamed fields inside every document in
   every collection, using the table in section 3. This is the part that needs
   care: the mapping is not mechanical. `assessmentId` → `auditId` and
   `suiteId` → `matrixId` change meaning as well as spelling, and
   `suspicionReports` is a field on a session document while `riskAssessments`
   is a collection name. Validate a sample of rewritten documents against
   `apps/api/src/types.ts` before trusting the result.

3. **Client code.** Any client that calls MCP tools or the API by the old names
   must be updated. The MCP adapter rejects unknown tool names with HTTP 404 and
   a list of the tools it does expose, which makes this easy to find by
   exercising the client.

Because collection renames are not atomic across collections and because
Cerberus creates its own indexes on connect (`MongoStore.ensureIndexes()` in
`packages/mcp-mongodb/src/mongo-client.ts`), the safest sequence is: stop both
services, take a backup, run the rename and field rewrite, then start the MCP
adapter and confirm `GET /health` reports a healthy connection before starting
the API.

### Indexes after a rename

`ensureIndexes()` runs on every `connect()` and is idempotent for identical
specifications, so the current indexes are created for you on first start after
the rename. It does not drop indexes that the historical schema created. The
full current index inventory is in
[architecture.md](architecture.md#index-inventory).

## 5. What is not migrated

- Historical session status values are not translated. The current MCP
  `set_session_status` tool accepts only `active`, `locked` and `terminated`
  (`SESSION_STATUSES` in `packages/mcp-mongodb/src/tool-names.ts`) and rejects
  anything else with HTTP 400. Current Cerberus writes only those three values:
  sessions are created as `active`. A historical `in_progress` value is not
  written by this codebase and is normalised to `active` when a document
  carrying it is read back, so reconcile such values in your data deliberately
  rather than expecting them to be preserved.
- Historical session ids, employee ids and matrix ids are carried over
  unchanged, because they are plain strings. Their meaning may have shifted with
  the field renames above.
- No historical API route aliases exist. The current route set is documented in
  the README and in `apps/api/src/index.ts`.

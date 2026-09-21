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
[If you have existing data](#if-you-have-existing-data).

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
  anything else with HTTP 400. Note that the API itself also writes
  `in_progress` on session creation; reconcile any status vocabulary in your
  data against what the current code actually reads.
- Historical session ids, employee ids and matrix ids are carried over
  unchanged, because they are plain strings. Their meaning may have shifted with
  the field renames above.
- No historical API route aliases exist. The current route set is documented in
  the README and in `apps/api/src/index.ts`.

/**
 * Canonical MCP tool names for the Cerberus MongoDB persistence layer.
 *
 * This module is intentionally dependency-free so both the MCP server and
 * the API-side client (and the tests that assert they agree) can import it
 * without pulling in a MongoDB connection.
 *
 * Renaming history is recorded in docs/migration.md. The API-side client
 * declares the same names in apps/api/src/services/mcp-client.ts, and
 * apps/api/test/mcp-tool-mapping.test.ts asserts the two sets are identical.
 */

export const MCP_TOOL_NAMES = {
  STORE_THREAT_SCENARIO: "store_threat_scenario",
  GET_THREAT_SCENARIO: "get_threat_scenario",
  CREATE_SESSION: "create_session",
  UPDATE_SESSION_TERMINAL_CONTENT: "update_session_terminal_content",
  DELETE_SESSION: "delete_session",
  APPEND_MICRO_EVENT: "append_micro_event",
  INGEST_MICRO_EVENTS: "ingest_micro_events",
  STORE_RISK_ASSESSMENT: "store_risk_assessment",
  UPDATE_SESSION_COUNTS: "update_session_counts",
  SET_SESSION_STATUS: "set_session_status",
  GET_SESSION_REVIEW: "get_session_review",
  GET_EMPLOYEE_RISK_HISTORY: "get_employee_risk_history",
  LIST_SESSIONS: "list_sessions",
  STORE_REFERENCE_DOCUMENT: "store_reference_document",
  LIST_REFERENCE_DOCUMENTS: "list_reference_documents",
  DELETE_REFERENCE_DOCUMENT: "delete_reference_document",
  HEALTH_CHECK: "health_check",
} as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[keyof typeof MCP_TOOL_NAMES];

/** Every tool name, as a runtime array (order matches MCP_TOOL_NAMES). */
export const ALL_MCP_TOOL_NAMES: McpToolName[] = Object.values(MCP_TOOL_NAMES);

/**
 * Cerberus-native MongoDB collection names.
 *
 * `micro_events` is unchanged from the historical schema because the name was
 * already domain-neutral. The other three were renamed; see docs/migration.md
 * for the old → new mapping and the migration guidance.
 */
export const COLLECTION_NAMES = {
  threatScenarios: "threat_scenarios",
  sessions: "monitored_sessions",
  microEvents: "micro_events",
  riskAssessments: "risk_assessments",
  referenceDocuments: "reference_documents",
  /**
   * The migration ledger: which migrations this database has had applied, and
   * when. Written only by `runMigrations()`.
   */
  schemaMigrations: "schema_migrations",
  /**
   * One counter document holding the reference-corpus size.
   *
   * Exists so the corpus ceiling can be enforced **atomically**. A count-then-insert
   * races: two concurrent creates at one below the limit would both read the same
   * count and both insert. A conditional `$inc` on a single document is atomic, so the
   * counter is the arbiter and exactly `MAX_REFERENCE_DOCUMENTS` creates can succeed.
   *
   * The counter is reconciled from the collection whenever it disagrees with reality,
   * so it self-heals rather than becoming a second source of truth that can drift.
   */
  referenceCorpusMeta: "reference_corpus_meta",
} as const;

/** Default database name. */
export const DEFAULT_DATABASE_NAME = "cerberus";

/** MCP server identity reported to MCP clients. */
export const MCP_SERVER_NAME = "cerberus-mcp-mongodb";
export const MCP_SERVER_VERSION = "0.4.0";

/** Valid session status values accepted by `set_session_status`. */
export const SESSION_STATUSES = ["active", "locked", "terminated"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

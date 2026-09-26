/**
 * Canonical MCP tool names, re-exported for the API side.
 *
 * The API deliberately keeps its own copy of the name set (rather than
 * importing the MCP package at runtime) so the two services stay
 * independently deployable. `apps/api/test/mcp-tool-mapping.test.ts` asserts
 * this set is byte-for-byte identical to the MCP server's, which is what
 * actually guarantees every renamed tool has a matching caller.
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
  // The three tools that make a paid operation retry-safe. See
  // docs/development/paid-operation-state-model.md.
  CLAIM_PAID_OPERATION: "claim_paid_operation",
  COMPLETE_PAID_OPERATION: "complete_paid_operation",
  FAIL_PAID_OPERATION: "fail_paid_operation",
  HEALTH_CHECK: "health_check",
} as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[keyof typeof MCP_TOOL_NAMES];

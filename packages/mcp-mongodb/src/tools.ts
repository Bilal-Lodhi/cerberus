/**
 * MCP tool registry.
 *
 * The registry is typed as `Record<McpToolName, ...>`, so TypeScript fails the
 * build if a canonical tool name is ever added without a handler (or a handler
 * is left behind under an old name). That is the compile-time half of the
 * "every renamed tool has a matching implementation" guarantee; the runtime
 * half lives in apps/api/test/mcp-tool-mapping.test.ts.
 */

import type { MongoStore } from "./mongo-client.js";
import {
  MCP_TOOL_NAMES,
  SESSION_STATUSES,
  type McpToolName,
} from "./tool-names.js";

export type ToolHandler = (body: Record<string, unknown>) => Promise<unknown>;

export interface ToolDefinition {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_DEFINITIONS: Record<McpToolName, ToolDefinition> = {
  [MCP_TOOL_NAMES.STORE_THREAT_SCENARIO]: {
    name: MCP_TOOL_NAMES.STORE_THREAT_SCENARIO,
    description:
      "Persist a complete threat scenario matrix to MongoDB. Used after the CISO agent authors a scenario set.",
    inputSchema: {
      type: "object",
      properties: {
        scenario: {
          type: "object",
          description: "The threat scenario matrix JSON produced by the AI provider",
        },
      },
      required: ["scenario"],
    },
  },

  [MCP_TOOL_NAMES.GET_THREAT_SCENARIO]: {
    name: MCP_TOOL_NAMES.GET_THREAT_SCENARIO,
    description: "Retrieve a persisted threat scenario matrix by its matrixId.",
    inputSchema: {
      type: "object",
      properties: {
        matrixId: { type: "string", description: "UUID matrix identifier" },
      },
      required: ["matrixId"],
    },
  },

  [MCP_TOOL_NAMES.CREATE_SESSION]: {
    name: MCP_TOOL_NAMES.CREATE_SESSION,
    description: "Initialize a new monitored employee session in MongoDB.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        employeeId: { type: "string" },
        auditId: { type: "string" },
        matrixId: { type: "string" },
        targetSystem: { type: "string" },
        status: { type: "string" },
      },
      required: ["sessionId", "employeeId", "auditId"],
    },
  },

  [MCP_TOOL_NAMES.UPDATE_SESSION_TERMINAL_CONTENT]: {
    name: MCP_TOOL_NAMES.UPDATE_SESSION_TERMINAL_CONTENT,
    description: "Persist the current terminal workspace content for a session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        terminalContent: { type: "string" },
      },
      required: ["sessionId", "terminalContent"],
    },
  },

  [MCP_TOOL_NAMES.DELETE_SESSION]: {
    name: MCP_TOOL_NAMES.DELETE_SESSION,
    description:
      "Permanently delete a session and all its associated micro-events and risk assessments.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The session ID to delete" },
      },
      required: ["sessionId"],
    },
  },

  [MCP_TOOL_NAMES.APPEND_MICRO_EVENT]: {
    name: MCP_TOOL_NAMES.APPEND_MICRO_EVENT,
    description: "Append a single telemetry micro-event.",
    inputSchema: {
      type: "object",
      properties: { event: { type: "object" } },
      required: ["event"],
    },
  },

  [MCP_TOOL_NAMES.INGEST_MICRO_EVENTS]: {
    name: MCP_TOOL_NAMES.INGEST_MICRO_EVENTS,
    description:
      "Batch ingest behavioural micro-events (keystrokes, paste triggers, tab switches, copy attempts).",
    inputSchema: {
      type: "object",
      properties: {
        events: {
          type: "array",
          items: { type: "object" },
          description: "Array of MicroEvent objects",
        },
      },
      required: ["events"],
    },
  },

  [MCP_TOOL_NAMES.STORE_RISK_ASSESSMENT]: {
    name: MCP_TOOL_NAMES.STORE_RISK_ASSESSMENT,
    description:
      "Persist a risk assessment payload produced by the Guardian risk analysis.",
    inputSchema: {
      type: "object",
      properties: { report: { type: "object" } },
      required: ["report"],
    },
  },

  [MCP_TOOL_NAMES.UPDATE_SESSION_COUNTS]: {
    name: MCP_TOOL_NAMES.UPDATE_SESSION_COUNTS,
    description: "Update the live aggregate counters on a session document.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        counts: { type: "object" },
      },
      required: ["sessionId", "counts"],
    },
  },

  [MCP_TOOL_NAMES.SET_SESSION_STATUS]: {
    name: MCP_TOOL_NAMES.SET_SESSION_STATUS,
    description: "Set a session status (active, locked, terminated).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        status: { type: "string", enum: [...SESSION_STATUSES] },
      },
      required: ["sessionId", "status"],
    },
  },

  [MCP_TOOL_NAMES.GET_SESSION_REVIEW]: {
    name: MCP_TOOL_NAMES.GET_SESSION_REVIEW,
    description:
      "Fetch the complete review data for a session: document, events and risk assessments.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },

  [MCP_TOOL_NAMES.GET_EMPLOYEE_RISK_HISTORY]: {
    name: MCP_TOOL_NAMES.GET_EMPLOYEE_RISK_HISTORY,
    description:
      "Aggregate all risk assessments for a specific employee across all sessions.",
    inputSchema: {
      type: "object",
      properties: { employeeId: { type: "string" } },
      required: ["employeeId"],
    },
  },

  [MCP_TOOL_NAMES.LIST_SESSIONS]: {
    name: MCP_TOOL_NAMES.LIST_SESSIONS,
    description: "List all monitored sessions with their aggregate counters.",
    inputSchema: { type: "object", properties: {} },
  },

  [MCP_TOOL_NAMES.HEALTH_CHECK]: {
    name: MCP_TOOL_NAMES.HEALTH_CHECK,
    description: "Verify MongoDB connectivity and report store status.",
    inputSchema: { type: "object", properties: {} },
  },
};

/** Thrown for a missing/invalid tool argument. Surfaces as HTTP 400. */
export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolArgumentError(`Missing required parameter: ${key}`);
  }
  return value;
}

function requireObject(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolArgumentError(`Missing required parameter: ${key}`);
  }
  return value as Record<string, unknown>;
}

export function createToolRegistry(store: MongoStore): Record<McpToolName, ToolHandler> {
  return {
    [MCP_TOOL_NAMES.STORE_THREAT_SCENARIO]: async (body) => {
      const scenario = requireObject(body, "scenario");
      const mongoDocumentId = await store.storeThreatScenario(scenario);
      return { success: true, mongoDocumentId };
    },

    [MCP_TOOL_NAMES.GET_THREAT_SCENARIO]: async (body) => {
      const matrixId = requireString(body, "matrixId");
      const data = await store.getThreatScenario(matrixId);
      return { success: true, data };
    },

    [MCP_TOOL_NAMES.CREATE_SESSION]: async (body) => {
      const mongoDocumentId = await store.createSession(body);
      return { success: true, mongoDocumentId };
    },

    [MCP_TOOL_NAMES.UPDATE_SESSION_TERMINAL_CONTENT]: async (body) => {
      const sessionId = requireString(body, "sessionId");
      const terminalContent = requireString(body, "terminalContent");
      await store.updateSession(sessionId, { terminalContent });
      return { success: true };
    },

    [MCP_TOOL_NAMES.DELETE_SESSION]: async (body) => {
      const sessionId = requireString(body, "sessionId");
      const deleted = await store.deleteSession(sessionId);
      return { success: true, deleted };
    },

    [MCP_TOOL_NAMES.APPEND_MICRO_EVENT]: async (body) => {
      const event = requireObject(body, "event");
      const processedCount = await store.ingestMicroEvents([event]);
      return { success: true, processedCount };
    },

    [MCP_TOOL_NAMES.INGEST_MICRO_EVENTS]: async (body) => {
      const events = body["events"];
      if (!Array.isArray(events)) {
        throw new ToolArgumentError("Missing required parameter: events (array)");
      }
      const processedCount = await store.ingestMicroEvents(
        events as Record<string, unknown>[],
      );
      return { success: true, processedCount };
    },

    [MCP_TOOL_NAMES.STORE_RISK_ASSESSMENT]: async (body) => {
      const report = requireObject(body, "report");
      const mongoDocumentId = await store.storeRiskAssessment(report);
      return { success: true, mongoDocumentId };
    },

    [MCP_TOOL_NAMES.UPDATE_SESSION_COUNTS]: async (body) => {
      const sessionId = requireString(body, "sessionId");
      const counts = requireObject(body, "counts");
      await store.updateSessionCounts(sessionId, {
        eventCount: (counts["eventCount"] as number) ?? 0,
        pasteCount: counts["pasteCount"] as number | undefined,
        tabSwitchCount: counts["tabSwitchCount"] as number | undefined,
        copyAttemptCount: counts["copyAttemptCount"] as number | undefined,
        peakRiskScore: counts["peakRiskScore"] as number | undefined,
        status: counts["status"] as string | undefined,
      });
      return { success: true };
    },

    [MCP_TOOL_NAMES.SET_SESSION_STATUS]: async (body) => {
      const sessionId = requireString(body, "sessionId");
      const status = requireString(body, "status");
      if (!(SESSION_STATUSES as readonly string[]).includes(status)) {
        throw new ToolArgumentError(
          `Invalid status. Must be one of: ${SESSION_STATUSES.join(", ")}`,
        );
      }
      const updated = await store.setSessionStatus(sessionId, status);
      return { success: true, status, updated };
    },

    [MCP_TOOL_NAMES.GET_SESSION_REVIEW]: async (body) => {
      const sessionId = requireString(body, "sessionId");
      const [session, events, riskAssessments] = await Promise.all([
        store.getSession(sessionId),
        store.getSessionEvents(sessionId),
        store.getRiskAssessments(sessionId),
      ]);
      return { success: true, session, events, riskAssessments };
    },

    [MCP_TOOL_NAMES.GET_EMPLOYEE_RISK_HISTORY]: async (body) => {
      const employeeId = requireString(body, "employeeId");
      const reports = await store.getEmployeeRiskHistory(employeeId);
      return { success: true, reports };
    },

    [MCP_TOOL_NAMES.LIST_SESSIONS]: async () => {
      const data = await store.listSessions();
      return { success: true, data };
    },

    [MCP_TOOL_NAMES.HEALTH_CHECK]: async () => {
      const healthy = await store.ping();
      return {
        connected: store.isConnected(),
        healthy,
        timestamp: new Date().toISOString(),
      };
    },
  };
}

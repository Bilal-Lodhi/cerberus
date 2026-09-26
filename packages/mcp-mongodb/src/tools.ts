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

/**
 * How many recent micro-events `get_session_review` returns when the caller does
 * not ask for a specific number.
 *
 * Matches `MongoStore.getSessionEvents`'s own default, so a caller that omits the
 * parameter gets exactly what it got before the parameter existed.
 *
 * Declared above `TOOL_DEFINITIONS` because that object's schema description
 * interpolates it, and a `const` referenced before its declaration is in the
 * temporal dead zone at module-evaluation time.
 */
export const DEFAULT_SESSION_EVENTS_LIMIT = 500;

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
    description:
      "Set a session status (active, locked, terminated). Optionally only while the " +
      "stored status is one of expectedStatuses, making the write a compare-and-set.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        status: { type: "string", enum: [...SESSION_STATUSES] },
        expectedStatuses: {
          type: "array",
          items: { type: "string", enum: [...SESSION_STATUSES] },
          description:
            "When supplied, the update applies only if the stored status is one of " +
            "these. Omit for the previous unconditional behaviour.",
        },
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
      properties: {
        sessionId: { type: "string" },
        eventsLimit: {
          type: "number",
          description:
            `How many recent events to return. Defaults to ${DEFAULT_SESSION_EVENTS_LIMIT}. ` +
            "0 returns none, for a caller that wants only the session document.",
        },
        includeAssessments: {
          type: "boolean",
          description:
            "Whether to return the risk assessments. Defaults to true. false skips the " +
            "query entirely.",
        },
      },
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

  [MCP_TOOL_NAMES.STORE_REFERENCE_DOCUMENT]: {
    name: MCP_TOOL_NAMES.STORE_REFERENCE_DOCUMENT,
    description:
      "Upsert one operator-managed reference document used for local data-leakage similarity comparison.",
    inputSchema: {
      type: "object",
      properties: {
        referenceId: { type: "string", description: "Stable identifier; re-submitting updates" },
        label: { type: "string", description: "Human-readable source description" },
        content: { type: "string", description: "The reference text to compare against" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["referenceId", "label", "content"],
    },
  },

  [MCP_TOOL_NAMES.LIST_REFERENCE_DOCUMENTS]: {
    name: MCP_TOOL_NAMES.LIST_REFERENCE_DOCUMENTS,
    description: "List the operator-managed reference corpus, newest first.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
  },

  [MCP_TOOL_NAMES.DELETE_REFERENCE_DOCUMENT]: {
    name: MCP_TOOL_NAMES.DELETE_REFERENCE_DOCUMENT,
    description: "Remove one reference document from the corpus.",
    inputSchema: {
      type: "object",
      properties: { referenceId: { type: "string" } },
      required: ["referenceId"],
    },
  },

  [MCP_TOOL_NAMES.HEALTH_CHECK]: {
    name: MCP_TOOL_NAMES.HEALTH_CHECK,
    description: "Verify MongoDB connectivity and report store status.",
    inputSchema: { type: "object", properties: {} },
  },
};

/**
 * Bounds on an operator-supplied reference document.
 *
 * The corpus is read in full on every risk analysis, so an unbounded entry would
 * add unbounded work to the ingest path as well as unbounded storage. These are
 * limits on what one document may contribute, not a retention policy.
 */
export const MAX_REFERENCE_CONTENT_CHARS = 20_000;
export const MAX_REFERENCE_LABEL_CHARS = 200;
export const MAX_REFERENCE_TAGS = 20;
export const MAX_REFERENCE_TAG_CHARS = 50;
/** Upper bound on how many corpus documents a single list call returns. */
export const MAX_REFERENCE_DOCUMENTS = 200;

/**
 * Reads an optional non-negative integer.
 *
 * Returns `undefined` when the field is absent, so the caller can tell "not asked"
 * from "asked for zero". A non-numeric or negative value is a `ToolArgumentError`
 * rather than a silent fallback: a caller that asked for `-1` events has a bug, and
 * quietly substituting the default would hide it.
 */
function readOptionalCount(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolArgumentError(`Parameter '${key}' must be a finite number.`);
  }
  const count = Math.floor(value);
  if (count < 0) {
    throw new ToolArgumentError(`Parameter '${key}' must not be negative.`);
  }
  return count;
}

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

/** Reads a required string and enforces a maximum length. */
function requireBoundedString(
  body: Record<string, unknown>,
  key: string,
  maxChars: number,
): string {
  const value = requireString(body, key);
  if (value.length > maxChars) {
    throw new ToolArgumentError(
      `Parameter '${key}' must be at most ${maxChars} characters (got ${value.length}).`,
    );
  }
  return value;
}

/**
 * Reads an optional string list, bounding both its length and each entry.
 *
 * A non-array, or an array containing non-strings, is rejected rather than
 * coerced: silently dropping a tag would make the stored document differ from
 * what the operator submitted.
 */
function readBoundedTags(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (value === undefined || value === null) return [];

  if (!Array.isArray(value)) {
    throw new ToolArgumentError(`Parameter '${key}' must be an array of strings.`);
  }
  if (value.length > MAX_REFERENCE_TAGS) {
    throw new ToolArgumentError(
      `Parameter '${key}' must contain at most ${MAX_REFERENCE_TAGS} entries.`,
    );
  }

  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new ToolArgumentError(`Parameter '${key}' must contain non-empty strings.`);
    }
    const trimmed = entry.trim();
    if (trimmed.length > MAX_REFERENCE_TAG_CHARS) {
      throw new ToolArgumentError(
        `Each '${key}' entry must be at most ${MAX_REFERENCE_TAG_CHARS} characters.`,
      );
    }
    return trimmed;
  });
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
      const batch = events as Record<string, unknown>[];
      const { acceptedEventIds, duplicateEventIds } = await store.ingestMicroEvents(batch);
      return {
        success: true,
        // `processedCount` keeps its old meaning for existing callers: the size
        // of the batch. `acceptedEventIds` is what tells a caller which events
        // were actually new, so a retry does not inflate in-memory counters.
        processedCount: batch.length,
        acceptedEventIds,
        duplicateEventIds,
      };
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
        fullscreenExitCount: counts["fullscreenExitCount"] as number | undefined,
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

      // Optional compare-and-set predicate. An absent value keeps the previous
      // unconditional behaviour; a supplied one is validated against the same
      // vocabulary as `status`, so a caller cannot predicate on a status that could
      // never have been stored.
      const rawExpected = body["expectedStatuses"];
      let expectedStatuses: string[] | undefined;
      if (rawExpected !== undefined && rawExpected !== null) {
        if (!Array.isArray(rawExpected)) {
          throw new ToolArgumentError(
            "Parameter 'expectedStatuses' must be an array of session statuses.",
          );
        }
        expectedStatuses = rawExpected.map((entry) => {
          if (typeof entry !== "string") {
            throw new ToolArgumentError(
              "Parameter 'expectedStatuses' must contain only strings.",
            );
          }
          if (!(SESSION_STATUSES as readonly string[]).includes(entry)) {
            throw new ToolArgumentError(
              `Invalid expected status '${entry}'. Must be one of: ` +
                `${SESSION_STATUSES.join(", ")}`,
            );
          }
          return entry;
        });
      }

      const updated = await store.setSessionStatus(sessionId, status, {
        ...(expectedStatuses ? { expectedStatuses } : {}),
      });
      return { success: true, status, updated };
    },

    [MCP_TOOL_NAMES.GET_SESSION_REVIEW]: async (body) => {
      const sessionId = requireString(body, "sessionId");
      const eventsLimit =
        readOptionalCount(body, "eventsLimit") ?? DEFAULT_SESSION_EVENTS_LIMIT;
      const includeAssessments = body["includeAssessments"] !== false;

      // A limit of 0 skips the query rather than passing 0 to the driver, where
      // `.limit(0)` means "no limit" and would return the entire collection.
      const [session, events, riskAssessments] = await Promise.all([
        store.getSession(sessionId),
        eventsLimit === 0
          ? Promise.resolve([])
          : store.getSessionEvents(sessionId, { limit: eventsLimit }),
        includeAssessments
          ? store.getRiskAssessments(sessionId)
          : Promise.resolve([]),
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

    [MCP_TOOL_NAMES.STORE_REFERENCE_DOCUMENT]: async (body) => {
      const referenceId = requireBoundedString(body, "referenceId", MAX_REFERENCE_LABEL_CHARS);
      const label = requireBoundedString(body, "label", MAX_REFERENCE_LABEL_CHARS);
      const content = requireBoundedString(body, "content", MAX_REFERENCE_CONTENT_CHARS);
      const tags = readBoundedTags(body, "tags");

      await store.storeReferenceDocument({ referenceId, label, content, tags });
      return { success: true, referenceId };
    },

    [MCP_TOOL_NAMES.LIST_REFERENCE_DOCUMENTS]: async (body) => {
      const rawLimit = body["limit"];
      const requested =
        typeof rawLimit === "number" && Number.isFinite(rawLimit)
          ? Math.floor(rawLimit)
          : MAX_REFERENCE_DOCUMENTS;
      // Clamped rather than rejected: a caller asking for more than the ceiling
      // gets the ceiling, which is a bound on work rather than an error.
      const limit = Math.min(Math.max(requested, 1), MAX_REFERENCE_DOCUMENTS);

      const data = await store.listReferenceDocuments(limit);
      return { success: true, data };
    },

    [MCP_TOOL_NAMES.DELETE_REFERENCE_DOCUMENT]: async (body) => {
      const referenceId = requireBoundedString(body, "referenceId", MAX_REFERENCE_LABEL_CHARS);
      const deleted = await store.deleteReferenceDocument(referenceId);
      return { success: true, deleted };
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

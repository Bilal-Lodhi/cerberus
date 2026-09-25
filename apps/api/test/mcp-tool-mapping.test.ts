/**
 * MCP tool-name mapping tests.
 *
 * These are the runtime half of the "every renamed MCP tool has a matching
 * caller" guarantee. The compile-time half is that the MCP registry is typed
 * `Record<McpToolName, ToolHandler>`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MCP_TOOL_NAMES as API_TOOL_NAMES,
} from "../src/services/mcp-tool-names.js";
import {
  ALL_MCP_TOOL_NAMES,
  COLLECTION_NAMES,
  DEFAULT_DATABASE_NAME,
  MCP_SERVER_NAME,
  SESSION_STATUSES,
} from "../../../packages/mcp-mongodb/src/tool-names.js";
import {
  TOOL_DEFINITIONS,
  ToolArgumentError,
  createToolRegistry,
} from "../../../packages/mcp-mongodb/src/tools.js";

describe("tool name agreement", () => {
  test("the API and the MCP server declare an identical name set", () => {
    const apiNames = Object.values(API_TOOL_NAMES).sort();
    const serverNames = [...ALL_MCP_TOOL_NAMES].sort();
    assert.deepEqual(apiNames, serverNames);
  });

  test("every declared name has a tool definition", () => {
    for (const name of ALL_MCP_TOOL_NAMES) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(TOOL_DEFINITIONS, name),
        `missing TOOL_DEFINITIONS entry for ${name}`,
      );
    }
  });

  test("every declared name has a handler", () => {
    const registry = createToolRegistry(fakeStore());
    for (const name of ALL_MCP_TOOL_NAMES) {
      assert.equal(typeof registry[name], "function", `missing handler for ${name}`);
    }
  });

  test("no handler exists under an undeclared name", () => {
    const registry = createToolRegistry(fakeStore());
    const declared = new Set<string>(ALL_MCP_TOOL_NAMES);
    for (const key of Object.keys(registry)) {
      assert.ok(declared.has(key), `handler registered under undeclared name: ${key}`);
    }
  });

  test("tool definitions carry a non-empty description and an object schema", () => {
    for (const definition of Object.values(TOOL_DEFINITIONS)) {
      assert.ok(definition.description.length > 10, `${definition.name} has a thin description`);
      assert.equal(typeof definition.inputSchema, "object");
    }
  });
});

describe("retired Assessment-era tool names are gone", () => {
  const RETIRED = [
    "store_test_suite",
    "get_test_suite",
    "store_suspicion_report",
    "get_candidate_report",
    "update_session_code",
  ];

  test("no retired name appears in the canonical set", () => {
    for (const retired of RETIRED) {
      assert.ok(
        !(ALL_MCP_TOOL_NAMES as string[]).includes(retired),
        `retired tool name still declared: ${retired}`,
      );
    }
  });

  test("no tool definition or handler uses a retired name", () => {
    const registry = createToolRegistry(fakeStore());
    for (const retired of RETIRED) {
      assert.ok(!(retired in TOOL_DEFINITIONS), `definition still present: ${retired}`);
      assert.ok(!(retired in registry), `handler still present: ${retired}`);
    }
  });
});

describe("handler argument validation", () => {
  test("a missing required argument raises ToolArgumentError", async () => {
    const registry = createToolRegistry(fakeStore());
    await assert.rejects(
      () => registry[MCP_TOOL_NAMES_SAFE.GET_SESSION_REVIEW]({}),
      (error: unknown) => error instanceof ToolArgumentError,
    );
  });

  test("an invalid session status is rejected", async () => {
    const registry = createToolRegistry(fakeStore());
    await assert.rejects(
      () =>
        registry[MCP_TOOL_NAMES_SAFE.SET_SESSION_STATUS]({
          sessionId: "ses-1",
          status: "banana",
        }),
      (error: unknown) =>
        error instanceof ToolArgumentError && /Invalid status/.test((error as Error).message),
    );
  });

  test("every accepted session status is allowed through", async () => {
    const registry = createToolRegistry(fakeStore());
    for (const status of SESSION_STATUSES) {
      const result = (await registry[MCP_TOOL_NAMES_SAFE.SET_SESSION_STATUS]({
        sessionId: "ses-1",
        status,
      })) as { success: boolean; status: string };
      assert.equal(result.success, true);
      assert.equal(result.status, status);
    }
  });

  test("a non-array events payload is rejected", async () => {
    const registry = createToolRegistry(fakeStore());
    await assert.rejects(
      () => registry[MCP_TOOL_NAMES_SAFE.INGEST_MICRO_EVENTS]({ events: "nope" }),
      (error: unknown) => error instanceof ToolArgumentError,
    );
  });
});

describe("server identity", () => {
  test("the MCP server advertises a Cerberus-native name", () => {
    assert.equal(MCP_SERVER_NAME, "cerberus-mcp-mongodb");
  });

  test("the default database is Cerberus-native", () => {
    assert.equal(DEFAULT_DATABASE_NAME, "cerberus");
  });

  test("collection names match the documented Cerberus schema", () => {
    assert.deepEqual(COLLECTION_NAMES, {
      threatScenarios: "threat_scenarios",
      sessions: "monitored_sessions",
      microEvents: "micro_events",
      riskAssessments: "risk_assessments",
      referenceDocuments: "reference_documents",
    });
  });
});

// Local alias so the import above stays greppable as the canonical constant.
const MCP_TOOL_NAMES_SAFE = API_TOOL_NAMES;

/** Minimal MongoStore stand-in: records calls, returns fixed values. */
function fakeStore(): never {
  return {
    storeThreatScenario: async () => "doc-1",
    getThreatScenario: async () => null,
    createSession: async () => "ses-1",
    updateSession: async () => undefined,
    deleteSession: async () => true,
    ingestMicroEvents: async (events: unknown[]) => events.length,
    storeRiskAssessment: async () => "doc-2",
    updateSessionCounts: async () => undefined,
    setSessionStatus: async () => undefined,
    getSession: async () => null,
    getSessionEvents: async () => [],
    getRiskAssessments: async () => [],
    getEmployeeRiskHistory: async () => [],
    listSessions: async () => [],
    ping: async () => true,
    isConnected: () => true,
  } as never;
}

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
  MAX_REFERENCE_DOCUMENTS as API_MAX_REFERENCE_DOCUMENTS,
  REFERENCE_CORPUS_LIMIT_CODE as API_REFERENCE_CORPUS_LIMIT_CODE,
} from "../src/routes/reference.js";
import {
  ALL_MCP_TOOL_NAMES,
  COLLECTION_NAMES,
  DEFAULT_DATABASE_NAME,
  MCP_SERVER_NAME,
  SESSION_STATUSES,
} from "../../../packages/mcp-mongodb/src/tool-names.js";
import {
  MAX_REFERENCE_DOCUMENTS as MCP_MAX_REFERENCE_DOCUMENTS,
  TOOL_DEFINITIONS,
  ReferenceCorpusLimitToolError,
  ToolArgumentError,
  createToolRegistry,
} from "../../../packages/mcp-mongodb/src/tools.js";
import {
  DEFAULT_IDEMPOTENCY_TTL_SECONDS as MCP_DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  MAX_IDEMPOTENCY_TTL_SECONDS as MCP_MAX_IDEMPOTENCY_TTL_SECONDS,
  MAX_STORED_RESULT_BYTES as MCP_MAX_STORED_RESULT_BYTES,
  MIN_IDEMPOTENCY_TTL_SECONDS as MCP_MIN_IDEMPOTENCY_TTL_SECONDS,
  OPERATION_FAILURE_CATEGORIES as MCP_OPERATION_FAILURE_CATEGORIES,
  PAID_ROUTE_FAMILIES as MCP_PAID_ROUTE_FAMILIES,
  RETRYABLE_FAILURE_CATEGORIES as MCP_RETRYABLE_FAILURE_CATEGORIES,
  deriveLeaseMs as MCP_deriveLeaseMs,
} from "../../../packages/mcp-mongodb/src/operation-claims.js";
import {
  DEFAULT_IDEMPOTENCY_TTL_SECONDS as API_DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  MAX_IDEMPOTENCY_TTL_SECONDS as API_MAX_IDEMPOTENCY_TTL_SECONDS,
  MAX_STORED_RESULT_BYTES as API_MAX_STORED_RESULT_BYTES,
  MIN_IDEMPOTENCY_TTL_SECONDS as API_MIN_IDEMPOTENCY_TTL_SECONDS,
} from "../src/services/idempotency-limits.js";
import {
  OPERATION_FAILURE_CATEGORIES as API_OPERATION_FAILURE_CATEGORIES,
  PAID_ROUTE_FAMILIES as API_PAID_ROUTE_FAMILIES,
  RETRYABLE_FAILURE_CATEGORIES as API_RETRYABLE_FAILURE_CATEGORIES,
  deriveLeaseMs as API_deriveLeaseMs,
} from "../src/services/paid-operation.js";

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
      // The migration ledger. Not domain data: it records which migrations this
      // database has had applied, and is written only by runMigrations().
      schemaMigrations: "schema_migrations",
      // One counter document holding the reference-corpus size, so the corpus ceiling
      // can be enforced with an atomic conditional `$inc` rather than a count-then-insert
      // that races. Not domain data.
      referenceCorpusMeta: "reference_corpus_meta",
      // One claim document per paid-operation attempt, keyed on
      // (routeFamily, sha256(Idempotency-Key)). Not domain data: it holds no prompt, no
      // question and no provider output — only a claim, a fingerprint, and the response to
      // replay. The unique index on that pair is the whole of the mutual exclusion.
      operationClaims: "operation_claims",
    });
  });

  test("the API's corpus ceiling matches the adapter's", () => {
    // The two constants are declared separately because `apps/api` does not depend on the
    // package at runtime. If they drifted, the API would advertise a limit the adapter
    // does not enforce — and a document the API accepted would be refused downstream.
    assert.equal(
      API_MAX_REFERENCE_DOCUMENTS,
      MCP_MAX_REFERENCE_DOCUMENTS,
      "the API and the adapter disagree about the reference-corpus ceiling",
    );
  });

  test("the API's corpus-limit code matches the adapter's", () => {
    // Same reason: the code is a public contract, and the API returns it verbatim.
    assert.equal(
      API_REFERENCE_CORPUS_LIMIT_CODE,
      new ReferenceCorpusLimitToolError(1, 1).code,
    );
  });
});

describe("paid-operation vocabulary agreement", () => {
  // The API does not depend on the MCP package at runtime — the two services are
  // independently deployable — so the claim vocabulary is declared on both sides. A copy
  // that drifted is a real defect: the API would validate a family or a failure category
  // the store rejects, and the route would answer 503 for a request it could have served.
  // A copy with a test is a contract; a copy without one is a coincidence.

  test("the route families agree", () => {
    assert.deepEqual(
      [...API_PAID_ROUTE_FAMILIES].sort(),
      [...MCP_PAID_ROUTE_FAMILIES].sort(),
    );
  });

  test("the failure categories agree", () => {
    assert.deepEqual(
      [...API_OPERATION_FAILURE_CATEGORIES].sort(),
      [...MCP_OPERATION_FAILURE_CATEGORIES].sort(),
    );
  });

  test("the retryable failure categories agree", () => {
    // The most consequential list of the three: it decides whether a same-key retry spends
    // again or replays a recorded failure. Two sides that disagreed would mean the store and
    // the route telling a caller different things about whether money is about to be spent.
    assert.deepEqual(
      [...API_RETRYABLE_FAILURE_CATEGORIES].sort(),
      [...MCP_RETRYABLE_FAILURE_CATEGORIES].sort(),
    );
  });

  test("the retention bounds agree", () => {
    assert.equal(API_DEFAULT_IDEMPOTENCY_TTL_SECONDS, MCP_DEFAULT_IDEMPOTENCY_TTL_SECONDS);
    assert.equal(API_MIN_IDEMPOTENCY_TTL_SECONDS, MCP_MIN_IDEMPOTENCY_TTL_SECONDS);
    assert.equal(API_MAX_IDEMPOTENCY_TTL_SECONDS, MCP_MAX_IDEMPOTENCY_TTL_SECONDS);
  });

  test("the stored-result ceiling agrees", () => {
    assert.equal(API_MAX_STORED_RESULT_BYTES, MCP_MAX_STORED_RESULT_BYTES);
  });

  test("the lease derivation agrees", () => {
    // The lease is derived on the API side and written into the record; the store only
    // compares it. Both declare the derivation so a reader of either service finds it, and
    // the two must produce the same number for the same provider timeout.
    for (const timeout of [1_000, 5_000, 180_000, 600_000, 3_600_000]) {
      assert.equal(
        API_deriveLeaseMs(timeout),
        MCP_deriveLeaseMs(timeout),
        `the two lease derivations disagree at a provider timeout of ${timeout} ms`,
      );
    }
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
    deleteSession: async () => ({
      session: 1,
      telemetry: 0,
      assessments: 0,
      failed: [],
    }),
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

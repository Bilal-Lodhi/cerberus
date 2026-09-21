/**
 * MongoDB persistence-naming tests.
 *
 * Asserts the storage layer uses Cerberus-native names, that the historical
 * Assessment-era names are absent, and that index creation is wired up.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  COLLECTION_NAMES,
  DEFAULT_DATABASE_NAME,
} from "../../../packages/mcp-mongodb/src/tool-names.js";
import { DEFAULT_COLLECTIONS, compact } from "../../../packages/mcp-mongodb/src/mongo-client.js";

const here = dirname(fileURLToPath(import.meta.url));
const MCP_SRC = join(here, "..", "..", "..", "packages", "mcp-mongodb", "src");

function readSource(name: string): string {
  return readFileSync(join(MCP_SRC, name), "utf-8");
}

describe("collection naming", () => {
  test("MongoStore defaults equal the canonical collection names", () => {
    assert.deepEqual(DEFAULT_COLLECTIONS, COLLECTION_NAMES);
  });

  test("no collection name carries Assessment-era vocabulary", () => {
    const legacy = ["test_suites", "assessment_sessions", "suspicion_reports", "gorilla_agents"];
    for (const value of Object.values(COLLECTION_NAMES)) {
      for (const retired of legacy) {
        assert.ok(!value.includes(retired), `${value} contains retired name ${retired}`);
      }
    }
  });

  test("the historical names appear nowhere in the MCP package source", () => {
    const legacy = [
      "test_suites",
      "assessment_sessions",
      "suspicion_reports",
      "gorilla_agents",
      "candidateId",
      "assessmentId",
      "problemId",
      "submittedCode",
      "suspicionReports",
      "testSuite",
      "plagiarism",
    ];

    for (const file of ["mongo-client.ts", "tool-names.ts", "tools.ts", "server.ts", "http-adapter.ts"]) {
      const source = readSource(file);
      for (const retired of legacy) {
        assert.ok(
          !source.includes(retired),
          `${file} still references the retired identifier "${retired}"`,
        );
      }
    }
  });

  test("the default database is cerberus", () => {
    assert.equal(DEFAULT_DATABASE_NAME, "cerberus");
    assert.ok(readSource("mongo-client.ts").includes("DEFAULT_DATABASE_NAME"));
  });
});

describe("index creation", () => {
  const source = readSource("mongo-client.ts");

  test("sessions are uniquely indexed by sessionId", () => {
    assert.match(source, /sessions\.createIndex\(\{ sessionId: 1 \}, \{ unique: true \}\)/);
  });

  test("sessions are indexed by the Cerberus employee/audit pair", () => {
    assert.match(source, /sessions\.createIndex\(\{ employeeId: 1, auditId: 1 \}\)/);
  });

  test("risk assessments are indexed by session and generation time", () => {
    assert.match(source, /riskAssessments\.createIndex\(\{ sessionId: 1, generatedAt: -1 \}\)/);
  });

  test("threat scenarios are uniquely indexed by matrix id", () => {
    assert.match(
      source,
      /threatScenarios\.createIndex\(\{ "metadata\.matrixId": 1 \}, \{ unique: true \}\)/,
    );
  });

  test("ensureIndexes is invoked on connect", () => {
    assert.match(source, /async connect\(\)[\s\S]*?await this\.ensureIndexes\(\)/);
  });
});

describe("partial updates never write BSON null", () => {
  // The MongoDB driver serialises `undefined` as BSON null, so spreading an
  // object with absent optional fields into $set silently clobbers existing
  // values. Observed live: a session's status became null after an
  // aggregate-counter update that did not include a status.
  test("compact drops undefined values", () => {
    const result = compact({
      eventCount: 2,
      pasteCount: undefined,
      status: undefined,
      tabSwitchCount: 0,
    });

    assert.deepEqual(result, { eventCount: 2, tabSwitchCount: 0 });
    assert.ok(!("status" in result));
    assert.ok(!("pasteCount" in result));
  });

  test("compact preserves explicitly falsy values", () => {
    assert.deepEqual(compact({ a: 0, b: "", c: false, d: null }), {
      a: 0,
      b: "",
      c: false,
      d: null,
    });
  });

  test("compact returns an empty object for an all-undefined input", () => {
    assert.deepEqual(compact({ a: undefined, b: undefined }), {});
  });

  test("both partial-update helpers route through compact", () => {
    const source = readSource("mongo-client.ts");
    assert.match(source, /async updateSession\([\s\S]{0,200}\$set: \{ \.\.\.compact\(update\)/);
    assert.match(
      source,
      /async updateSessionCounts\([\s\S]{0,700}\$set: \{ \.\.\.compact\(counts\)/,
    );
  });
});

describe("session creation status", () => {
  const source = readSource("mongo-client.ts");

  test("sessions are created as 'active', never 'in_progress'", () => {
    assert.match(source, /async createSession\([\s\S]{0,600}status: "active"/);
    assert.ok(
      !source.includes("in_progress"),
      "'in_progress' is not a member of either status vocabulary and must not be written",
    );
  });

  test("the guardian creates sessions with a legal status", () => {
    const guardian = readFileSync(
      join(here, "..", "src", "routes", "guardian.ts"),
      "utf-8",
    );
    assert.ok(!guardian.includes("in_progress"));
    assert.match(guardian, /status: "active",/);
  });
});

describe("session deletion cascades", () => {
  const source = readSource("mongo-client.ts");

  test("deleteSession removes the session, its events and its assessments", () => {
    assert.match(source, /async deleteSession\(sessionId: string\)/);
    assert.match(source, /microEvents"\)\.deleteMany\(\{ sessionId \}\)/);
    assert.match(source, /riskAssessments"\)\.deleteMany\(\{ sessionId \}\)/);
  });

  test("terminate and delete are distinct operations", () => {
    assert.match(source, /async setSessionStatus\(sessionId: string, status: string\)/);
    // setSessionStatus must not delete anything.
    const body = source.slice(
      source.indexOf("async setSessionStatus"),
      source.indexOf("async setSessionStatus") + 300,
    );
    assert.ok(!body.includes("deleteOne"));
    assert.ok(!body.includes("deleteMany"));
  });
});

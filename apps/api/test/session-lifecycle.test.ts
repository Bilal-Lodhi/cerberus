/**
 * Session lifecycle and telemetry ingestion tests.
 *
 * Exercises the real route handlers, the real AI provider and the real
 * parsers. Only the two network boundaries (the MCP persistence adapter and
 * the OpenAI endpoint) are stubbed, so no paid API call and no live MongoDB
 * are required.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import {
  authorizedHeaders,
  installFetchStub,
  makeConfig,
  pasteEvent,
  type FetchStub,
} from "./helpers.js";

/** A stateful in-memory stand-in for the MCP MongoDB adapter. */
function statefulMcp() {
  const sessions = new Map<string, Record<string, unknown>>();
  const events = new Map<string, Array<Record<string, unknown>>>();
  const assessments = new Map<string, Array<Record<string, unknown>>>();

  return {
    sessions,
    handler(tool: string, body: Record<string, unknown>): unknown {
      switch (tool) {
        case "create_session": {
          const sessionId = String(body["sessionId"]);
          if (!sessions.has(sessionId)) {
            sessions.set(sessionId, {
              ...body,
              createdAt: new Date().toISOString(),
            });
          }
          return { success: true, mongoDocumentId: `doc-${sessionId}` };
        }
        case "get_session_review": {
          const sessionId = String(body["sessionId"]);
          return {
            success: true,
            session: sessions.get(sessionId) ?? null,
            events: events.get(sessionId) ?? [],
            riskAssessments: assessments.get(sessionId) ?? [],
          };
        }
        case "ingest_micro_events": {
          const batch = (body["events"] ?? []) as Array<Record<string, unknown>>;
          for (const event of batch) {
            const sessionId = String(event["sessionId"]);
            const list = events.get(sessionId) ?? [];
            list.push(event);
            events.set(sessionId, list);
          }
          return { success: true, processedCount: batch.length };
        }
        case "update_session_counts": {
          const sessionId = String(body["sessionId"]);
          const counts = (body["counts"] ?? {}) as Record<string, unknown>;
          sessions.set(sessionId, { ...(sessions.get(sessionId) ?? {}), ...counts });
          return { success: true };
        }
        case "set_session_status": {
          const sessionId = String(body["sessionId"]);
          const existed = sessions.has(sessionId);
          if (existed) {
            sessions.set(sessionId, {
              ...(sessions.get(sessionId) ?? {}),
              status: body["status"],
            });
          }
          return { success: true, status: body["status"], updated: existed };
        }
        case "store_risk_assessment": {
          const report = (body["report"] ?? {}) as Record<string, unknown>;
          const sessionId = String(report["sessionId"] ?? "");
          const list = assessments.get(sessionId) ?? [];
          list.push(report);
          assessments.set(sessionId, list);
          return { success: true, mongoDocumentId: "assessment-doc" };
        }
        case "delete_session": {
          const sessionId = String(body["sessionId"]);
          const existed = sessions.delete(sessionId);
          events.delete(sessionId);
          assessments.delete(sessionId);
          return { success: true, deleted: existed };
        }
        case "list_sessions":
          return { success: true, data: [...sessions.values()] };
        case "health_check":
          return { connected: true, healthy: true, timestamp: new Date().toISOString() };
        default:
          return { success: true };
      }
    },
  };
}

describe("session lifecycle", () => {
  let stub: FetchStub;
  let mcp: ReturnType<typeof statefulMcp>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetAIProvider();
    mcp = statefulMcp();
    stub = installFetchStub({
      mcpResponse: (tool, body) => mcp.handler(tool, body),
    });
    app = createApp(makeConfig());
  });

  afterEach(() => {
    stub.restore();
    resetAIProvider();
  });

  test("deploy creates a session that is visible before any telemetry arrives", async () => {
    const res = await app.request("/api/v1/guardian/deploy", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        employeeUid: "op-trader-001",
        sessionId: "ses-deploy",
        matrixId: "matrix-1",
        targetSystem: "Core Trading Ledger",
      }),
    });

    assert.equal(res.status, 201);
    const body = (await res.json()) as { success: boolean; sessionId: string };
    assert.equal(body.success, true);
    assert.equal(body.sessionId, "ses-deploy");

    const list = await app.request("/api/v1/guardian/sessions", {
      headers: authorizedHeaders(),
    });
    const listed = (await list.json()) as { data: Array<Record<string, unknown>> };
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data[0]["sessionId"], "ses-deploy");
    assert.equal(listed.data[0]["targetSystem"], "Core Trading Ledger");
    assert.equal(listed.data[0]["eventCount"], 0);
  });

  test("deploy validates its required fields", async () => {
    const res = await app.request("/api/v1/guardian/deploy", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ employeeUid: "op-1" }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /sessionId/);
  });

  test("ingest records telemetry and reports the processed count", async () => {
    const res = await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events: [pasteEvent("ses-1")] }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { success: boolean; processedCount: number };
    assert.equal(body.success, true);
    assert.equal(body.processedCount, 1);

    const detail = await app.request("/api/v1/guardian/sessions/ses-1", {
      headers: authorizedHeaders(),
    });
    const session = (await detail.json()) as {
      session: { eventCount: number; pasteCount: number; employeeId: string; auditId: string };
    };
    assert.equal(session.session.eventCount, 1);
    assert.equal(session.session.pasteCount, 1);
    assert.equal(session.session.employeeId, "op-trader-001");
    assert.equal(session.session.auditId, "audit-2026-q1");
  });

  test("ingest rejects an empty event array", async () => {
    const res = await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events: [] }),
    });
    assert.equal(res.status, 400);
  });

  test("ingest rejects an event without a sessionId", async () => {
    const res = await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events: [{ eventType: "KEYSTROKE" }] }),
    });
    assert.equal(res.status, 400);
  });

  test("a replayed batch is deduplicated and does not inflate counters", async () => {
    const event = pasteEvent("ses-dup", { eventId: "fixed-event-id" });

    for (let i = 0; i < 3; i++) {
      const res = await app.request("/api/v1/guardian/ingest", {
        method: "POST",
        headers: authorizedHeaders(),
        body: JSON.stringify({ events: [event] }),
      });
      assert.equal(res.status, 200);
    }

    const detail = await app.request("/api/v1/guardian/sessions/ses-dup", {
      headers: authorizedHeaders(),
    });
    const session = (await detail.json()) as {
      session: { eventCount: number; pasteCount: number };
    };

    assert.equal(session.session.eventCount, 1, "replayed batch was counted more than once");
    assert.equal(session.session.pasteCount, 1);
  });

  test("a large paste triggers risk analysis and returns a Cerberus payload", async () => {
    const res = await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        events: [pasteEvent("ses-risk", { payload: { newText: "y".repeat(400), changeLength: 400 } })],
      }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      riskPayload: {
        overallRiskScore: number;
        employeeId: string;
        auditId: string;
        sessionId: string;
        dimensionScores: Record<string, number>;
        flags: unknown[];
        behavioralContext: Record<string, number>;
        keystrokeMetrics: Record<string, number>;
        incidentSummary: string;
      } | null;
      anomalyRiskIndex: number;
    };

    assert.ok(body.riskPayload, "no risk payload was produced");
    assert.equal(body.riskPayload!.sessionId, "ses-risk");
    assert.equal(body.riskPayload!.employeeId, "op-trader-001");
    assert.equal(body.riskPayload!.auditId, "audit-2026-q1");
    assert.ok(body.riskPayload!.overallRiskScore > 0);
    assert.equal(body.riskPayload!.flags.length, 1);
    assert.ok(body.riskPayload!.behavioralContext.totalPasteEvents >= 1);
    assert.equal(typeof body.riskPayload!.incidentSummary, "string");
  });

  test("the risk assessment is persisted through the renamed MCP tool", async () => {
    await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        events: [pasteEvent("ses-persist", { payload: { newText: "z".repeat(400), changeLength: 400 } })],
      }),
    });

    assert.ok(
      stub.mcpTools.includes("store_risk_assessment"),
      `expected store_risk_assessment, saw: ${stub.mcpTools.join(", ")}`,
    );
    assert.ok(!stub.mcpTools.includes("store_suspicion_report"));
    assert.ok(stub.mcpTools.includes("ingest_micro_events"));
    assert.ok(stub.mcpTools.includes("update_session_counts"));
  });

  test("a high score auto-locks the session and propagates the status", async () => {
    // Replace the default fixture with a response whose blended score clears
    // the auto-lock threshold (>= 75).
    stub.restore();
    stub = installFetchStub({
      mcpResponse: (tool, body) => mcp.handler(tool, body),
      aiResponse: JSON.stringify({
        riskAssessmentId: "22222222-2222-4222-8222-222222222222",
        overallRiskScore: 95,
        dimensionScores: { dataExfiltration: 95, policyViolation: 90 },
        flags: [
          {
            flagType: "DATA_EXFILTRATION",
            severity: "critical",
            sourceEventId: "evt-1",
            description: "bulk export of ledger content",
            confidence: 0.95,
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        ],
        exfiltrationReport: null,
        behavioralAnomalies: [],
        generatedAt: "2026-01-01T00:00:00.000Z",
      }),
    });

    await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        events: [pasteEvent("ses-lock", { payload: { newText: "w".repeat(400), changeLength: 400 } })],
      }),
    });

    assert.ok(
      stub.mcpTools.includes("set_session_status"),
      "auto-lock did not propagate to the persistence layer",
    );

    const detail = await app.request("/api/v1/guardian/sessions/ses-lock", {
      headers: authorizedHeaders(),
    });
    const session = (await detail.json()) as { session: { status: string } };
    assert.equal(session.session.status, "locked");

    const review = await app.request("/api/v1/sessions/ses-lock", {
      headers: authorizedHeaders(),
    });
    const reviewed = (await review.json()) as { data: { status: string } };
    assert.equal(reviewed.data.status, "locked");
  });

  test("the review endpoint reconstructs a timeline", async () => {
    await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        events: [
          pasteEvent("ses-review", { eventId: "e1" }),
          {
            ...pasteEvent("ses-review", { eventId: "e2" }),
            eventType: "TAB_SWITCH",
            payload: { visibilityState: "hidden" },
          },
          {
            ...pasteEvent("ses-review", { eventId: "e3" }),
            eventType: "COPY_ATTEMPT",
            payload: { copiedLength: 120 },
          },
        ],
      }),
    });

    const res = await app.request("/api/v1/sessions/ses-review", {
      headers: authorizedHeaders(),
    });
    assert.equal(res.status, 200);

    const body = (await res.json()) as {
      data: {
        sessionId: string;
        employeeId: string;
        auditId: string;
        timeline: Array<{ eventType: string; label: string; severity: string; detail: string }>;
        terminalContent: string;
        finalRiskScore: number | null;
      };
    };

    assert.equal(body.data.sessionId, "ses-review");
    assert.equal(body.data.employeeId, "op-trader-001");
    assert.equal(body.data.auditId, "audit-2026-q1");
    assert.equal(body.data.timeline.length, 3);

    const copy = body.data.timeline.find((entry) => entry.eventType === "COPY_ATTEMPT");
    assert.ok(copy);
    assert.equal(copy!.detail, "Selected: 120 chars");

    const tab = body.data.timeline.find((entry) => entry.eventType === "TAB_SWITCH");
    assert.equal(tab!.severity, "warning");
  });

  test("review returns 404 for an unknown session", async () => {
    const res = await app.request("/api/v1/sessions/does-not-exist", {
      headers: authorizedHeaders(),
    });
    assert.equal(res.status, 404);
  });

  test("terminate marks the session terminated and preserves its data", async () => {
    await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events: [pasteEvent("ses-term")] }),
    });

    const res = await app.request("/api/v1/guardian/sessions/ses-term/terminate", {
      method: "POST",
      headers: authorizedHeaders(),
    });
    assert.equal(res.status, 200);

    const body = (await res.json()) as { success: boolean; message: string };
    assert.equal(body.success, true);
    assert.match(body.message, /preserved/);

    // Data survives termination.
    const review = await app.request("/api/v1/sessions/ses-term", {
      headers: authorizedHeaders(),
    });
    assert.equal(review.status, 200);
    const reviewed = (await review.json()) as {
      data: { status: string; timeline: unknown[] };
    };
    assert.equal(reviewed.data.status, "terminated");
    assert.equal(reviewed.data.timeline.length, 1);

    // It is no longer actively monitored.
    const detail = await app.request("/api/v1/guardian/sessions/ses-term", {
      headers: authorizedHeaders(),
    });
    const session = (await detail.json()) as { session: { status: string } };
    assert.equal(session.session.status, "terminated");
  });

  test("delete removes the session and all derived data", async () => {
    await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events: [pasteEvent("ses-del")] }),
    });

    const res = await app.request("/api/v1/guardian/sessions/ses-del", {
      method: "DELETE",
      headers: authorizedHeaders(),
    });
    assert.equal(res.status, 200);

    const detail = await app.request("/api/v1/guardian/sessions/ses-del", {
      headers: authorizedHeaders(),
    });
    assert.equal(detail.status, 404);

    assert.ok(stub.mcpTools.includes("delete_session"));
    assert.equal(mcp.sessions.has("ses-del"), false, "session survived deletion in the store");
    assert.equal(mcp.sessions.size, 0);
  });

  test("terminate on an unknown session is 404", async () => {
    const res = await app.request("/api/v1/guardian/sessions/nope/terminate", {
      method: "POST",
      headers: authorizedHeaders(),
    });
    assert.equal(res.status, 404);
  });

  test("delete on an unknown session is 404", async () => {
    const res = await app.request("/api/v1/guardian/sessions/nope", {
      method: "DELETE",
      headers: authorizedHeaders(),
    });
    assert.equal(res.status, 404);
  });

  test("ingestion survives an unreachable persistence layer", async () => {
    // Replace the stub with one that fails every MCP call.
    stub.restore();
    stub = installFetchStub({
      mcpResponse: () => {
        throw new Error("mongo unreachable");
      },
    });

    const res = await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events: [pasteEvent("ses-degraded")] }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { success: boolean };
    assert.equal(body.success, true);
  });

  test("the session list degrades to live memory when MongoDB is empty", async () => {
    await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events: [pasteEvent("ses-union")] }),
    });

    const res = await app.request("/api/v1/sessions", { headers: authorizedHeaders() });
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };

    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]["sessionId"], "ses-union");
    assert.equal(body.data[0]["employeeId"], "op-trader-001");
    assert.ok(!("candidateId" in body.data[0]), "legacy candidateId leaked into the response");
    assert.ok(!("assessmentId" in body.data[0]), "legacy assessmentId leaked into the response");
  });
});

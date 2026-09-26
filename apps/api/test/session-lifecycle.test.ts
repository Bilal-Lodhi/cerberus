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
import { createManualClock } from "../src/services/session-liveness.js";
import {
  authorizedHeaders,
  installFetchStub,
  makeConfig,
  makeConfigWithTtl,
  pasteEvent,
  type FetchStub,
} from "./helpers.js";
import { McpStoreDouble } from "./support/mcp-store-double.js";

describe("session lifecycle", () => {
  let stub: FetchStub;
  let mcp: McpStoreDouble;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetAIProvider();
    mcp = new McpStoreDouble();
    stub = installFetchStub({ mcpResponse: mcp.responder() });
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
      mcpResponse: mcp.responder(),
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

// ═══════════════════════════════════════════════════════════════════
// SESSION_TTL_SECONDS enforcement
// ═══════════════════════════════════════════════════════════════════

/**
 * `SESSION_TTL_SECONDS` bounds how long a session is monitored. These tests
 * drive the real routes with an injected manual clock, so the TTL boundary is
 * asserted exactly and nothing sleeps.
 *
 * The manual clock deliberately starts one minute ahead of wall-clock time. The
 * in-process MCP stub stamps documents with real `new Date()`, so offsetting the
 * clock makes every durable timestamp strictly older than the server-observed
 * activity stamp and keeps the boundary arithmetic exact.
 */
describe("session TTL enforcement", () => {
  /** Monitoring window used by every test in this block. */
  const TTL_SECONDS = 600;
  const TTL_MS = TTL_SECONDS * 1000;

  let stub: FetchStub;
  let mcp: McpStoreDouble;

  beforeEach(() => {
    resetAIProvider();
    mcp = new McpStoreDouble();
    stub = installFetchStub({ mcpResponse: mcp.responder() });
  });

  afterEach(() => {
    stub.restore();
    resetAIProvider();
  });

  /** A fresh process: empty in-memory registries, shared durable stub. */
  function newApp(clock: ReturnType<typeof createManualClock>) {
    return createApp(makeConfigWithTtl(TTL_SECONDS), { clock });
  }

  function clockAheadOfWallTime() {
    return createManualClock(Date.now() + 60_000);
  }

  async function ingest(
    target: ReturnType<typeof createApp>,
    event: Record<string, unknown>,
  ) {
    return target.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events: [event] }),
    });
  }

  async function liveSessions(target: ReturnType<typeof createApp>) {
    const res = await target.request("/api/v1/guardian/sessions", {
      headers: authorizedHeaders(),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    return body.data;
  }

  test("a session is no longer listed as live once its TTL has elapsed", async () => {
    const clock = clockAheadOfWallTime();
    const ttlApp = newApp(clock);

    const accepted = await ingest(ttlApp, pasteEvent("ses-ttl"));
    assert.equal(accepted.status, 200);

    // Inside the window the session is live.
    const atStart = await liveSessions(ttlApp);
    assert.equal(atStart.length, 1);
    assert.equal(atStart[0]["sessionId"], "ses-ttl");
    assert.equal(atStart[0]["liveness"], "active");

    // One millisecond before the boundary it is still live.
    clock.advance(TTL_MS - 1);
    assert.equal((await liveSessions(ttlApp)).length, 1);

    // Exactly at the boundary it is not.
    clock.advance(1);
    const expired = await liveSessions(ttlApp);
    assert.equal(expired.length, 0, "an expired session was still reported as live");
  });

  test("expiry does not destroy review evidence", async () => {
    const clock = clockAheadOfWallTime();
    const ttlApp = newApp(clock);

    await ingest(ttlApp, pasteEvent("ses-ttl-evidence"));
    clock.advance(TTL_MS + 60_000);

    assert.equal((await liveSessions(ttlApp)).length, 0);

    // Detail still resolves, with the derived liveness attached.
    const detail = await ttlApp.request("/api/v1/guardian/sessions/ses-ttl-evidence", {
      headers: authorizedHeaders(),
    });
    assert.equal(detail.status, 200);
    const detailBody = (await detail.json()) as {
      session: { liveness: string; eventCount: number; pasteCount: number };
    };
    assert.equal(detailBody.session.liveness, "expired");
    assert.equal(detailBody.session.eventCount, 1);
    assert.equal(detailBody.session.pasteCount, 1);

    // The review surfaces still list it.
    const review = await ttlApp.request("/api/v1/sessions", {
      headers: authorizedHeaders(),
    });
    const reviewBody = (await review.json()) as { data: Array<Record<string, unknown>> };
    assert.equal(reviewBody.data.length, 1);
    assert.equal(reviewBody.data[0]["sessionId"], "ses-ttl-evidence");
    assert.equal(reviewBody.data[0]["liveness"], "expired");

    const reviewDetail = await ttlApp.request("/api/v1/sessions/ses-ttl-evidence", {
      headers: authorizedHeaders(),
    });
    assert.equal(reviewDetail.status, 200);
    const reviewed = (await reviewDetail.json()) as {
      data: { liveness: string; timeline: unknown[] };
    };
    assert.equal(reviewed.data.liveness, "expired");
    assert.equal(reviewed.data.timeline.length, 1);
  });

  test("ingest to an expired session is refused with SESSION_EXPIRED", async () => {
    const clock = clockAheadOfWallTime();
    const ttlApp = newApp(clock);

    await ingest(ttlApp, pasteEvent("ses-ttl-refuse"));
    clock.advance(TTL_MS);

    const res = await ingest(
      ttlApp,
      pasteEvent("ses-ttl-refuse", { eventId: "after-expiry" }),
    );
    assert.equal(res.status, 409);

    const body = (await res.json()) as {
      success: boolean;
      code: string;
      liveness: string;
      sessionId: string;
      error: string;
    };
    assert.equal(body.success, false);
    assert.equal(body.code, "SESSION_EXPIRED");
    assert.equal(body.liveness, "expired");
    assert.equal(body.sessionId, "ses-ttl-refuse");
    assert.match(body.error, /reactivate/);

    // The rejected batch was not recorded, and did not reopen the window.
    const detail = await ttlApp.request("/api/v1/guardian/sessions/ses-ttl-refuse", {
      headers: authorizedHeaders(),
    });
    const detailBody = (await detail.json()) as {
      session: { eventCount: number; liveness: string };
    };
    assert.equal(detailBody.session.eventCount, 1, "refused telemetry was still recorded");
    assert.equal(detailBody.session.liveness, "expired");
    assert.equal(mcp.sessions.size, 1, "the refused batch created an unexpected document");
  });

  test("reactivation reopens the monitoring window", async () => {
    const clock = clockAheadOfWallTime();
    const ttlApp = newApp(clock);

    await ingest(ttlApp, pasteEvent("ses-ttl-reactivate"));
    clock.advance(TTL_MS * 3);
    assert.equal((await liveSessions(ttlApp)).length, 0);

    const reactivate = await ttlApp.request(
      "/api/v1/guardian/sessions/ses-ttl-reactivate/reactivate",
      { method: "POST", headers: authorizedHeaders() },
    );
    assert.equal(reactivate.status, 200);

    const body = (await reactivate.json()) as {
      success: boolean;
      liveness: string;
      status: string;
      previousStatus: string;
      reactivatedAt: string;
    };
    assert.equal(body.success, true);
    assert.equal(body.liveness, "active");
    assert.equal(body.status, "active");
    assert.equal(body.previousStatus, "active");
    assert.ok(body.reactivatedAt.length > 0);

    // Live again, and telemetry is accepted.
    const live = await liveSessions(ttlApp);
    assert.equal(live.length, 1);
    assert.equal(live[0]["liveness"], "active");

    const resumed = await ingest(
      ttlApp,
      pasteEvent("ses-ttl-reactivate", { eventId: "after-reactivation" }),
    );
    assert.equal(resumed.status, 200);
  });

  test("reactivation is idempotent for a live session", async () => {
    const clock = clockAheadOfWallTime();
    const ttlApp = newApp(clock);

    await ingest(ttlApp, pasteEvent("ses-ttl-idempotent"));

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await ttlApp.request(
        "/api/v1/guardian/sessions/ses-ttl-idempotent/reactivate",
        { method: "POST", headers: authorizedHeaders() },
      );
      assert.equal(res.status, 200);
    }

    assert.equal((await liveSessions(ttlApp)).length, 1);
  });

  test("reactivating an unknown session is 404", async () => {
    const clock = clockAheadOfWallTime();
    const ttlApp = newApp(clock);

    const res = await ttlApp.request("/api/v1/guardian/sessions/nope/reactivate", {
      method: "POST",
      headers: authorizedHeaders(),
    });
    assert.equal(res.status, 404);
  });

  test("a terminated session cannot be reactivated", async () => {
    const clock = clockAheadOfWallTime();
    const ttlApp = newApp(clock);

    await ingest(ttlApp, pasteEvent("ses-ttl-terminated"));
    const terminated = await ttlApp.request(
      "/api/v1/guardian/sessions/ses-ttl-terminated/terminate",
      { method: "POST", headers: authorizedHeaders() },
    );
    assert.equal(terminated.status, 200);

    clock.advance(TTL_MS * 2);

    const res = await ttlApp.request(
      "/api/v1/guardian/sessions/ses-ttl-terminated/reactivate",
      { method: "POST", headers: authorizedHeaders() },
    );
    assert.equal(res.status, 409);

    const body = (await res.json()) as { code: string; status: string };
    assert.equal(body.code, "SESSION_TERMINATED");
    assert.equal(body.status, "terminated");

    // Still terminated, and still absent from the live list.
    assert.equal((await liveSessions(ttlApp)).length, 0);
    const review = await ttlApp.request("/api/v1/sessions/ses-ttl-terminated", {
      headers: authorizedHeaders(),
    });
    const reviewed = (await review.json()) as { data: { status: string } };
    assert.equal(reviewed.data.status, "terminated");
  });

  test("a restart does not resurrect an expired session", async () => {
    const clock = clockAheadOfWallTime();

    const first = newApp(clock);
    await ingest(first, pasteEvent("ses-ttl-restart"));

    // A fresh process inside the window recovers the session from MongoDB.
    const second = newApp(clock);
    const recovered = await liveSessions(second);
    assert.equal(recovered.length, 1, "restart recovery lost a live session");
    assert.equal(recovered[0]["sessionId"], "ses-ttl-restart");
    assert.equal(recovered[0]["liveness"], "active");

    // Past the TTL, a restart must not bring it back as actively monitored.
    clock.advance(TTL_MS + 60_000);
    const third = newApp(clock);
    assert.equal(
      (await liveSessions(third)).length,
      0,
      "restart resurrected an expired session",
    );

    // It is still reviewable after the restart.
    const review = await third.request("/api/v1/sessions/ses-ttl-restart", {
      headers: authorizedHeaders(),
    });
    const reviewed = (await review.json()) as {
      data: { sessionId: string; liveness: string };
    };
    assert.equal(reviewed.data.sessionId, "ses-ttl-restart");
    assert.equal(reviewed.data.liveness, "expired");
  });

  test("a deduplicated replay does not extend the monitoring window", async () => {
    const clock = clockAheadOfWallTime();
    const ttlApp = newApp(clock);

    const event = pasteEvent("ses-ttl-replay", { eventId: "fixed-event-id" });
    await ingest(ttlApp, event);

    clock.advance(TTL_MS - 1_000);

    // The identical batch is accepted as a no-op...
    const replay = await ingest(ttlApp, event);
    assert.equal(replay.status, 200);
    assert.equal((await liveSessions(ttlApp)).length, 1);

    // ...but it is not activity, so the original deadline still holds.
    clock.advance(1_000);
    assert.equal(
      (await liveSessions(ttlApp)).length,
      0,
      "a replayed batch extended the session's monitoring window",
    );
  });

  test("a client-supplied future timestamp cannot extend the window", async () => {
    const clock = clockAheadOfWallTime();
    const ttlApp = newApp(clock);

    const farFuture = new Date(clock.now() + 10 * 365 * 24 * 3600 * 1000).toISOString();
    await ingest(ttlApp, pasteEvent("ses-ttl-forged", { timestamp: farFuture }));

    // The forged timestamp is ignored, so it neither shortens nor extends the
    // window: the server-observed activity stamp still governs.
    clock.advance(TTL_MS - 1);
    assert.equal((await liveSessions(ttlApp)).length, 1);

    clock.advance(1);
    assert.equal(
      (await liveSessions(ttlApp)).length,
      0,
      "a forged future event timestamp held the session open",
    );
  });

  test("every surface agrees that a forged-timestamp session is expired", async () => {
    const clock = clockAheadOfWallTime();
    const ttlApp = newApp(clock);

    const farFuture = new Date(clock.now() + 10 * 365 * 24 * 3600 * 1000).toISOString();
    await ingest(
      ttlApp,
      pasteEvent("ses-ttl-forged-review", { timestamp: farFuture }),
    );
    clock.advance(TTL_MS);

    assert.equal((await liveSessions(ttlApp)).length, 0);

    // The review surfaces must reach the same conclusion. A client-supplied
    // timestamp reaching a liveness decision here would be the same bypass by a
    // different route.
    const list = await ttlApp.request("/api/v1/sessions", {
      headers: authorizedHeaders(),
    });
    const listed = (await list.json()) as { data: Array<Record<string, unknown>> };
    const entry = listed.data.find((s) => s["sessionId"] === "ses-ttl-forged-review");
    assert.ok(entry, "the expired session vanished from the review list");
    assert.equal(entry!["liveness"], "expired");

    const detail = await ttlApp.request("/api/v1/sessions/ses-ttl-forged-review", {
      headers: authorizedHeaders(),
    });
    const reviewed = (await detail.json()) as { data: { liveness: string } };
    assert.equal(reviewed.data.liveness, "expired");
  });
});

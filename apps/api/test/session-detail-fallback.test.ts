/**
 * Session detail: the durable read fallback.
 *
 * `GET /api/v1/guardian/sessions/:id` read the two in-memory maps only, so immediately
 * after a restart it answered `404` for a session that exists durably — and kept doing so
 * until `GET /api/v1/guardian/sessions` was called, because that was the only path that
 * rebuilt the registry from MongoDB. One session was `404` on this surface and `200` on
 * the review surface, from the same process, at the same instant.
 *
 * Every case the charter for this work names is covered here: before a restart,
 * immediately after one, a locked session, a terminated one, an expired one, a missing
 * one, an unreachable store, and a cache that disagrees with a newer durable document.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import { createManualClock } from "../src/services/session-liveness.js";
import { SESSION_TRANSITION_CODES } from "../src/services/session-status.js";
import {
  authorizedHeaders,
  installFetchStub,
  makeConfigWithTtl,
  type FetchStub,
} from "./helpers.js";
import { McpStoreDouble } from "./support/mcp-store-double.js";

/** The detail response, as far as these tests read it. */
interface DetailBody {
  success: boolean;
  session?: {
    sessionId: string;
    employeeId: string;
    auditId: string;
    matrixId: string;
    eventCount: number;
    pasteCount: number;
    tabSwitchCount: number;
    focusLossCount: number;
    fullscreenExitCount: number;
    copyAttemptCount: number;
    currentCode: string;
    currentCodeLength: number;
    lastRiskPayload: unknown;
    riskIndex: number;
    overallRiskScore: number;
    peakRiskScore: number;
    startedAt: string;
    deployedAt: string;
    status: string;
    liveness: string;
    lastActivityAt: string;
    targetSystem: string;
    source: "memory" | "durable";
    ephemeralStateAvailable: boolean;
  };
  error?: string;
  code?: string;
}

function keystroke(
  sessionId: string,
  eventId = randomUUID(),
  deltaMs = 120,
): Record<string, unknown> {
  return {
    eventId,
    sessionId,
    employeeId: "op-trader-001",
    auditId: "audit-2026-q1",
    vectorId: "tv-1",
    eventType: "KEYSTROKE",
    timestamp: new Date().toISOString(),
    payload: { deltaMs },
    clientMetadata: { userAgent: "test", platform: "web" },
  };
}

let stub: FetchStub;
let mcp: McpStoreDouble;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  resetAIProvider();
  mcp = new McpStoreDouble();
  stub = installFetchStub({ mcpResponse: mcp.responder() });
  app = createApp(makeConfigWithTtl(3600));
});

afterEach(() => {
  stub.restore();
  resetAIProvider();
});

/** A fresh process over the same store: empty registries, the same durable documents. */
function restart(): ReturnType<typeof createApp> {
  return createApp(makeConfigWithTtl(3600));
}

async function ingest(
  target: ReturnType<typeof createApp>,
  sessionId: string,
  events: Array<Record<string, unknown>>,
): Promise<void> {
  const res = await target.request("/api/v1/guardian/ingest", {
    method: "POST",
    headers: authorizedHeaders(),
    body: JSON.stringify({ events }),
  });
  assert.equal(res.status, 200, `ingest failed: ${await res.text()}`);
}

async function detail(
  target: ReturnType<typeof createApp>,
  sessionId: string,
): Promise<{ status: number; body: DetailBody }> {
  const res = await target.request(`/api/v1/guardian/sessions/${sessionId}`, {
    headers: authorizedHeaders(),
  });
  return { status: res.status, body: (await res.json()) as DetailBody };
}

describe("before a restart — the in-memory path is unchanged", () => {
  test("serves the hydrated counters and the reconstructed workspace", async () => {
    await ingest(app, "d-before", [keystroke("d-before", "k1", 100), keystroke("d-before", "k2", 200)]);

    const { status, body } = await detail(app, "d-before");

    assert.equal(status, 200);
    assert.ok(body.session);
    assert.equal(body.session.eventCount, 2);
    assert.equal(body.session.status, "active");
    assert.equal(body.session.source, "memory");
    assert.equal(
      body.session.ephemeralStateAvailable,
      true,
      "this process ingested events, so it holds the ephemeral state",
    );
  });

  test("does not consult the store at all, so the hot path pays nothing", async () => {
    await ingest(app, "d-no-read", [keystroke("d-no-read")]);
    const before = mcp.calls.length;

    await detail(app, "d-no-read");

    assert.equal(
      mcp.calls.length,
      before,
      "the in-memory path made a persistence call it does not need",
    );
  });
});

describe("immediately after a restart — the durable fallback", () => {
  test("answers 200 for a session that exists durably, with no recovery step first", async () => {
    await ingest(app, "d-after", [keystroke("d-after", "k1", 100), keystroke("d-after", "k2", 200)]);

    // A fresh process. Nothing has rebuilt the registry: no list call, no ingest.
    const restarted = restart();
    const { status, body } = await detail(restarted, "d-after");

    assert.equal(status, 200, "a restart still lost a session that exists durably");
    assert.ok(body.session);
    assert.equal(body.session.sessionId, "d-after");
    assert.equal(body.session.eventCount, 2, "the durable event total was not served");
    assert.equal(body.session.employeeId, "op-trader-001");
    assert.equal(body.session.matrixId, "audit-2026-q1");
    assert.equal(body.session.status, "active");
    assert.equal(body.session.source, "durable");
  });

  test("reports the ephemeral fields as absent rather than inventing them", async () => {
    await ingest(app, "d-ephemeral", [keystroke("d-ephemeral")]);
    const { body } = await detail(restart(), "d-ephemeral");

    assert.ok(body.session);
    assert.equal(body.session.ephemeralStateAvailable, false);
    assert.equal(
      body.session.currentCode,
      "",
      "a durable answer must not fabricate a reconstructed workspace",
    );
    assert.equal(body.session.currentCodeLength, 0);
    assert.equal(
      body.session.lastRiskPayload,
      null,
      "a durable answer must not fabricate the latest risk payload",
    );
  });

  test("agrees with the live list about the same session's counters", async () => {
    await ingest(app, "d-agree", [
      keystroke("d-agree", "k1", 100),
      keystroke("d-agree", "k2", 200),
      keystroke("d-agree", "k3", 300),
    ]);

    const restarted = restart();
    const listed = await restarted.request("/api/v1/guardian/sessions", {
      headers: authorizedHeaders(),
    });
    const listBody = (await listed.json()) as { data: Array<Record<string, unknown>> };
    const entry = listBody.data.find((row) => row["sessionId"] === "d-agree");
    assert.ok(entry, "the live list lost the session");

    // The list has now rebuilt the registry, so the detail route reaches the durable
    // document through the registry branch. Both surfaces must report the same number.
    const { body } = await detail(restarted, "d-agree");
    assert.ok(body.session);
    assert.equal(body.session.eventCount, entry["eventCount"]);
    assert.equal(body.session.pasteCount, entry["pasteCount"]);
    assert.equal(body.session.tabSwitchCount, entry["tabSwitchCount"]);
    assert.equal(body.session.focusLossCount, entry["focusLossCount"]);
    assert.equal(body.session.copyAttemptCount, entry["copyAttemptCount"]);
    assert.equal(body.session.status, entry["status"]);
    assert.equal(body.session.deployedAt, entry["deployedAt"]);
  });

  test("the detail route is not a substitute for recovery: it does not populate the registry", async () => {
    await ingest(app, "d-no-recover", [keystroke("d-no-recover")]);
    const restarted = restart();

    await detail(restarted, "d-no-recover");

    // The session was never ingested into this process, so the in-memory store still
    // holds nothing: the durable read answers the request without claiming state.
    const { body } = await detail(restarted, "d-no-recover");
    assert.ok(body.session);
    assert.equal(body.session.source, "durable");
    assert.equal(
      body.session.ephemeralStateAvailable,
      false,
      "a read must not claim ephemeral state it does not have",
    );
  });

  test("reports the legacy focus-loss field name under both spellings", async () => {
    mcp.seedSession({
      sessionId: "d-legacy",
      status: "active",
      employeeId: "op-trader-001",
      matrixId: "audit-legacy",
      targetSystem: "Core Ledger",
      fullscreenExitCount: 4,
      eventCount: 7,
      peakRiskScore: 61,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:10:00.000Z",
    });

    const { body } = await detail(restart(), "d-legacy");

    assert.ok(body.session);
    assert.equal(body.session.focusLossCount, 4);
    assert.equal(body.session.fullscreenExitCount, 4);
    assert.equal(body.session.eventCount, 7);
    assert.equal(body.session.peakRiskScore, 61);
    assert.equal(body.session.riskIndex, 61);
    assert.equal(body.session.overallRiskScore, 61);
    assert.equal(body.session.targetSystem, "Core Ledger");
    assert.equal(body.session.deployedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(body.session.lastActivityAt, "2026-01-01T00:10:00.000Z");
  });
});

describe("terminal and expired states survive a restart", () => {
  test("a locked session reads as locked", async () => {
    await ingest(app, "d-locked", [keystroke("d-locked")]);
    await mcp.setSessionStatus("d-locked", "locked");

    const { status, body } = await detail(restart(), "d-locked");

    assert.equal(status, 200);
    assert.ok(body.session);
    assert.equal(body.session.status, "locked");
    assert.equal(body.session.source, "durable");
  });

  test("a terminated session is still served, and reports the same liveness as before the restart", async () => {
    await ingest(app, "d-terminated", [keystroke("d-terminated")]);
    const terminated = await app.request("/api/v1/guardian/sessions/d-terminated/terminate", {
      method: "POST",
      headers: authorizedHeaders(),
    });
    assert.equal(terminated.status, 200);

    const before = await detail(app, "d-terminated");
    const after = await detail(restart(), "d-terminated");

    assert.equal(after.status, 200, "a terminated session must stay readable for review");
    assert.ok(before.body.session, `before the restart: ${JSON.stringify(before.body)}`);
    assert.ok(after.body.session, `after the restart: ${JSON.stringify(after.body)}`);
    assert.equal(after.body.session.status, "terminated");
    assert.equal(
      after.body.session.liveness,
      before.body.session.liveness,
      "a restart changed the derived liveness of the same session",
    );
    assert.equal(after.body.session.eventCount, 1, "termination does not delete evidence");
  });

  test("an expired session is still served, with liveness expired", async () => {
    // The durable document is seeded with an old activity instant rather than relying on
    // the store's own clock, so the TTL boundary is asserted exactly and nothing sleeps.
    mcp.seedSession({
      sessionId: "d-expired",
      status: "active",
      employeeId: "op-trader-001",
      matrixId: "audit-2026-q1",
      eventCount: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const later = createApp(makeConfigWithTtl(60), {
      clock: createManualClock(Date.parse("2026-01-01T01:00:00.000Z")),
    });
    const { status, body } = await detail(later, "d-expired");

    assert.equal(status, 200, "expiry stops monitoring; it never hides evidence");
    assert.ok(body.session);
    assert.equal(body.session.liveness, "expired");
    assert.equal(body.session.eventCount, 3);
  });

  test("an expired session is refused by ingest but still readable", async () => {
    mcp.seedSession({
      sessionId: "d-expired-refuse",
      status: "active",
      employeeId: "op-trader-001",
      matrixId: "audit-2026-q1",
      eventCount: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const later = createApp(makeConfigWithTtl(60), {
      clock: createManualClock(Date.parse("2026-01-01T01:00:00.000Z")),
    });
    const refused = await later.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events: [keystroke("d-expired-refuse", "late")] }),
    });
    assert.equal(refused.status, 409);
    const refusedBody = (await refused.json()) as { code: string };
    assert.equal(refusedBody.code, "SESSION_EXPIRED");

    const { status, body } = await detail(later, "d-expired-refuse");
    assert.equal(status, 200);
    assert.equal(body.session?.liveness, "expired");
  });
});

describe("a missing session", () => {
  test("is 404 with the one code every surface uses", async () => {
    const { status, body } = await detail(restart(), "d-absent");

    assert.equal(status, 404);
    assert.equal(body.code, SESSION_TRANSITION_CODES.SESSION_NOT_FOUND);
  });

  test("a deleted session is 404 on the next read", async () => {
    await ingest(app, "d-deleted", [keystroke("d-deleted")]);
    const deleted = await app.request("/api/v1/guardian/sessions/d-deleted", {
      method: "DELETE",
      headers: authorizedHeaders(),
    });
    assert.equal(deleted.status, 200);

    const { status, body } = await detail(restart(), "d-deleted");
    assert.equal(status, 404);
    assert.equal(body.code, SESSION_TRANSITION_CODES.SESSION_NOT_FOUND);
  });
});

describe("an unreachable store", () => {
  test("is 503, not 404 — the existence of the session is unknown", async () => {
    await ingest(app, "d-down", [keystroke("d-down")]);
    const restarted = restart();
    mcp.failToolTransport("get_session_review");

    const { status, body } = await detail(restarted, "d-down");

    assert.equal(
      status,
      503,
      "404 would assert that a session does not exist, which cannot be verified",
    );
    assert.equal(body.code, SESSION_TRANSITION_CODES.SESSION_STORE_UNAVAILABLE);
  });

  test("a session this process deployed is still served from the registry", async () => {
    // `create_session` never reached the store, which the deploy response reports as
    // `local-only`. The registry is the only source, and answering beats refusing.
    const deployed = await app.request("/api/v1/guardian/deploy", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        employeeUid: "op-trader-001",
        sessionId: "d-local-only",
        matrixId: "audit-local",
        targetSystem: "Core Ledger",
      }),
    });
    assert.equal(deployed.status, 201);

    mcp.failToolTransport("get_session_review");
    const { status, body } = await detail(app, "d-local-only");

    assert.equal(status, 200);
    assert.ok(body.session);
    assert.equal(body.session.source, "memory");
    assert.equal(body.session.ephemeralStateAvailable, false);
    assert.equal(body.session.targetSystem, "Core Ledger");
    assert.equal(body.session.eventCount, 0);
  });

  test("an unknown session with an unreachable store is 503 rather than 404", async () => {
    mcp.failToolTransport("get_session_review");
    const { status, body } = await detail(app, "d-unknown-down");

    assert.equal(status, 503);
    assert.equal(body.code, SESSION_TRANSITION_CODES.SESSION_STORE_UNAVAILABLE);
  });
});

describe("a stale cache against a newer durable document", () => {
  test("the live surfaces report their own status, and the review surface reports the durable one", async () => {
    // This process holds the session as `active`. Another writer terminates it durably,
    // without going through this process — so no cache is repaired.
    await ingest(app, "d-stale", [keystroke("d-stale")]);
    await mcp.setSessionStatus("d-stale", "terminated");

    const { body } = await detail(app, "d-stale");
    assert.ok(body.session);
    assert.equal(
      body.session.status,
      "active",
      "the in-memory path reports what this process holds; see the note below",
    );

    // The review surface reads the durable document directly, so it is the surface a
    // caller can trust for status at this instant. That division is deliberate and is
    // stated in `docs/development/operability-model.md` §3.7.
    const review = await app.request("/api/v1/sessions/d-stale", {
      headers: authorizedHeaders(),
    });
    const reviewBody = (await review.json()) as { data: { status: string } };
    assert.equal(reviewBody.data.status, "terminated");

    // And a transition reconciles the cache from the durable value, which is what closes
    // the window rather than leaving it open indefinitely.
    await app.request("/api/v1/guardian/sessions/d-stale/reactivate", {
      method: "POST",
      headers: authorizedHeaders(),
    });
    const reconciled = await detail(app, "d-stale");
    assert.equal(reconciled.body.session?.status, "terminated");
  });

  test("the durable document decides when the cache holds nothing for the session", async () => {
    await ingest(app, "d-durable-wins", [keystroke("d-durable-wins")]);
    await mcp.setSessionStatus("d-durable-wins", "locked");

    const { body } = await detail(restart(), "d-durable-wins");
    assert.ok(body.session);
    assert.equal(
      body.session.status,
      "locked",
      "a restart must not report the status the document no longer holds",
    );
  });
});

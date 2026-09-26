/**
 * Durable event idempotency.
 *
 * The in-process fingerprint ring never survived a restart, so a batch retried
 * after one was re-ingested and re-counted. The `(sessionId, eventId)` unique
 * index is the durable guarantee: the store reports which events were newly
 * inserted, and the ingest path applies only those.
 *
 * The stub here models that report, because a stub that does not is a stub that
 * agrees with the API and disagrees with the database.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import {
  authorizedHeaders,
  installFetchStub,
  makeConfigWithTtl,
  type FetchStub,
} from "./helpers.js";

import { McpStoreDouble } from "./support/mcp-store-double.js";

function event(sessionId: string, eventId: string, deltaMs = 120): Record<string, unknown> {
  return {
    eventId,
    sessionId,
    employeeId: "op-trader-001",
    auditId: "audit-2026-q1",
    vectorId: "tv-1",
    eventType: "KEYSTROKE",
    timestamp: new Date().toISOString(),
    payload: { deltaMs },
    clientMetadata: {
      userAgent: "test",
      ipAddress: "127.0.0.1",
      screenResolution: "1920x1080",
      platform: "web",
      language: "en-US",
    },
  };
}

interface IngestBody {
  success: boolean;
  processedCount: number;
  acceptedCount?: number;
  duplicateCount?: number;
}

describe("durable event idempotency", () => {
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

  function newApp(): ReturnType<typeof createApp> {
    return createApp(makeConfigWithTtl(3600));
  }

  async function ingest(
    app: ReturnType<typeof createApp>,
    events: Array<Record<string, unknown>>,
  ): Promise<{ status: number; body: IngestBody }> {
    const res = await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events }),
    });
    return { status: res.status, body: (await res.json()) as IngestBody };
  }

  /** The counts object the API last sent to the persistence layer. */
  function lastCounts(sessionId: string): Record<string, unknown> {
    return (mcp.sessions.get(sessionId)?.["eventCount"] !== undefined
      ? mcp.sessions.get(sessionId)
      : {}) as Record<string, unknown>;
  }

  test("a retried batch is accepted once and reported as duplicate", async () => {
    const app = newApp();
    const batch = [event("ses-retry", "e1", 100), event("ses-retry", "e2", 200)];

    const first = await ingest(app, batch);
    assert.equal(first.status, 200);
    assert.equal(first.body.processedCount, 2, "processedCount is the batch size");
    assert.equal(first.body.acceptedCount, 2);
    assert.equal(first.body.duplicateCount, 0);

    const second = await ingest(app, batch);
    assert.equal(second.status, 200);
    assert.equal(second.body.processedCount, 2);
    assert.equal(second.body.acceptedCount, 0, "the retry was accepted again");
    assert.equal(second.body.duplicateCount, 2);

    // The durable counter reflects two events, not four.
    assert.equal(lastCounts("ses-retry")["eventCount"], 2);
  });

  test("a retry after a restart does not inflate the counters", async () => {
    // The previous process stored these two events and counted them.
    mcp.seedSession({
      sessionId: "ses-restart-retry",
      status: "active",
      employeeId: "op-trader-001",
      eventCount: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    mcp.seedEvent("ses-restart-retry", { eventId: "e1", sessionId: "ses-restart-retry" });
    mcp.seedEvent("ses-restart-retry", { eventId: "e2", sessionId: "ses-restart-retry" });

    // A brand-new process with an empty fingerprint ring. The in-process dedup
    // layer cannot help here; the durable identity is what must hold.
    const fresh = newApp();
    const retry = await ingest(fresh, [
      event("ses-restart-retry", "e1", 100),
      event("ses-restart-retry", "e2", 200),
    ]);

    assert.equal(retry.status, 200);
    assert.equal(retry.body.acceptedCount, 0);
    assert.equal(retry.body.duplicateCount, 2);
    assert.equal(
      lastCounts("ses-restart-retry")["eventCount"],
      2,
      "the replay was counted a second time",
    );
  });

  test("a partially-new batch reports both counts and counts only the new events", async () => {
    mcp.seedSession({
      sessionId: "ses-partial",
      status: "active",
      employeeId: "op-trader-001",
      eventCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    mcp.seedEvent("ses-partial", { eventId: "e1", sessionId: "ses-partial" });

    const app = newApp();
    const result = await ingest(app, [
      event("ses-partial", "e1", 100),
      event("ses-partial", "e2", 200),
      event("ses-partial", "e3", 300),
    ]);

    assert.equal(result.body.acceptedCount, 2);
    assert.equal(result.body.duplicateCount, 1);
    // One durable event plus the two new ones.
    assert.equal(lastCounts("ses-partial")["eventCount"], 3);
  });

  test("an event without an eventId is rejected", async () => {
    // `MicroEvent.eventId` is required by the contract and is the durable
    // idempotency key, so an event without one cannot be deduplicated.
    const app = newApp();
    const noId = event("ses-no-id", "placeholder");
    delete noId["eventId"];

    const result = await ingest(app, [noId]);
    assert.equal(result.status, 400);
    assert.equal(
      (result.body as unknown as { code: string }).code,
      "MISSING_EVENT_ID",
    );
  });

  test("an empty eventId is rejected", async () => {
    const app = newApp();
    const result = await ingest(app, [event("ses-empty-id", "   ")]);
    assert.equal(result.status, 400);
  });

  test("the same eventId in two sessions is not a duplicate", async () => {
    // The identity is `(sessionId, eventId)`, so a client that numbers events
    // per session is not penalised for reusing an id.
    const app = newApp();
    const a = await ingest(app, [event("ses-a", "shared-1")]);
    const b = await ingest(app, [event("ses-b", "shared-1")]);

    assert.equal(a.body.acceptedCount, 1);
    assert.equal(b.body.acceptedCount, 1);
  });

  test("distinct eventIds with identical payloads are both accepted", async () => {
    // The durable identity is the eventId, so two keystrokes with the same
    // inter-key delay are two keystrokes. The in-process fingerprint would have
    // dropped the second; the durable layer must not.
    const app = newApp();
    const result = await ingest(app, [
      event("ses-distinct", "k1", 120),
      event("ses-distinct", "k2", 120),
    ]);

    assert.equal(result.body.acceptedCount, 2);
    assert.equal(lastCounts("ses-distinct")["eventCount"], 2);
  });

  test("when persistence is unavailable every event is still applied", async () => {
    // There is no accepted-set report, and dropping telemetry is worse than a
    // possible over-count in a session whose events were never stored.
    stub.restore();
    stub = installFetchStub({
      mcpResponse: () => {
        throw new Error("mongo unreachable");
      },
    });

    const app = newApp();
    const result = await ingest(app, [event("ses-degraded", "e1")]);

    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.acceptedCount, 1, "the fallback should report the batch as accepted");
  });
});

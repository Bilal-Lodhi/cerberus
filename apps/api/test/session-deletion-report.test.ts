/**
 * Session deletion: the per-component report, and what a partial deletion means.
 *
 * A deletion cascades over three domain components — the session record, its telemetry
 * and its assessments — and it can **partly** succeed. That is a different fact from "the
 * store did not answer", and the two used to be indistinguishable: `deleteSession` ran the
 * three removals under one `Promise.all` and the tool reported only the session document's
 * `deletedCount`, so a failed telemetry removal was reported as a complete deletion. The
 * failure-semantics document recorded it as open; this suite closes it.
 *
 * The per-component failure is injected through the shared store double. Provoking it
 * against a real MongoDB needs an artificial cluster fault, so the real-database suite
 * verifies the parts it can — that the counts are the documents that were actually there,
 * and that a second delete is a clean no-op. See
 * `apps/api/test/integration/state-flows.test.ts` and
 * `apps/api/test/store-contract.test.ts`.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import { SESSION_DELETION_CODES, SESSION_TRANSITION_CODES } from "../src/services/session-status.js";
import {
  authorizedHeaders,
  installFetchStub,
  makeConfigWithTtl,
  type FetchStub,
} from "./helpers.js";
import { McpStoreDouble } from "./support/mcp-store-double.js";

interface DeletionBody {
  success: boolean;
  code?: string;
  sessionId?: string;
  complete?: boolean;
  partial?: boolean;
  components?: Record<string, { deleted?: number }>;
  failedComponents?: string[];
  retrySafe?: boolean;
  deletedDurably?: boolean;
  error?: string;
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

function event(sessionId: string, eventId = randomUUID()): Record<string, unknown> {
  return {
    eventId,
    sessionId,
    employeeId: "op-trader-001",
    auditId: "audit-2026-q1",
    vectorId: "tv-1",
    eventType: "KEYSTROKE",
    timestamp: new Date().toISOString(),
    payload: { deltaMs: 120 },
    clientMetadata: { userAgent: "test", platform: "web" },
  };
}

/** Ingests one event, so the session exists durably with telemetry. */
async function seed(sessionId: string): Promise<void> {
  const res = await app.request("/api/v1/guardian/ingest", {
    method: "POST",
    headers: authorizedHeaders(),
    body: JSON.stringify({ events: [event(sessionId)] }),
  });
  assert.equal(res.status, 200, `ingest failed: ${await res.text()}`);
}

async function remove(sessionId: string): Promise<{ status: number; body: DeletionBody }> {
  const res = await app.request(`/api/v1/guardian/sessions/${sessionId}`, {
    method: "DELETE",
    headers: authorizedHeaders(),
  });
  return { status: res.status, body: (await res.json()) as DeletionBody };
}

describe("a complete deletion", () => {
  test("reports every component, and says it is complete", async () => {
    await seed("del-complete");

    const { status, body } = await remove("del-complete");

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.complete, true);
    assert.equal(body.partial, false);
    assert.deepEqual(body.failedComponents, []);
    assert.equal(body.deletedDurably, true);
    assert.equal(body.components?.["session"]?.deleted, 1);
    assert.equal(body.components?.["telemetry"]?.deleted, 1);
  });

  test("leaves nothing behind in any component", async () => {
    await seed("del-gone");

    await remove("del-gone");

    assert.equal(mcp.sessions.has("del-gone"), false);
    assert.equal(mcp.events.has("del-gone"), false);
    assert.equal(mcp.assessments.has("del-gone"), false);
  });

  test("a second call is 404, because nothing matched anywhere", async () => {
    await seed("del-twice");
    assert.equal((await remove("del-twice")).status, 200);

    const second = await remove("del-twice");

    assert.equal(second.status, 404);
    assert.equal(second.body.code, SESSION_TRANSITION_CODES.SESSION_NOT_FOUND);
  });
});

describe("a partial deletion", () => {
  test("is reported as partial, naming the component that failed", async () => {
    await seed("del-partial");
    mcp.failDeleteComponent("telemetry");

    const { status, body } = await remove("del-partial");

    assert.equal(
      status,
      500,
      "a partial deletion must not be reported with a success status",
    );
    assert.equal(body.code, SESSION_DELETION_CODES.PARTIAL_DELETE);
    assert.equal(body.complete, false);
    assert.equal(body.partial, true);
    assert.deepEqual(body.failedComponents, ["telemetry"]);
    assert.equal(body.retrySafe, true);
  });

  test("does not hide the components that did succeed", async () => {
    await seed("del-partial-honest");
    mcp.failDeleteComponent("telemetry");

    const { body } = await remove("del-partial-honest");

    // The assessments removal ran and is reported. Rolling it back, or reporting zero for
    // it because a sibling failed, would be a second wrong answer on top of the first.
    assert.equal(body.components?.["assessments"]?.deleted, 0, "none were seeded");
    assert.equal(
      body.components?.["telemetry"]?.deleted,
      0,
      "the failed component removed nothing",
    );
  });

  test("leaves the session identifiable and the caches untouched", async () => {
    await seed("del-partial-retry");
    mcp.failDeleteComponent("session");

    const { status, body } = await remove("del-partial-retry");
    assert.equal(status, 500);
    assert.deepEqual(body.failedComponents, ["session"]);

    // The derived documents are gone, and the session record is not: that is what makes
    // the operation retryable rather than orphaned.
    assert.equal(mcp.events.has("del-partial-retry"), false);
    assert.equal(mcp.sessions.has("del-partial-retry"), true);

    // The caches were not cleared, because the session is still durable.
    const detail = await app.request("/api/v1/guardian/sessions/del-partial-retry", {
      headers: authorizedHeaders(),
    });
    assert.equal(detail.status, 200, "a session that is still durable became unreadable");
  });

  test("retrying completes it, and the retry is safe", async () => {
    await seed("del-retry");
    mcp.failDeleteComponent("session");

    const first = await remove("del-retry");
    assert.equal(first.body.code, SESSION_DELETION_CODES.PARTIAL_DELETE);

    mcp.clearDeleteComponentFailures();
    const second = await remove("del-retry");

    assert.equal(second.status, 200, "the documented remedy did not finish the job");
    assert.equal(second.body.complete, true);
    assert.equal(second.body.deletedDurably, true);
    assert.equal(mcp.sessions.has("del-retry"), false);
  });

  test("a partial deletion is not the same answer as an unreachable store", async () => {
    await seed("del-distinct");
    mcp.failDeleteComponent("assessments");
    const partial = await remove("del-distinct");

    await seed("del-unreachable");
    mcp.failToolTransport("delete_session");
    const unreachable = await remove("del-unreachable");

    assert.equal(partial.status, 500);
    assert.equal(partial.body.code, SESSION_DELETION_CODES.PARTIAL_DELETE);
    assert.equal(partial.body.retrySafe, true);

    assert.equal(unreachable.status, 503);
    assert.equal(
      unreachable.body.code,
      SESSION_TRANSITION_CODES.SESSION_STORE_UNAVAILABLE,
      "an operation that never ran must not be reported as one that half-ran",
    );
    assert.equal(unreachable.body.components, undefined);
  });
});

describe("an unreachable store", () => {
  test("changes nothing, including the caches", async () => {
    await seed("del-down");
    mcp.failToolTransport("delete_session");

    const { status, body } = await remove("del-down");

    assert.equal(status, 503);
    assert.equal(body.code, SESSION_TRANSITION_CODES.SESSION_STORE_UNAVAILABLE);
    assert.equal(mcp.sessions.has("del-down"), true);

    const detail = await app.request("/api/v1/guardian/sessions/del-down", {
      headers: authorizedHeaders(),
    });
    assert.equal(detail.status, 200, "the session was hidden while it is still durable");
  });
});

describe("nonexistent-session semantics", () => {
  test("a session that never existed is 404", async () => {
    const { status, body } = await remove("del-unknown");

    assert.equal(status, 404);
    assert.equal(body.code, SESSION_TRANSITION_CODES.SESSION_NOT_FOUND);
    assert.equal(body.partial, undefined, "a not-found must not look like a partial delete");
  });

  test("a session that only exists in this process is 200", async () => {
    // `create_session` does not reach the store, which the deploy response reports as
    // `local-only`. There is nothing durable to remove, and the in-memory session is gone.
    mcp.failToolTransport("create_session");

    const deployed = await app.request("/api/v1/guardian/deploy", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        employeeUid: "op-trader-001",
        sessionId: "del-local-only",
        matrixId: "audit-local",
        targetSystem: "Core Ledger",
      }),
    });
    assert.equal(deployed.status, 201);
    const deployedBody = (await deployed.json()) as { mongoDocumentId: string };
    assert.equal(deployedBody.mongoDocumentId, "local-only");
    assert.equal(mcp.sessions.has("del-local-only"), false);

    const { status, body } = await remove("del-local-only");

    assert.equal(status, 200);
    assert.equal(body.deletedDurably, false);
    assert.equal(body.complete, true);
  });

  test("orphaned derived documents are cleaned up rather than reported as not-found", async () => {
    // The state a partial deletion leaves behind if the session record was removed by an
    // older build: telemetry with no session document. A delete must finish the job.
    mcp.seedEvent("del-orphan", {
      eventId: "orphan-1",
      sessionId: "del-orphan",
      eventType: "KEYSTROKE",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: { deltaMs: 120 },
    });
    assert.equal(mcp.sessions.has("del-orphan"), false);

    const { status, body } = await remove("del-orphan");

    assert.equal(status, 200, "an orphaned session's documents must still be removable");
    assert.equal(body.deletedDurably, false, "no session document existed to remove");
    assert.equal(body.components?.["telemetry"]?.deleted, 1);
    assert.equal(mcp.events.has("del-orphan"), false);
  });
});

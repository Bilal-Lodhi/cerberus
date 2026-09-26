/**
 * The live-detail reconciliation rule, and the two-process case it exists for.
 *
 * ── The defect ────────────────────────────────────────────────────────
 *
 * `GET /api/v1/guardian/sessions/:sessionId` answered from `sessionStore` whenever it held
 * the session and **never read the document**. With one process that was free: the process
 * holding the session was also the only writer. With two it was a false statement — a session
 * another process had terminated kept reading as `active` here while the review surface, which
 * reads MongoDB, said `terminated` about the same session. `session-detail-fallback.test.ts`
 * used to assert exactly that division and call it deliberate.
 *
 * The suite is in two halves, for the same reason the list's is: the merge is a pure function
 * with states that are awkward to produce through HTTP, and the route is the wiring that has
 * to actually call it.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  reconcileLiveDetail,
  type DurableDetailInput,
  type LocalLiveDetail,
} from "../src/services/session-reconciliation.js";
import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import { authorizedHeaders, installFetchStub, makeConfigWithTtl, type FetchStub } from "./helpers.js";
import { McpStoreDouble } from "./support/mcp-store-double.js";

// ═══════════════════════════════════════════════════════════════════
// The rule
// ═══════════════════════════════════════════════════════════════════

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const TTL_SECONDS = 3600;
const OPTIONS = { ttlSeconds: TTL_SECONDS, nowMs: NOW, alertThreshold: 75 };

function ago(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function localDetail(overrides: Partial<LocalLiveDetail> = {}): LocalLiveDetail {
  return {
    sessionId: "s1",
    employeeId: "op-1",
    matrixId: "audit-1",
    targetSystem: "Core Trading Ledger",
    status: "active",
    deployedAt: ago(60),
    lastActivityAt: ago(1),
    riskIndex: 0,
    eventCount: 0,
    pasteCount: 0,
    tabSwitchCount: 0,
    focusLossCount: 0,
    copyAttemptCount: 0,
    currentCode: "const x = 1;",
    lastRiskPayload: { overallRiskScore: 0 },
    ephemeralStateAvailable: true,
    ...overrides,
  };
}

function durableDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "s1",
    employeeId: "op-1",
    matrixId: "audit-1",
    targetSystem: "Core Trading Ledger",
    status: "active",
    eventCount: 0,
    pasteCount: 0,
    tabSwitchCount: 0,
    focusLossCount: 0,
    copyAttemptCount: 0,
    peakRiskScore: 0,
    deployedAt: ago(60),
    updatedAt: ago(1),
    ...overrides,
  };
}

function document(document: Record<string, unknown>): DurableDetailInput {
  return { kind: "document", document };
}

describe("the live-detail merge", () => {
  test("a durable termination overrides the status this process holds", () => {
    const result = reconcileLiveDetail(
      localDetail({ status: "active" }),
      document(durableDocument({ status: "terminated" })),
      OPTIONS,
    );

    assert.ok(result);
    assert.equal(result.session.status, "terminated");
    assert.equal(result.session.statusSource, "durable");
    assert.equal(result.reconciled, true);
  });

  test("the divergence is reported as a repair carrying the document", () => {
    const raw = durableDocument({ status: "terminated" });
    const result = reconcileLiveDetail(localDetail(), document(raw), OPTIONS);

    assert.ok(result?.repair);
    assert.equal(result.repair.status, "terminated");
    assert.equal(result.repair.durable, raw);
  });

  test("no repair is emitted when the cache already agrees", () => {
    const result = reconcileLiveDetail(
      localDetail({ status: "locked" }),
      document(durableDocument({ status: "locked" })),
      OPTIONS,
    );

    assert.equal(result?.repair, null);
  });

  test("a durable-only session is served from the document", () => {
    const result = reconcileLiveDetail(null, document(durableDocument()), OPTIONS);

    assert.ok(result);
    assert.equal(result.session.source, "durable");
    assert.equal(result.session.statusSource, "durable");
    assert.equal(result.session.currentCode, "");
    assert.equal(result.session.currentCodeLength, 0);
    assert.equal(result.session.lastRiskPayload, null);
    assert.equal(result.session.ephemeralStateAvailable, false);
  });

  test("a local-only session is kept, labelled process-local, and reconciled", () => {
    const result = reconcileLiveDetail(localDetail(), { kind: "absent" }, OPTIONS);

    assert.ok(result);
    assert.equal(result.session.statusSource, "process-local");
    // The store answered — it said there is no such document — so the response *was* checked
    // against durable truth. `reconciled` means "the store answered", not "a document exists".
    assert.equal(result.reconciled, true);
    assert.equal(result.session.source, "memory");
    assert.equal(result.session.ephemeralStateAvailable, true);
  });

  test("an unreachable store is reported as unreconciled, not as truth", () => {
    const result = reconcileLiveDetail(localDetail({ status: "locked" }), { kind: "unavailable" }, OPTIONS);

    assert.ok(result);
    assert.equal(result.reconciled, false);
    assert.equal(result.session.status, "locked");
    assert.equal(result.session.statusSource, "process-local");
  });

  test("neither source holding the session is null, which is the caller's 404", () => {
    assert.equal(reconcileLiveDetail(null, { kind: "absent" }, OPTIONS), null);
    assert.equal(reconcileLiveDetail(null, { kind: "unavailable" }, OPTIONS), null);
  });

  test("ephemeralStateAvailable follows the local view's own flag, not merely its presence", () => {
    // A session this process only *deployed* is in the registry: present locally, and holding
    // no workspace. Reporting `true` here would claim a workspace that does not exist. This is
    // the case a route test caught while the merge was being written.
    const registryOnly = reconcileLiveDetail(
      localDetail({ ephemeralStateAvailable: false, currentCode: "" }),
      { kind: "unavailable" },
      OPTIONS,
    );

    assert.equal(registryOnly?.session.ephemeralStateAvailable, false);
    assert.equal(registryOnly?.session.source, "memory");
  });

  test("counters take the larger of the two", () => {
    const result = reconcileLiveDetail(
      localDetail({ eventCount: 13, pasteCount: 9 }),
      document(durableDocument({ eventCount: 15, pasteCount: 4 })),
      OPTIONS,
    );

    assert.equal(result?.session.eventCount, 15);
    assert.equal(result?.session.pasteCount, 9);
  });

  test("a durable peak score this process never saw is reported", () => {
    const result = reconcileLiveDetail(
      localDetail({ riskIndex: 0 }),
      document(durableDocument({ peakRiskScore: 90 })),
      OPTIONS,
    );

    assert.equal(result?.session.peakRiskScore, 90);
    // The three risk fields are reported from the same value on every surface, as before.
    assert.equal(result?.session.riskIndex, 90);
    assert.equal(result?.session.overallRiskScore, 90);
  });

  test("a local score not yet persisted is not discarded", () => {
    const result = reconcileLiveDetail(
      localDetail({ riskIndex: 88 }),
      document(durableDocument({ peakRiskScore: 10 })),
      OPTIONS,
    );

    assert.equal(result?.session.peakRiskScore, 88);
  });

  test("liveness comes from the more recent activity instant, in both directions", () => {
    const durableFresh = reconcileLiveDetail(
      localDetail({ lastActivityAt: ago(120) }),
      document(durableDocument({ updatedAt: ago(1) })),
      OPTIONS,
    );
    assert.equal(durableFresh?.session.liveness, "active");

    const localFresh = reconcileLiveDetail(
      localDetail({ lastActivityAt: ago(1) }),
      document(durableDocument({ updatedAt: ago(120) })),
      OPTIONS,
    );
    assert.equal(localFresh?.session.liveness, "active");

    const bothStale = reconcileLiveDetail(
      localDetail({ lastActivityAt: ago(120) }),
      document(durableDocument({ updatedAt: ago(120) })),
      OPTIONS,
    );
    assert.equal(bothStale?.session.liveness, "expired");
  });

  test("identity comes from the document when it exists", () => {
    const result = reconcileLiveDetail(
      localDetail({ employeeId: "stale", matrixId: "stale", targetSystem: "stale" }),
      document(
        durableDocument({
          employeeId: "op-durable",
          matrixId: "audit-durable",
          targetSystem: "SWIFT Gateway",
        }),
      ),
      OPTIONS,
    );

    assert.equal(result?.session.employeeId, "op-durable");
    assert.equal(result?.session.matrixId, "audit-durable");
    assert.equal(result?.session.auditId, "audit-durable");
    assert.equal(result?.session.targetSystem, "SWIFT Gateway");
  });

  test("the deprecated fullscreenExitCount alias carries the same value", () => {
    const result = reconcileLiveDetail(
      localDetail({ focusLossCount: 2 }),
      document(durableDocument({ focusLossCount: 7 })),
      OPTIONS,
    );

    assert.equal(result?.session.focusLossCount, 7);
    assert.equal(result?.session.fullscreenExitCount, 7);
  });
});

// ═══════════════════════════════════════════════════════════════════
// The wiring, across two processes
// ═══════════════════════════════════════════════════════════════════

type App = ReturnType<typeof createApp>;

let stub: FetchStub;
let mcp: McpStoreDouble;
let processA: App;
let processB: App;

beforeEach(() => {
  resetAIProvider();
  mcp = new McpStoreDouble();
  stub = installFetchStub({ mcpResponse: mcp.responder() });
  const config = makeConfigWithTtl(3600);
  processA = createApp(config);
  processB = createApp(config);
});

afterEach(() => {
  stub.restore();
  resetAIProvider();
});

function keystroke(sessionId: string, eventId = randomUUID()): Record<string, unknown> {
  return {
    eventId,
    sessionId,
    employeeId: "op-trader-001",
    auditId: "audit-2026-q1",
    vectorId: "tv-1",
    eventType: "KEYSTROKE",
    timestamp: new Date().toISOString(),
    payload: { char: "x", deltaMs: 500 },
    clientMetadata: { userAgent: "test", platform: "web" },
  };
}

async function ingest(target: App, sessionId: string, events: Array<Record<string, unknown>>) {
  const response = await target.request("/api/v1/guardian/ingest", {
    method: "POST",
    headers: authorizedHeaders(),
    body: JSON.stringify({ events }),
  });
  if (response.status !== 200) {
    assert.fail(`ingest failed (${response.status}): ${await response.text()}`);
  }
}

interface DetailSession {
  sessionId: string;
  status: string;
  statusSource: string;
  reconciled: boolean;
  source: string;
  ephemeralStateAvailable: boolean;
  eventCount: number;
  peakRiskScore: number;
}

async function detail(target: App, sessionId: string) {
  const response = await target.request(`/api/v1/guardian/sessions/${sessionId}`, {
    headers: authorizedHeaders(),
  });
  const body = (await response.json()) as { session?: DetailSession };
  return { status: response.status, session: body.session };
}

describe("process A changes a session process B is holding", () => {
  test("process B's detail reports the durable status, not its own cache", async () => {
    await ingest(processB, "mwd-terminated", [keystroke("mwd-terminated")]);
    // Precondition: B holds it as active and its own detail agrees.
    assert.equal((await detail(processB, "mwd-terminated")).session?.status, "active");

    const terminated = await processA.request(
      "/api/v1/guardian/sessions/mwd-terminated/terminate",
      { method: "POST", headers: authorizedHeaders() },
    );
    assert.equal(terminated.status, 200, await terminated.text());

    const after = await detail(processB, "mwd-terminated");
    assert.equal(
      after.session?.status,
      "terminated",
      "process B's detail reported a status the durable document contradicts",
    );
    assert.equal(after.session?.statusSource, "durable");
  });

  test("the review surface and the live detail agree about the same session", async () => {
    await ingest(processB, "mwd-agree", [keystroke("mwd-agree")]);
    await processA.request("/api/v1/guardian/sessions/mwd-agree/terminate", {
      method: "POST",
      headers: authorizedHeaders(),
    });

    const live = await detail(processB, "mwd-agree");
    const review = await processB.request("/api/v1/sessions/mwd-agree", {
      headers: authorizedHeaders(),
    });
    const reviewBody = (await review.json()) as { data: { status: string } };

    assert.equal(live.session?.status, reviewBody.data.status);
  });

  test("the durable counters process A wrote are what process B's detail reports", async () => {
    await ingest(processA, "mwd-counters", [
      keystroke("mwd-counters"),
      keystroke("mwd-counters"),
      keystroke("mwd-counters"),
    ]);

    const row = await detail(processB, "mwd-counters");

    assert.equal(row.session?.eventCount, 3);
    // B holds no workspace, and says so rather than implying one.
    assert.equal(row.session?.ephemeralStateAvailable, false);
    assert.equal(row.session?.source, "durable");
  });

  test("process B's cache is repaired, so an unreachable store does not resurrect the status", async () => {
    await ingest(processB, "mwd-repair", [keystroke("mwd-repair")]);
    await processA.request("/api/v1/guardian/sessions/mwd-repair/terminate", {
      method: "POST",
      headers: authorizedHeaders(),
    });

    // The reconciled read repairs B's cache toward the document.
    assert.equal((await detail(processB, "mwd-repair")).session?.status, "terminated");

    mcp.failToolTransport("get_session_review", "mongo unreachable");
    const after = await detail(processB, "mwd-repair");

    assert.equal(after.session?.status, "terminated");
    assert.equal(after.session?.reconciled, false);
    assert.equal(after.session?.statusSource, "process-local");
  });

  test("a durably locked session is reported locked to the process that never saw the lock", async () => {
    await ingest(processA, "mwd-locked", [keystroke("mwd-locked")]);
    await mcp.setSessionStatus("mwd-locked", "locked");

    const row = await detail(processB, "mwd-locked");

    assert.equal(row.session?.status, "locked");
    assert.equal(row.session?.statusSource, "durable");
  });
});

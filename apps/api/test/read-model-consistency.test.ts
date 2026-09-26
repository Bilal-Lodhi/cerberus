/**
 * Read-model consistency across the four surfaces that answer for one session.
 *
 *   A  `GET /api/v1/guardian/sessions`     the live list
 *   B  `GET /api/v1/guardian/sessions/:id` the live detail
 *   C  `GET /api/v1/sessions`              the review list
 *   D  `GET /api/v1/sessions/:id`          the review detail
 *
 * Four surfaces, one session, and before this cycle they disagreed about it in four ways:
 *
 *   1. **Status vocabulary.** D overwrote its lifecycle status with `flagged` or
 *      `investigating`, so for a session scoring 52 the review detail said `flagged` while
 *      the review *list* said `active`. The console's review panel then treated `flagged`
 *      as `locked`, so it displayed LOCKED while the dashboard displayed active.
 *   2. **Counters.** B's registry branch reported zero for every counter, so a session
 *      deployed before a restart reported `eventCount: 0` there while A reported the
 *      durable total.
 *   3. **No counters at all on D**, so the console re-derived them by counting the
 *      timeline — which is capped, so a session with more than 500 events was
 *      under-reported on the review panel.
 *   4. **Liveness on a durable answer** was derived from the empty in-memory maps rather
 *      than from the durable activity instant.
 *
 * This suite asserts what must agree, and asserts the two differences that are deliberate:
 * A excludes a session that is no longer live, and D reports a `disposition` that is not a
 * lifecycle status.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import { createManualClock } from "../src/services/session-liveness.js";
import {
  authorizedHeaders,
  installFetchStub,
  makeConfigWithTtl,
  type FetchStub,
} from "./helpers.js";
import { McpStoreDouble } from "./support/mcp-store-double.js";

/** A risk reply that lands between the alert and the auto-lock thresholds. */
const FLAGGED_AI = JSON.stringify({
  riskAssessmentId: "66666666-6666-4666-8666-666666666666",
  overallRiskScore: 60,
  dimensionScores: { dataExfiltration: 60, policyViolation: 40 },
  flags: [],
  exfiltrationReport: null,
  behavioralAnomalies: [],
  generatedAt: "2026-01-01T00:00:00.000Z",
});

const HIGH_RISK_AI = JSON.stringify({
  riskAssessmentId: "77777777-7777-4777-8777-777777777777",
  overallRiskScore: 98,
  dimensionScores: { dataExfiltration: 98, policyViolation: 95 },
  flags: [],
  exfiltrationReport: null,
  behavioralAnomalies: [],
  generatedAt: "2026-01-01T00:00:00.000Z",
});

let stub: FetchStub;
let mcp: McpStoreDouble;
let app: ReturnType<typeof createApp>;

function installStack(aiResponse?: string): void {
  mcp = new McpStoreDouble();
  stub = installFetchStub({
    mcpResponse: mcp.responder(),
    ...(aiResponse ? { aiResponse } : {}),
  });
  app = createApp(makeConfigWithTtl(3600));
}

beforeEach(() => {
  resetAIProvider();
  installStack();
});

afterEach(() => {
  stub.restore();
  resetAIProvider();
});

function event(
  sessionId: string,
  eventType: string,
  payload: Record<string, unknown>,
  eventId = randomUUID(),
): Record<string, unknown> {
  return {
    eventId,
    sessionId,
    employeeId: "op-trader-001",
    auditId: "audit-2026-q1",
    vectorId: "tv-1",
    eventType,
    timestamp: new Date().toISOString(),
    payload,
    clientMetadata: { userAgent: "test", platform: "web" },
  };
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

interface Surfaces {
  liveList: Record<string, unknown> | undefined;
  liveDetail: Record<string, unknown> | undefined;
  reviewList: Record<string, unknown> | undefined;
  reviewDetail: Record<string, unknown> | undefined;
}

/** Fetches all four surfaces for one session. A missing entry is `undefined`. */
async function readAll(
  target: ReturnType<typeof createApp>,
  sessionId: string,
): Promise<Surfaces> {
  const [a, b, c, d] = await Promise.all([
    target.request("/api/v1/guardian/sessions", { headers: authorizedHeaders() }),
    target.request(`/api/v1/guardian/sessions/${sessionId}`, {
      headers: authorizedHeaders(),
    }),
    target.request("/api/v1/sessions", { headers: authorizedHeaders() }),
    target.request(`/api/v1/sessions/${sessionId}`, { headers: authorizedHeaders() }),
  ]);

  const liveListBody = (await a.json()) as { data?: Array<Record<string, unknown>> };
  const liveDetailBody = (await b.json()) as { session?: Record<string, unknown> };
  const reviewListBody = (await c.json()) as { data?: Array<Record<string, unknown>> };
  const reviewDetailBody = (await d.json()) as { data?: Record<string, unknown> };

  return {
    liveList: liveListBody.data?.find((row) => row["sessionId"] === sessionId),
    liveDetail: liveDetailBody.session,
    reviewList: reviewListBody.data?.find((row) => row["sessionId"] === sessionId),
    reviewDetail: reviewDetailBody.data,
  };
}

/** Asserts the four surfaces agree on every field that must agree. */
function assertAgreement(
  surfaces: Surfaces,
  options: { expectPresent?: boolean } = {},
): void {
  const { liveList, liveDetail, reviewList, reviewDetail } = surfaces;

  if (options.expectPresent !== false) {
    assert.ok(liveDetail, "the live detail did not answer");
    assert.ok(reviewList, "the review list lost the session");
    assert.ok(reviewDetail, "the review detail lost the session");
  }
  if (!liveDetail || !reviewList || !reviewDetail) return;

  // ── Status: one vocabulary on every surface ──
  for (const [name, value] of [
    ["live list", liveList?.["status"]],
    ["live detail", liveDetail["status"]],
    ["review list", reviewList["status"]],
    ["review detail", reviewDetail["status"]],
  ] as const) {
    if (value === undefined) continue;
    assert.ok(
      ["active", "locked", "terminated"].includes(String(value)),
      `${name} reported '${String(value)}', which is not a lifecycle status`,
    );
  }
  if (liveList) {
    assert.equal(liveDetail["status"], liveList["status"], "live detail vs live list");
    assert.equal(reviewList["status"], liveList["status"], "review list vs live list");
    assert.equal(reviewDetail["status"], liveList["status"], "review detail vs live list");
  }

  // ── Counters: the durable totals, on every surface that reports them ──
  if (liveList) {
    for (const field of [
      "eventCount",
      "pasteCount",
      "tabSwitchCount",
      "focusLossCount",
      "copyAttemptCount",
    ]) {
      assert.equal(liveDetail[field], liveList[field], `live detail ${field}`);
      assert.equal(reviewList[field], liveList[field], `review list ${field}`);
      assert.equal(
        reviewDetail[field],
        liveList[field],
        `review detail ${field} — a client must not have to count the timeline`,
      );
    }
    assert.equal(
      reviewDetail["fullscreenExitCount"],
      liveList["fullscreenExitCount"],
      "the deprecated alias must carry the same value everywhere",
    );
  }

  // ── Risk: the durable peak, and the latest assessment's score ──
  if (liveList) {
    assert.equal(liveDetail["peakRiskScore"], liveList["peakRiskScore"], "detail vs list peak");
    assert.equal(reviewList["peakRiskScore"], liveList["peakRiskScore"], "review list peak");
    assert.equal(reviewDetail["peakRiskScore"], liveList["peakRiskScore"], "review detail peak");
  }
  // `finalRiskScore` is a different quantity from the durable peak: it is the **latest**
  // assessment's score, so it can be lower than the peak when the score fell. What must
  // hold is that it is never higher, and that it equals the last entry of `riskSummary`.
  const finalScore = reviewDetail["finalRiskScore"];
  const peak = reviewDetail["peakRiskScore"];
  assert.equal(typeof finalScore, "number");
  assert.equal(typeof peak, "number");
  assert.ok(
    (finalScore as number) <= (peak as number),
    `the final score ${String(finalScore)} exceeded the durable peak ${String(peak)}`,
  );
  const summary = reviewDetail["riskSummary"] as Array<Record<string, unknown>>;
  if (summary.length > 0) {
    assert.equal(
      finalScore,
      summary[summary.length - 1]["overallRiskScore"],
      "the final score must be the latest assessment's score",
    );
  }

  // ── Identity ──
  assert.equal(liveDetail["employeeId"], reviewDetail["employeeId"]);
  assert.equal(reviewList["employeeId"], reviewDetail["employeeId"]);
  assert.equal(liveDetail["auditId"], reviewDetail["auditId"]);
  if (liveList) assert.equal(liveList["employeeId"], reviewDetail["employeeId"]);

  // ── Liveness ──
  for (const [name, value] of [
    ["live detail", liveDetail["liveness"]],
    ["review list", reviewList["liveness"]],
    ["review detail", reviewDetail["liveness"]],
  ] as const) {
    assert.ok(
      value === "active" || value === "expired",
      `${name} reported liveness '${String(value)}'`,
    );
  }
  assert.equal(liveDetail["liveness"], reviewDetail["liveness"]);
  assert.equal(reviewList["liveness"], reviewDetail["liveness"]);
}

describe("a live session", () => {
  test("all four surfaces agree on status, counters, risk and liveness", async () => {
    const sessionId = "rm-live";
    await ingest(app, sessionId, [
      event(sessionId, "KEYSTROKE", { deltaMs: 120 }),
      event(sessionId, "TAB_SWITCH", { visibilityState: "hidden" }),
      event(sessionId, "PASTE_TRIGGER", { pasteContent: "x".repeat(60) }),
    ]);

    assertAgreement(await readAll(app, sessionId));

    const surfaces = await readAll(app, sessionId);
    assert.equal(surfaces.liveList?.["status"], "active");
    assert.equal(surfaces.reviewDetail?.["disposition"], "none");
  });

  test("the review detail's disposition is never a lifecycle status", async () => {
    const sessionId = "rm-disposition";
    await ingest(app, sessionId, [event(sessionId, "KEYSTROKE", { deltaMs: 120 })]);

    const { reviewDetail } = await readAll(app, sessionId);
    assert.ok(reviewDetail);
    assert.equal(reviewDetail["status"], "active");
    assert.equal(reviewDetail["disposition"], "none");
  });
});

describe("a session the evidence flags but the lifecycle does not lock", () => {
  test("reports `active` everywhere, with `flagged` as the disposition", async () => {
    installStack(FLAGGED_AI);
    const sessionId = "rm-flagged";
    // A large paste triggers analysis; a semantic score of 60 blends to 52, which is
    // above the alert threshold and below the auto-lock threshold.
    await ingest(app, sessionId, [
      event(sessionId, "PASTE", { newText: "x".repeat(400), changeLength: 400 }),
    ]);

    const surfaces = await readAll(app, sessionId);
    assert.ok(surfaces.reviewDetail);

    assert.equal(
      surfaces.reviewDetail["status"],
      "active",
      "a flagged session is not a lifecycle state — this is the conflation the split removes",
    );
    assert.equal(surfaces.reviewDetail["disposition"], "flagged");
    assert.equal(
      surfaces.liveList?.["status"],
      "active",
      "the live list and the review detail must not disagree about whether this is locked",
    );

    assertAgreement(surfaces);
  });

  test("the console's `isLocked` reading of the response is false for it", async () => {
    installStack(FLAGGED_AI);
    const sessionId = "rm-not-locked";
    await ingest(app, sessionId, [
      event(sessionId, "PASTE", { newText: "x".repeat(400), changeLength: 400 }),
    ]);

    const { reviewDetail } = await readAll(app, sessionId);
    assert.ok(reviewDetail);
    // The console derives `isLocked` from `status`. Before the split, `status` was
    // `flagged` here and the panel displayed LOCKED for a session that is not locked.
    assert.equal(reviewDetail["status"] === "locked", false);
  });
});

describe("a session with a submission but no alert", () => {
  test("reports `investigating` as the disposition, and `active` as the status", async () => {
    const sessionId = "rm-investigating";
    await ingest(app, sessionId, [
      event(sessionId, "SUBMIT", { pasteContent: "short" }),
    ]);

    const { reviewDetail } = await readAll(app, sessionId);
    assert.ok(reviewDetail);
    assert.equal(reviewDetail["status"], "active");
    assert.equal(reviewDetail["disposition"], "investigating");
  });
});

describe("a locked session", () => {
  test("every surface reports `locked`, and the disposition is separate", async () => {
    installStack(HIGH_RISK_AI);
    const sessionId = "rm-locked";
    await ingest(app, sessionId, [
      event(sessionId, "PASTE", { newText: "x".repeat(400), changeLength: 400 }),
    ]);

    const surfaces = await readAll(app, sessionId);
    assert.equal(surfaces.liveList?.["status"], "locked");
    assert.equal(surfaces.reviewDetail?.["disposition"], "flagged");
    assertAgreement(surfaces);
  });
});

describe("a terminated session", () => {
  test("is excluded from the live list but present and terminated everywhere else", async () => {
    const sessionId = "rm-terminated";
    await ingest(app, sessionId, [event(sessionId, "KEYSTROKE", { deltaMs: 120 })]);
    const terminated = await app.request(
      `/api/v1/guardian/sessions/${sessionId}/terminate`,
      { method: "POST", headers: authorizedHeaders() },
    );
    assert.equal(terminated.status, 200);

    const surfaces = await readAll(app, sessionId);

    assert.equal(
      surfaces.liveList,
      undefined,
      "a terminated session is not live and must leave the live list",
    );
    assert.equal(surfaces.liveDetail?.["status"], "terminated");
    assert.equal(surfaces.reviewList?.["status"], "terminated");
    assert.equal(surfaces.reviewDetail?.["status"], "terminated");
    assertAgreement(surfaces);
  });
});

describe("an expired session", () => {
  test("is excluded from the live list but present and readable everywhere else", async () => {
    mcp.seedSession({
      sessionId: "rm-expired",
      status: "active",
      employeeId: "op-trader-001",
      matrixId: "audit-2026-q1",
      eventCount: 5,
      pasteCount: 2,
      focusLossCount: 1,
      peakRiskScore: 40,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const later = createApp(makeConfigWithTtl(60), {
      clock: createManualClock(Date.parse("2026-01-01T01:00:00.000Z")),
    });
    const surfaces = await readAll(later, "rm-expired");

    assert.equal(
      surfaces.liveList,
      undefined,
      "expiry stops monitoring, so an expired session is not live",
    );
    assert.equal(surfaces.liveDetail?.["liveness"], "expired");
    assert.equal(surfaces.reviewList?.["liveness"], "expired");
    assert.equal(surfaces.reviewDetail?.["liveness"], "expired");
    assert.equal(surfaces.reviewDetail?.["eventCount"], 5);
    assertAgreement(surfaces);
  });
});

describe("after a restart", () => {
  test("the four surfaces still agree, with no recovery step first", async () => {
    installStack(HIGH_RISK_AI);
    const sessionId = "rm-restart";
    await ingest(app, sessionId, [
      event(sessionId, "PASTE", { newText: "x".repeat(400), changeLength: 400 }),
      event(sessionId, "WINDOW_BLUR", {}),
    ]);

    const restarted = createApp(makeConfigWithTtl(3600));
    const surfaces = await readAll(restarted, sessionId);

    assert.equal(surfaces.liveDetail?.["status"], "locked");
    assert.equal(surfaces.liveDetail?.["source"], "durable");
    assert.equal(surfaces.reviewDetail?.["disposition"], "flagged");
    assertAgreement(surfaces);
  });
});

describe("the timeline is not a counter", () => {
  test("a session with more events than the timeline window says so", async () => {
    // The durable total is seeded above what a bounded timeline can hold, so the two
    // numbers must differ and the response must say which is which.
    mcp.seedSession({
      sessionId: "rm-truncated",
      status: "active",
      employeeId: "op-trader-001",
      matrixId: "audit-2026-q1",
      eventCount: 900,
      pasteCount: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    mcp.seedEvent("rm-truncated", {
      eventId: "only-one",
      sessionId: "rm-truncated",
      eventType: "KEYSTROKE",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: { deltaMs: 120 },
    });

    const { reviewDetail } = await readAll(app, "rm-truncated");
    assert.ok(reviewDetail);
    assert.equal(
      reviewDetail["eventCount"],
      900,
      "the durable total, not the number of events the timeline happens to hold",
    );
    assert.equal(
      reviewDetail["timelineTruncated"],
      true,
      "the response must say that the timeline is not the whole history",
    );
    assert.equal((reviewDetail["timeline"] as unknown[]).length, 1);
  });
});

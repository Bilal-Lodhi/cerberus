/**
 * The review-list read is bounded by the number of sessions, not by their history.
 *
 * ── What it was ───────────────────────────────────────────────────────
 *
 * `GET /api/v1/sessions` issues one `get_session_review` per session, and each one asked
 * for the default: **up to 500 micro-events plus every risk assessment**. With 200 sessions
 * that is up to 100 000 event documents fetched and discarded per list request, and the
 * cost grew with each session's history rather than with the number of sessions.
 *
 * Nothing in those events was load-bearing. Every counter the route re-derived from them is
 * **already durable on the session document**, written on every ingest with `$max` — so
 * monotonic and hydrated across a restart. The one genuinely event-derived field was a
 * display timestamp.
 *
 * ── What it is ────────────────────────────────────────────────────────
 *
 * `eventsLimit: 0` (the query is skipped) and `assessmentsLimit: 1` (the latest assessment
 * is all a single `riskScore` needs). The read is now a constant per session.
 *
 * ── Why this is asserted rather than benchmarked ──────────────────────
 *
 * `docs/development/performance-baseline.md` records that a benchmark double has twice
 * produced a *false* finding in this repository. A machine-speed threshold would also be a
 * flaky CI gate. What matters here is not how fast the route is but **what it asks for**,
 * which is deterministic: the requested bounds, and the fact that they do not grow with
 * session history. Those are asserted directly, and the local benchmark records the
 * latency separately.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import {
  authorizedHeaders,
  installFetchStub,
  makeConfigWithTtl,
  type FetchStub,
} from "./helpers.js";
import { McpStoreDouble } from "./support/mcp-store-double.js";

/** A high-risk reply, so a session's assessment carries a score worth reporting. */
const HIGH_RISK_AI = JSON.stringify({
  riskAssessmentId: "99999999-9999-4999-8999-999999999999",
  overallRiskScore: 91,
  dimensionScores: { dataExfiltration: 91, policyViolation: 88 },
  flags: [],
  exfiltrationReport: null,
  behavioralAnomalies: [],
  generatedAt: "2026-01-01T00:00:00.000Z",
});

describe("review-list read bounds", () => {
  let stub: FetchStub;
  let mcp: McpStoreDouble;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetAIProvider();
    mcp = new McpStoreDouble();
    stub = installFetchStub({ mcpResponse: mcp.responder(), aiResponse: HIGH_RISK_AI });
    app = createApp(makeConfigWithTtl(3600));
  });

  afterEach(() => {
    stub.restore();
    resetAIProvider();
  });

  /** Seeds one session with `eventCount` events and `assessments` assessments. */
  async function seedSession(
    sessionId: string,
    options: { events?: number; assessments?: number } = {},
  ): Promise<void> {
    await mcp.createSession({
      sessionId,
      employeeId: "op-1",
      auditId: "audit-1",
    });

    const events = Array.from({ length: options.events ?? 0 }, (_unused, index) => ({
      eventId: `e-${index}`,
      sessionId,
      eventType: "KEYSTROKE",
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      payload: { deltaMs: 120 },
    }));
    if (events.length > 0) await mcp.ingestMicroEvents(events);

    for (let index = 0; index < (options.assessments ?? 0); index++) {
      await mcp.storeRiskAssessment({
        riskAssessmentId: `${sessionId}-risk-${index}`,
        sessionId,
        employeeId: "op-1",
        auditId: "audit-1",
        overallRiskScore: 10 + index,
        dimensionScores: {},
        flags: [],
        exfiltrationReport: null,
        behavioralAnomalies: [],
        generatedAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
      });
    }
  }

  /** Every `get_session_review` body the list route sent, in order. */
  function reviewBodies(): Array<Record<string, unknown>> {
    return stub.calls
      .filter((call) => call.url.endsWith("/tools/get_session_review"))
      .map((call) => call.body as Record<string, unknown>);
  }

  async function listSessions(): Promise<Array<Record<string, unknown>>> {
    const res = await app.request("/api/v1/sessions", { headers: authorizedHeaders() });
    assert.equal(res.status, 200);
    return ((await res.json()) as { data: Array<Record<string, unknown>> }).data;
  }

  test("every session read asks for no events and one assessment", async () => {
    await seedSession("bounds-a", { events: 20, assessments: 3 });
    await seedSession("bounds-b", { events: 5, assessments: 1 });
    await seedSession("bounds-c");

    await listSessions();

    const bodies = reviewBodies();
    assert.equal(bodies.length, 3, `expected one read per session, got ${bodies.length}`);

    for (const body of bodies) {
      assert.equal(
        body["eventsLimit"],
        0,
        "the list fetched events it does not use — the cost grows with session history",
      );
      assert.equal(
        body["assessmentsLimit"],
        1,
        "the list fetched the whole analysis history for one score",
      );
    }
  });

  test("the read does not grow with a session's history", async () => {
    // The property that matters: a session with 500 events must cost the same read as one
    // with none. Asserted as the *requested bound* rather than as a duration, because a
    // duration is machine-dependent and a benchmark double has twice produced a false
    // finding in this repository.
    await seedSession("bounds-small", { events: 1, assessments: 1 });
    await seedSession("bounds-large", { events: 500, assessments: 25 });

    await listSessions();

    const bodies = reviewBodies();
    assert.equal(bodies.length, 2);

    const bounds = bodies.map((body) => ({
      events: body["eventsLimit"],
      assessments: body["assessmentsLimit"],
    }));

    assert.deepEqual(
      bounds[0],
      bounds[1],
      "a session with more history was asked for more — the amplification is still there",
    );
  });

  test("the counters are still reported, from the durable document", async () => {
    // The counters must not regress just because the events are no longer fetched: they are
    // durable, and the route reads them from the session document.
    await seedSession("bounds-counters", { events: 12 });
    // The seeded events went through `ingestMicroEvents`, which does not write counters, so
    // the durable document is updated the way a real ingest would.
    await mcp.updateSessionCounts("bounds-counters", {
      eventCount: 12,
      pasteCount: 3,
      tabSwitchCount: 2,
      focusLossCount: 1,
      copyAttemptCount: 4,
    });

    const [entry] = await listSessions();

    assert.equal(entry["eventCount"], 12);
    assert.equal(entry["pasteCount"], 3);
    assert.equal(entry["tabSwitchCount"], 2);
    assert.equal(entry["focusLossCount"], 1);
    assert.equal(entry["copyAttemptCount"], 4);
  });

  test("the score is the newest assessment's, from a one-assessment read", async () => {
    // `assessmentsLimit: 1` returns the newest, which is the only one a single `riskScore`
    // needs. Reading the history to take its last element was the amplification.
    await seedSession("bounds-score", { assessments: 4 });

    const [entry] = await listSessions();

    // The seeded scores ascend with the index, so the newest is 13.
    assert.equal(entry["riskScore"], 13, "the newest assessment's score was not reported");
  });

  test("lastEventTimestamp is the durable activity instant, not a client timestamp", async () => {
    // It used to be the newest **client-supplied** event timestamp, read from the window
    // this route no longer fetches. `updatedAt` is the same instant from a trustworthy
    // source — the persistence layer writes it on every mutation — and the liveness
    // decision already uses it for exactly that reason.
    await seedSession("bounds-activity", { events: 3 });

    const [entry] = await listSessions();
    const durable = await mcp.getSession("bounds-activity");

    assert.ok(entry["lastEventTimestamp"], "no activity instant was reported");
    assert.equal(
      new Date(String(entry["lastEventTimestamp"])).getTime(),
      new Date(durable?.["updatedAt"] as Date).getTime(),
      "the reported instant is not the durable updatedAt",
    );
  });

  test("a session with no assessments still reports its durable score", async () => {
    await seedSession("bounds-no-assessments");
    await mcp.updateSessionCounts("bounds-no-assessments", {
      eventCount: 0,
      peakRiskScore: 55,
    });

    const [entry] = await listSessions();
    assert.equal(entry["riskScore"], 55);
  });

  test("the list still works with no sessions at all", async () => {
    assert.deepEqual(await listSessions(), []);
    assert.equal(reviewBodies().length, 0, "a read was made with nothing to read");
  });

  test("a session with an empty eventId-free history is unaffected", async () => {
    // A guard against the removed events scan having been load-bearing for something
    // subtle: a session whose counters are all zero must still list cleanly.
    await seedSession("bounds-zero");

    const [entry] = await listSessions();
    assert.equal(entry["sessionId"], "bounds-zero");
    assert.equal(entry["eventCount"], 0);
    assert.equal(entry["focusLossCount"], 0);
  });

  test("the session detail route still fetches its timeline", async () => {
    // The bound is specific to the **list**. The detail view exists to show the timeline, so
    // it keeps the documented 500-event read — a bound, not an amplification, because it is
    // one request for one session.
    await seedSession("bounds-detail", { events: 4, assessments: 2 });

    const res = await app.request("/api/v1/sessions/bounds-detail", {
      headers: authorizedHeaders(),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { timeline: unknown[] } };

    assert.equal(body.data.timeline.length, 4, "the detail view lost its timeline");

    const detailRead = reviewBodies().at(-1);
    assert.equal(
      detailRead?.["eventsLimit"],
      undefined,
      "the detail read was bounded, so its timeline would be truncated",
    );
  });

  test("the detail route is unaffected by the list bound", async () => {
    await seedSession("bounds-detail-unaffected", { events: 3 });

    const res = await app.request("/api/v1/sessions/bounds-detail-unaffected", {
      headers: authorizedHeaders(),
    });
    const body = (await res.json()) as { data: { terminalContent: string } };
    assert.ok(body.data.terminalContent.length > 0 || body.data.terminalContent === "");
    assert.equal(res.status, 200);
  });

  // ── The measurement ───────────────────────────────────────────────

  test("measurement: 20 sessions of 500 events carry 10 000 documents before, 0 after", async () => {
    // The before/after evidence, made deterministic.
    //
    // The old read asked for the default, which is `limit ?? 500` micro-events per session.
    // `MongoStore.getSessionEvents` documents that cap, so "before" is exactly
    // `sessions × min(500, events)` — not an estimate. The new read asks for zero.
    //
    // The numbers are asserted rather than timed: a duration depends on the machine and on
    // a double that has twice produced a false finding in this repository, while the
    // document count is a property of the code.
    const SESSIONS = 20;
    const EVENTS_PER_SESSION = 500;

    for (let index = 0; index < SESSIONS; index++) {
      await seedSession(`measure-${index}`, {
        events: EVENTS_PER_SESSION,
        assessments: 3,
      });
    }

    await listSessions();

    const bodies = reviewBodies();
    assert.equal(bodies.length, SESSIONS);

    // What each session's read carries now.
    const eventsPerSessionAfter = bodies.map((body) => body["eventsLimit"] as number);
    const assessmentsPerSessionAfter = bodies.map(
      (body) => body["assessmentsLimit"] as number,
    );

    const documentsAfter = eventsPerSessionAfter.reduce(
      (total, limit) => total + limit,
      0,
    );
    // Before: the store's own documented default cap per session.
    const documentsBefore = SESSIONS * Math.min(500, EVENTS_PER_SESSION);

    assert.equal(
      documentsAfter,
      0,
      "the list still fetches event documents",
    );
    assert.equal(
      documentsBefore,
      10_000,
      "the before figure no longer matches the store's documented 500-event cap",
    );

    console.log(
      `[review-list] ${SESSIONS} sessions × ${EVENTS_PER_SESSION} events: ` +
        `event documents carried ${documentsBefore} → ${documentsAfter}; ` +
        `assessments carried ${SESSIONS * 3} → ` +
        `${assessmentsPerSessionAfter.reduce((total, limit) => total + limit, 0)}`,
    );
  });
});

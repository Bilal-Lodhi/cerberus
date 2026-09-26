/**
 * The focus-loss vocabulary correction.
 *
 * ── What was wrong ────────────────────────────────────────────────────
 *
 * `applyEventToSession` treated `WINDOW_BLUR` and `FULLSCREEN_EXIT` identically and
 * incremented one counter, which was named `fullscreenExitCount`. So the field name
 * described **one of the two events that produced it**: a window blur that was never a
 * fullscreen exit was counted as one, and the incident summary said "fullscreen exit
 * detected" for what may have been a blur.
 *
 * Browser telemetry cannot distinguish the two — a blur is reported when focus leaves the
 * window for any reason — so the counter has always measured *focus loss*, and the
 * truthful name is the one that covers what it measures.
 *
 * ── What did NOT change ───────────────────────────────────────────────
 *
 * The **score contribution**. `fullscreenPenalty` was gated on `count > 0`, which is
 * "focus was lost", never on "fullscreen was exited". So this corrects a name rather than
 * a behaviour, and no score moves. These tests pin that explicitly, because a silent
 * scoring change would be the worst possible outcome of a rename.
 *
 * ── Compatibility ─────────────────────────────────────────────────────
 *
 * The old names are kept where they are cheap and where a caller may depend on them:
 *
 *   - the API responses carry `fullscreenExitCount` alongside `focusLossCount`, same value;
 *   - `update_session_counts` accepts either spelling and writes one durable field;
 *   - `behavioralContext` carries `totalFullscreenExits` alongside `totalFocusLosses`;
 *   - a durable document that still holds the legacy field is read through a fallback.
 *
 * Migration `0003` renames the durable field. See `docs/migration.md`.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  FOCUS_LOSS_FIELD,
  buildSessionCountsUpdate,
} from "../../../packages/mcp-mongodb/src/mongo-client.js";
import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import { applyEventToSession, type SessionState } from "../src/routes/guardian.js";
import {
  authorizedHeaders,
  installFetchStub,
  makeConfigWithTtl,
  type FetchStub,
} from "./helpers.js";
import { McpStoreDouble } from "./support/mcp-store-double.js";

/** A high-risk reply, so the analysis path runs and produces a payload. */
const HIGH_RISK_AI = JSON.stringify({
  riskAssessmentId: "77777777-7777-4777-8777-777777777777",
  overallRiskScore: 96,
  dimensionScores: { dataExfiltration: 96, policyViolation: 90 },
  flags: [],
  exfiltrationReport: null,
  behavioralAnomalies: [],
  generatedAt: "2026-01-01T00:00:00.000Z",
});

/** A minimal session, for the pure event-application tests. */
function makeSession(): SessionState {
  return {
    sessionId: "ses-1",
    employeeId: "op-1",
    auditId: "audit-1",
    events: [],
    currentCode: "x".repeat(60),
    pasteCount: 0,
    keystrokeDeltas: [],
    tabSwitchCount: 0,
    focusLossCount: 0,
    copyAttemptCount: 0,
    lastRiskPayload: null,
    eventCount: 0,
    status: "active",
    lastAnalyzedCodeHash: "",
    recentEventFingerprints: new Set(),
  };
}

function microEvent(eventType: string): Parameters<typeof applyEventToSession>[1] {
  return {
    eventId: randomUUID(),
    sessionId: "ses-1",
    employeeId: "op-1",
    auditId: "audit-1",
    vectorId: "tv-1",
    eventType: eventType as Parameters<typeof applyEventToSession>[1]["eventType"],
    timestamp: new Date().toISOString(),
    payload: {},
    clientMetadata: { userAgent: "t", ipAddress: "127.0.0.1", screenResolution: "1x1", platform: "web", language: "en" },
  };
}

// ═══════════════════════════════════════════════════════════════════
// The counter itself
// ═══════════════════════════════════════════════════════════════════

describe("focus-loss counter", () => {
  test("WINDOW_BLUR and FULLSCREEN_EXIT increment one counter", () => {
    // The whole reason for the rename: one counter, two event types, and a name that
    // described only one of them.
    const session = makeSession();
    applyEventToSession(session, microEvent("WINDOW_BLUR"));
    applyEventToSession(session, microEvent("FULLSCREEN_EXIT"));

    assert.equal(session.focusLossCount, 2);
  });

  test("WINDOW_BLUR alone increments it", () => {
    // A blur is not a fullscreen exit, and the old name said it was.
    const session = makeSession();
    applyEventToSession(session, microEvent("WINDOW_BLUR"));

    assert.equal(
      session.focusLossCount,
      1,
      "a window blur was not counted, or was counted under the wrong name",
    );
  });

  test("a signal that is not focus loss does not increment it", () => {
    const session = makeSession();
    for (const type of ["KEYSTROKE", "TAB_SWITCH", "COPY_ATTEMPT", "SUBMIT"]) {
      applyEventToSession(session, microEvent(type));
    }

    assert.equal(session.focusLossCount, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// The durable update document
// ═══════════════════════════════════════════════════════════════════

describe("the focus-loss field in the counts update", () => {
  test("the canonical name is written", () => {
    const update = buildSessionCountsUpdate({ eventCount: 1, focusLossCount: 3 });
    assert.equal((update["$max"] as Record<string, unknown>)[FOCUS_LOSS_FIELD], 3);
  });

  test("the deprecated name writes the same field", () => {
    const update = buildSessionCountsUpdate({ eventCount: 1, fullscreenExitCount: 3 });
    assert.equal((update["$max"] as Record<string, unknown>)[FOCUS_LOSS_FIELD], 3);
    assert.equal(
      (update["$max"] as Record<string, unknown>)["fullscreenExitCount"],
      undefined,
      "the deprecated spelling created a second durable field",
    );
  });

  test("sending both cannot lower the total", () => {
    // A caller mid-migration might send both. The larger wins, so neither spelling can
    // regress the counter.
    const update = buildSessionCountsUpdate({
      eventCount: 1,
      focusLossCount: 2,
      fullscreenExitCount: 7,
    });
    assert.equal((update["$max"] as Record<string, unknown>)[FOCUS_LOSS_FIELD], 7);
  });

  test("neither spelling leaves the field out entirely", () => {
    const update = buildSessionCountsUpdate({ eventCount: 1, pasteCount: 2 });
    assert.equal(
      (update["$max"] as Record<string, unknown>)[FOCUS_LOSS_FIELD],
      undefined,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// The routes
// ═══════════════════════════════════════════════════════════════════

describe("focus-loss through the API", () => {
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

  /** A large paste, so the analysis trigger fires and a payload is produced. */
  function largePaste(sessionId: string, eventId = randomUUID()): Record<string, unknown> {
    return {
      eventId,
      sessionId,
      employeeId: "op-trader-001",
      auditId: "audit-2026-q1",
      vectorId: "tv-1",
      eventType: "PASTE",
      timestamp: new Date().toISOString(),
      payload: { newText: "x".repeat(400), changeLength: 400 },
      clientMetadata: { userAgent: "t", platform: "web" },
    };
  }

  function focusLossEvent(sessionId: string, eventType: string): Record<string, unknown> {
    return {
      eventId: randomUUID(),
      sessionId,
      employeeId: "op-trader-001",
      auditId: "audit-2026-q1",
      vectorId: "tv-1",
      eventType,
      timestamp: new Date().toISOString(),
      payload: {},
      clientMetadata: { userAgent: "t", platform: "web" },
    };
  }

  async function post(sessionId: string, events: Array<Record<string, unknown>>): Promise<void> {
    const res = await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events }),
    });
    assert.equal(res.status, 200);
  }

  async function ingestFocusLoss(sessionId: string, eventType: string): Promise<void> {
    await post(sessionId, [focusLossEvent(sessionId, eventType)]);
  }

  /**
   * A paste plus a focus-loss event in one batch.
   *
   * The paste sets the workspace, which is what the analysis trigger requires — a
   * focus-loss event alone does not set `currentCode`, so no analysis would run and there
   * would be no payload to assert against. Order matters: the events are applied in
   * order, so the counter is already 1 when the analysis reads it.
   */
  async function ingestWithAnalysis(sessionId: string, eventType: string): Promise<void> {
    await post(sessionId, [largePaste(sessionId), focusLossEvent(sessionId, eventType)]);
  }

  test("the durable counter is written under the canonical name", async () => {
    await ingestFocusLoss("voc-durable", "WINDOW_BLUR");

    assert.equal(
      mcp.sessions.get("voc-durable")?.["focusLossCount"],
      1,
      "the counter was not written under the canonical name",
    );
  });

  test("the session detail exposes both names with the same value", async () => {
    await ingestFocusLoss("voc-detail", "WINDOW_BLUR");

    const res = await app.request("/api/v1/guardian/sessions/voc-detail", {
      headers: authorizedHeaders(),
    });
    const body = (await res.json()) as {
      session: { focusLossCount: number; fullscreenExitCount: number };
    };

    assert.equal(body.session.focusLossCount, 1);
    assert.equal(
      body.session.fullscreenExitCount,
      1,
      "the deprecated alias was dropped, breaking an existing console or script",
    );
  });

  test("the live list exposes both names", async () => {
    await ingestFocusLoss("voc-list", "FULLSCREEN_EXIT");

    const res = await app.request("/api/v1/guardian/sessions", {
      headers: authorizedHeaders(),
    });
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    const entry = body.data.find((row) => row["sessionId"] === "voc-list");

    assert.ok(entry);
    assert.equal(entry["focusLossCount"], 1);
    assert.equal(entry["fullscreenExitCount"], 1);
  });

  test("the review list exposes both names", async () => {
    await ingestFocusLoss("voc-review", "WINDOW_BLUR");

    const res = await app.request("/api/v1/sessions", { headers: authorizedHeaders() });
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    const entry = body.data.find((row) => row["sessionId"] === "voc-review");

    assert.ok(entry);
    assert.equal(entry["focusLossCount"], 1);
    assert.equal(entry["fullscreenExitCount"], 1);
  });

  test("a durable document holding only the legacy field still reports it", async () => {
    // A deployment that has not run migration 0003. Reporting zero here would lose the
    // counter entirely, which is worse than the naming problem being fixed.
    //
    // Asserted through the **live list**, which is the in-memory surface that recovers from
    // MongoDB. `GET /guardian/sessions/:id` reads memory only and has no durable fallback —
    // a gap recorded in `docs/development/state-transition-model.md`, not asserted here.
    mcp.seedSession({
      sessionId: "voc-legacy",
      status: "active",
      employeeId: "op-trader-001",
      fullscreenExitCount: 4,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const res = await app.request("/api/v1/guardian/sessions", {
      headers: authorizedHeaders(),
    });
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    const entry = body.data.find((row) => row["sessionId"] === "voc-legacy");

    assert.ok(entry, "the legacy document was not recovered");
    assert.equal(entry["focusLossCount"], 4);
  });

  test("a document holding both fields reports the larger", async () => {
    mcp.seedSession({
      sessionId: "voc-both",
      status: "active",
      employeeId: "op-trader-001",
      focusLossCount: 2,
      fullscreenExitCount: 5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const res = await app.request("/api/v1/guardian/sessions", {
      headers: authorizedHeaders(),
    });
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    const entry = body.data.find((row) => row["sessionId"] === "voc-both");

    assert.ok(entry);
    assert.equal(entry["focusLossCount"], 5, "a lower total won over a higher one");
  });

  test("the incident summary says 'focus lost', not 'fullscreen exit detected'", async () => {
    // The summary described a fullscreen exit for what may have been a window blur.
    await ingestWithAnalysis("voc-summary", "WINDOW_BLUR");

    const res = await app.request("/api/v1/guardian/sessions/voc-summary", {
      headers: authorizedHeaders(),
    });
    const body = (await res.json()) as {
      session: { lastRiskPayload: { incidentSummary?: string } | null };
    };

    const summary = body.session.lastRiskPayload?.incidentSummary ?? "";
    assert.match(summary, /focus lost/);
    assert.doesNotMatch(
      summary,
      /fullscreen exit detected/,
      "the summary still claims a fullscreen exit for a window blur",
    );
  });

  test("behavioralContext carries both names with the same value", async () => {
    await ingestWithAnalysis("voc-context", "WINDOW_BLUR");

    const res = await app.request("/api/v1/guardian/sessions/voc-context", {
      headers: authorizedHeaders(),
    });
    const body = (await res.json()) as {
      session: {
        lastRiskPayload: {
          behavioralContext?: { totalFocusLosses?: number; totalFullscreenExits?: number };
        } | null;
      };
    };

    const context = body.session.lastRiskPayload?.behavioralContext;
    assert.ok(context, "no behavioralContext was produced");
    assert.equal(context.totalFocusLosses, 1);
    assert.equal(
      context.totalFullscreenExits,
      1,
      "the deprecated alias was dropped from a persisted payload",
    );
  });

  test("the score contribution is unchanged by the rename", async () => {
    // The rename must not move a score. `focusLossPenalty` is 10 when the counter is
    // positive, exactly as `fullscreenPenalty` was — it was always gated on "focus was
    // lost", never on "fullscreen was exited".
    await ingestWithAnalysis("voc-score-blur", "WINDOW_BLUR");
    await ingestWithAnalysis("voc-score-fullscreen", "FULLSCREEN_EXIT");

    const scores = await Promise.all(
      ["voc-score-blur", "voc-score-fullscreen"].map(async (sessionId) => {
        const res = await app.request(`/api/v1/guardian/sessions/${sessionId}`, {
          headers: authorizedHeaders(),
        });
        const body = (await res.json()) as {
          session: { overallRiskScore: number };
        };
        return body.session.overallRiskScore;
      }),
    );

    assert.equal(
      scores[0],
      scores[1],
      "a blur and a fullscreen exit scored differently, which the counter never did",
    );
  });
});

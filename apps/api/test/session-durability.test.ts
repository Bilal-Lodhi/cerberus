/**
 * Session durability: durable counters and restart-safe review.
 *
 * The defects these tests pin were invisible to the existing suite because the
 * in-process MCP stub returned risk assessments in **insertion order**, while
 * `MongoStore.getRiskAssessments()` sorts `{ generatedAt: -1 }` — newest first.
 * The stub here orders them the way the database actually does, so the route and
 * the store can no longer agree with each other and disagree with production.
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

interface Assessment {
  riskAssessmentId: string;
  sessionId: string;
  employeeId: string;
  auditId: string;
  overallRiskScore: number;
  dimensionScores: Record<string, number>;
  flags: unknown[];
  exfiltrationReport: null;
  behavioralAnomalies: unknown[];
  generatedAt: string;
  codeSnapshot?: string;
}

/**
 * A stateful MCP stand-in that orders assessments the way MongoDB does.
 *
 * `getRiskAssessments()` sorts `{ generatedAt: -1 }`, so the stub returns
 * newest-first. That single difference is what exposes the ordering bug.
 */
function mongoOrderedMcp() {
  const sessions = new Map<string, Record<string, unknown>>();
  const events = new Map<string, Array<Record<string, unknown>>>();
  const assessments = new Map<string, Assessment[]>();

  return {
    sessions,
    assessments,
    /** Inserts a session document directly, as a previous process would have. */
    seedSession(doc: Record<string, unknown>) {
      sessions.set(String(doc["sessionId"]), doc);
    },
    /** Appends an assessment, oldest first, as ingestion would. */
    seedAssessment(sessionId: string, score: number, generatedAt: string, codeSnapshot?: string) {
      const list = assessments.get(sessionId) ?? [];
      list.push({
        riskAssessmentId: `risk-${score}-${generatedAt}`,
        sessionId,
        employeeId: "op-trader-001",
        auditId: "audit-2026-q1",
        overallRiskScore: score,
        dimensionScores: { dataExfiltration: score },
        flags: [],
        exfiltrationReport: null,
        behavioralAnomalies: [],
        generatedAt,
        codeSnapshot,
      });
      assessments.set(sessionId, list);
    },
    handler(tool: string, body: Record<string, unknown>): unknown {
      switch (tool) {
        case "create_session": {
          const sessionId = String(body["sessionId"]);
          if (!sessions.has(sessionId)) {
            sessions.set(sessionId, { ...body, createdAt: new Date().toISOString() });
          }
          return { success: true, mongoDocumentId: `doc-${sessionId}` };
        }
        case "get_session_review": {
          const sessionId = String(body["sessionId"]);
          // Newest first, exactly as MongoStore.getRiskAssessments returns them.
          const reports = [...(assessments.get(sessionId) ?? [])].sort(
            (a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt),
          );
          return {
            success: true,
            session: sessions.get(sessionId) ?? null,
            events: events.get(sessionId) ?? [],
            riskAssessments: reports,
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
        case "set_session_status":
          return { success: true, updated: true };
        case "store_risk_assessment": {
          const report = (body["report"] ?? {}) as Record<string, unknown>;
          const sessionId = String(report["sessionId"] ?? "");
          const list = assessments.get(sessionId) ?? [];
          list.push(report as unknown as Assessment);
          assessments.set(sessionId, list);
          return { success: true, mongoDocumentId: "assessment-doc" };
        }
        case "list_sessions":
          return { success: true, data: [...sessions.values()] };
        case "list_reference_documents":
          return { success: true, data: [] };
        case "health_check":
          return { connected: true, healthy: true, timestamp: new Date().toISOString() };
        default:
          return { success: true };
      }
    },
  };
}

/**
 * A KEYSTROKE event, so ingest has something to count.
 *
 * `deltaMs` is a parameter because the dedup fingerprint is built from the event
 * type and payload only — **not** from `eventId` — so two events with identical
 * payloads are treated as one. Varying the payload is what makes two events
 * genuinely distinct here.
 */
function keystrokeEvent(
  sessionId: string,
  eventId: string,
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
    clientMetadata: {
      userAgent: "test",
      ipAddress: "127.0.0.1",
      screenResolution: "1920x1080",
      platform: "web",
      language: "en-US",
    },
  };
}

describe("review ordering against a newest-first store", () => {
  let stub: FetchStub;
  let mcp: ReturnType<typeof mongoOrderedMcp>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetAIProvider();
    mcp = mongoOrderedMcp();
    stub = installFetchStub({ mcpResponse: (tool, body) => mcp.handler(tool, body) });
    app = createApp(makeConfigWithTtl(3600));
  });

  afterEach(() => {
    stub.restore();
    resetAIProvider();
  });

  test("finalRiskScore is the newest assessment, not the oldest", async () => {
    mcp.seedSession({ sessionId: "ses-order", status: "active", employeeId: "op-trader-001" });
    // Oldest first, as ingestion writes them.
    mcp.seedAssessment("ses-order", 10, "2026-01-01T00:00:00.000Z");
    mcp.seedAssessment("ses-order", 40, "2026-01-02T00:00:00.000Z");
    mcp.seedAssessment("ses-order", 88, "2026-01-03T00:00:00.000Z");

    const res = await app.request("/api/v1/sessions/ses-order", {
      headers: authorizedHeaders(),
    });
    assert.equal(res.status, 200);

    const body = (await res.json()) as {
      data: { finalRiskScore: number; status: string; riskSummary: Array<{ overallRiskScore: number }> };
    };

    assert.equal(
      body.data.finalRiskScore,
      88,
      "the review reported the oldest assessment as final",
    );
    assert.equal(
      body.data.riskSummary[body.data.riskSummary.length - 1].overallRiskScore,
      88,
      "riskSummary is not ordered oldest-first",
    );
  });

  test("the derived status follows the newest assessment", async () => {
    // The newest score is low, so the session is not flagged — even though an
    // older assessment exceeded the threshold. Reading the oldest would flag it.
    mcp.seedSession({ sessionId: "ses-derive", status: "active", employeeId: "op-trader-001" });
    mcp.seedAssessment("ses-derive", 90, "2026-01-01T00:00:00.000Z");
    mcp.seedAssessment("ses-derive", 5, "2026-01-02T00:00:00.000Z");

    const res = await app.request("/api/v1/sessions/ses-derive", {
      headers: authorizedHeaders(),
    });
    const body = (await res.json()) as { data: { status: string; finalRiskScore: number } };

    assert.equal(body.data.finalRiskScore, 5);
    assert.notEqual(
      body.data.status,
      "flagged",
      "status was derived from a stale assessment",
    );
  });

  test("a locked session stays locked regardless of the newest score", async () => {
    // Lifecycle states are authoritative; ordering must not override them.
    mcp.seedSession({ sessionId: "ses-locked", status: "locked", employeeId: "op-trader-001" });
    mcp.seedAssessment("ses-locked", 5, "2026-01-02T00:00:00.000Z");

    const res = await app.request("/api/v1/sessions/ses-locked", {
      headers: authorizedHeaders(),
    });
    const body = (await res.json()) as { data: { status: string } };
    assert.equal(body.data.status, "locked");
  });

  test("the session list reports the newest score with newest-first input", async () => {
    mcp.seedSession({ sessionId: "ses-list", status: "active", employeeId: "op-trader-001" });
    mcp.seedAssessment("ses-list", 12, "2026-01-01T00:00:00.000Z");
    mcp.seedAssessment("ses-list", 79, "2026-01-02T00:00:00.000Z");

    const res = await app.request("/api/v1/sessions", { headers: authorizedHeaders() });
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    const entry = body.data.find((s) => s["sessionId"] === "ses-list");

    assert.ok(entry, "the session was not listed");
    assert.equal(entry!["riskScore"], 79);
    assert.equal(entry!["peakRiskScore"], 79);
  });

  test("reports are ordered deterministically when a timestamp is unusable", async () => {
    // A NaN comparator would leave the order unspecified; unparseable timestamps
    // must not make the result depend on the engine's sort implementation.
    mcp.seedSession({ sessionId: "ses-bad-time", status: "active", employeeId: "op-trader-001" });
    mcp.seedAssessment("ses-bad-time", 10, "not-a-date");
    mcp.seedAssessment("ses-bad-time", 70, "2026-01-02T00:00:00.000Z");

    const res = await app.request("/api/v1/sessions/ses-bad-time", {
      headers: authorizedHeaders(),
    });
    const body = (await res.json()) as { data: { finalRiskScore: number } };
    assert.equal(body.data.finalRiskScore, 70);
  });
});

describe("terminal content recovery after a restart", () => {
  let stub: FetchStub;
  let mcp: ReturnType<typeof mongoOrderedMcp>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetAIProvider();
    mcp = mongoOrderedMcp();
    stub = installFetchStub({ mcpResponse: (tool, body) => mcp.handler(tool, body) });
    app = createApp(makeConfigWithTtl(3600));
  });

  afterEach(() => {
    stub.restore();
    resetAIProvider();
  });

  test("recovers the workspace from the newest assessment's codeSnapshot", async () => {
    // `monitored_sessions.terminalContent` is never written — no route calls
    // `update_session_terminal_content` — so this is the real post-restart shape.
    mcp.seedSession({ sessionId: "ses-recover", status: "active", employeeId: "op-trader-001" });
    mcp.seedAssessment("ses-recover", 20, "2026-01-01T00:00:00.000Z", "OLD WORKSPACE");
    mcp.seedAssessment("ses-recover", 60, "2026-01-02T00:00:00.000Z", "CURRENT WORKSPACE");

    const res = await app.request("/api/v1/sessions/ses-recover", {
      headers: authorizedHeaders(),
    });
    const body = (await res.json()) as { data: { terminalContent: string } };

    assert.equal(
      body.data.terminalContent,
      "CURRENT WORKSPACE",
      "the review lost the workspace after a restart",
    );
  });

  test("prefers the session document's own terminalContent when present", async () => {
    mcp.seedSession({
      sessionId: "ses-prefer",
      status: "active",
      employeeId: "op-trader-001",
      terminalContent: "FROM THE SESSION DOCUMENT",
    });
    mcp.seedAssessment("ses-prefer", 60, "2026-01-02T00:00:00.000Z", "FROM THE ASSESSMENT");

    const res = await app.request("/api/v1/sessions/ses-prefer", {
      headers: authorizedHeaders(),
    });
    const body = (await res.json()) as { data: { terminalContent: string } };
    assert.equal(body.data.terminalContent, "FROM THE SESSION DOCUMENT");
  });

  test("reports an empty workspace when neither source has one", async () => {
    mcp.seedSession({ sessionId: "ses-none", status: "active", employeeId: "op-trader-001" });

    const res = await app.request("/api/v1/sessions/ses-none", {
      headers: authorizedHeaders(),
    });
    const body = (await res.json()) as { data: { terminalContent: string } };
    assert.equal(body.data.terminalContent, "");
  });

  test("treats an empty session terminalContent as absent", async () => {
    mcp.seedSession({
      sessionId: "ses-empty",
      status: "active",
      employeeId: "op-trader-001",
      terminalContent: "",
    });
    mcp.seedAssessment("ses-empty", 60, "2026-01-02T00:00:00.000Z", "RECOVERED");

    const res = await app.request("/api/v1/sessions/ses-empty", {
      headers: authorizedHeaders(),
    });
    const body = (await res.json()) as { data: { terminalContent: string } };
    assert.equal(body.data.terminalContent, "RECOVERED");
  });
});

describe("fullscreenExitCount durability", () => {
  let stub: FetchStub;
  let mcp: ReturnType<typeof mongoOrderedMcp>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetAIProvider();
    mcp = mongoOrderedMcp();
    stub = installFetchStub({ mcpResponse: (tool, body) => mcp.handler(tool, body) });
    app = createApp(makeConfigWithTtl(3600));
  });

  afterEach(() => {
    stub.restore();
    resetAIProvider();
  });

  test("the counter is included in the durable counts payload", async () => {
    // It drives the analysis trigger and the score penalty, and it was simply
    // absent from this payload — so MongoDB never learned it.
    const res = await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        events: [
          { ...keystrokeEvent("ses-fs", "e1"), eventType: "FULLSCREEN_EXIT", payload: {} },
        ],
      }),
    });
    assert.equal(res.status, 200);

    const countsCall = stub.calls.find((call) =>
      call.url.endsWith("/tools/update_session_counts"),
    );
    assert.ok(countsCall, "update_session_counts was never called");

    const counts = (countsCall!.body as { counts: Record<string, unknown> }).counts;
    assert.equal(
      counts["fullscreenExitCount"],
      1,
      "fullscreenExitCount is missing from the durable counts payload",
    );
  });

  test("WINDOW_BLUR also reaches the durable counter", async () => {
    // `applyEventToSession` treats WINDOW_BLUR and FULLSCREEN_EXIT identically.
    await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        events: [{ ...keystrokeEvent("ses-blur", "e1"), eventType: "WINDOW_BLUR", payload: {} }],
      }),
    });

    const countsCall = stub.calls.find((call) =>
      call.url.endsWith("/tools/update_session_counts"),
    );
    const counts = (countsCall!.body as { counts: Record<string, unknown> }).counts;
    assert.equal(counts["fullscreenExitCount"], 1);
  });

  test("a restarted process reports the durable counter from the session list", async () => {
    // A previous process recorded three focus breaches. A fresh app has empty
    // memory, so this value can only come from the durable document.
    mcp.seedSession({
      sessionId: "ses-durable-fs",
      status: "active",
      employeeId: "op-trader-001",
      fullscreenExitCount: 3,
      eventCount: 12,
      deployedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const fresh = createApp(makeConfigWithTtl(3600));
    const res = await fresh.request("/api/v1/guardian/sessions", {
      headers: authorizedHeaders(),
    });
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    const entry = body.data.find((s) => s["sessionId"] === "ses-durable-fs");

    assert.ok(entry, "the session was not recovered from MongoDB");
    assert.equal(entry!["fullscreenExitCount"], 3);
  });

  test("the review list reports the durable counter too", async () => {
    mcp.seedSession({
      sessionId: "ses-review-fs",
      status: "active",
      employeeId: "op-trader-001",
      fullscreenExitCount: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const res = await app.request("/api/v1/sessions", { headers: authorizedHeaders() });
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    const entry = body.data.find((s) => s["sessionId"] === "ses-review-fs");

    assert.ok(entry);
    assert.equal(entry!["fullscreenExitCount"], 2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// A restart must not reset durable totals
// ═══════════════════════════════════════════════════════════════════

describe("counter hydration across a restart", () => {
  let stub: FetchStub;
  let mcp: ReturnType<typeof mongoOrderedMcp>;

  /** The counters a previous process left behind. */
  const DURABLE = {
    eventCount: 40,
    pasteCount: 20,
    tabSwitchCount: 8,
    fullscreenExitCount: 3,
    copyAttemptCount: 5,
    peakRiskScore: 61,
  };

  beforeEach(() => {
    resetAIProvider();
    mcp = mongoOrderedMcp();
    stub = installFetchStub({ mcpResponse: (tool, body) => mcp.handler(tool, body) });
  });

  afterEach(() => {
    stub.restore();
    resetAIProvider();
  });

  function seed(sessionId: string, overrides: Record<string, unknown> = {}): void {
    mcp.seedSession({
      sessionId,
      status: "active",
      employeeId: "op-trader-001",
      auditId: "audit-2026-q1",
      ...DURABLE,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    });
  }

  async function ingest(
    app: ReturnType<typeof createApp>,
    sessionId: string,
    eventId: string,
    eventType = "KEYSTROKE",
    deltaMs = 120,
  ): Promise<void> {
    const res = await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        events: [
          {
            ...keystrokeEvent(sessionId, eventId, deltaMs),
            eventType,
            payload: eventType === "KEYSTROKE" ? { deltaMs } : {},
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
  }

  /** The counts object the API sent to the persistence layer. */
  function lastCountsPayload(): Record<string, unknown> {
    const call = [...stub.calls]
      .reverse()
      .find((entry) => entry.url.endsWith("/tools/update_session_counts"));
    assert.ok(call, "update_session_counts was never called");
    return (call!.body as { counts: Record<string, unknown> }).counts;
  }

  test("the first batch after a restart does not reset the counters", async () => {
    seed("ses-hydrate");
    const fresh = createApp(makeConfigWithTtl(3600));

    await ingest(fresh, "ses-hydrate", "e1");

    const counts = lastCountsPayload();
    assert.equal(
      counts["eventCount"],
      DURABLE.eventCount + 1,
      "the durable event total was replaced by the post-restart count",
    );
    assert.equal(counts["pasteCount"], DURABLE.pasteCount);
    assert.equal(counts["tabSwitchCount"], DURABLE.tabSwitchCount);
    assert.equal(counts["fullscreenExitCount"], DURABLE.fullscreenExitCount);
    assert.equal(counts["copyAttemptCount"], DURABLE.copyAttemptCount);
  });

  test("the counters accumulate on top of the durable totals", async () => {
    seed("ses-accumulate");
    const fresh = createApp(makeConfigWithTtl(3600));

    // Distinct payloads, because the fingerprint does not include eventId.
    await ingest(fresh, "ses-accumulate", "e1", "KEYSTROKE", 100);
    await ingest(fresh, "ses-accumulate", "e2", "KEYSTROKE", 200);
    await ingest(fresh, "ses-accumulate", "e3", "KEYSTROKE", 300);

    assert.equal(lastCountsPayload()["eventCount"], DURABLE.eventCount + 3);
  });

  test("a hydrated session keeps its durable status", async () => {
    // A locked session must not come back as `active` just because the process
    // restarted; the durable document is the authority.
    seed("ses-locked-hydrate", { status: "locked" });
    const fresh = createApp(makeConfigWithTtl(3600));

    await ingest(fresh, "ses-locked-hydrate", "e1");

    const detail = await fresh.request("/api/v1/guardian/sessions/ses-locked-hydrate", {
      headers: authorizedHeaders(),
    });
    const body = (await detail.json()) as { session: { status: string } };
    assert.equal(body.session.status, "locked");
  });

  test("hydration seeds counters only, not evidence", async () => {
    // The event array and reconstructed workspace are rebuilt from where they
    // actually live, so hydration must not invent a staler copy.
    seed("ses-hydrate-scope");
    const fresh = createApp(makeConfigWithTtl(3600));

    await ingest(fresh, "ses-hydrate-scope", "e1");

    const detail = await fresh.request("/api/v1/guardian/sessions/ses-hydrate-scope", {
      headers: authorizedHeaders(),
    });
    const body = (await detail.json()) as {
      session: { eventCount: number; currentCode: string };
    };

    assert.equal(body.session.eventCount, DURABLE.eventCount + 1);
    assert.equal(
      body.session.currentCode,
      "",
      "hydration invented workspace content it did not have",
    );
  });

  test("hydration does not re-seed over newer in-memory counters", async () => {
    seed("ses-no-reseed");
    const fresh = createApp(makeConfigWithTtl(3600));

    await ingest(fresh, "ses-no-reseed", "e1", "KEYSTROKE", 100);
    const afterFirst = lastCountsPayload()["eventCount"] as number;

    // The stub merges counts into the document, so the durable value is now
    // higher. A second hydration would re-read it and double-count.
    await ingest(fresh, "ses-no-reseed", "e2", "KEYSTROKE", 200);

    assert.equal(lastCountsPayload()["eventCount"], afterFirst + 1);
  });

  test("the durable counters are monotonic at the storage layer", async () => {
    // Even without hydration, `$max` means a lower value cannot overwrite a
    // higher one. The builder is asserted directly in persistence-naming.test.ts;
    // this checks the API's payload never carries a value below the durable floor.
    seed("ses-monotonic");
    const fresh = createApp(makeConfigWithTtl(3600));

    await ingest(fresh, "ses-monotonic", "e1");

    const counts = lastCountsPayload();
    for (const key of [
      "eventCount",
      "pasteCount",
      "tabSwitchCount",
      "fullscreenExitCount",
      "copyAttemptCount",
    ] as const) {
      assert.ok(
        (counts[key] as number) >= DURABLE[key],
        `${key} was sent below its durable floor`,
      );
    }
  });

  test("ingestion still succeeds when the durable document cannot be read", async () => {
    // Hydration is best-effort: the storage layer's `$max` is the backstop, so a
    // failed read must degrade rather than fail the batch.
    mcp.seedSession({ sessionId: "ses-no-hydrate", status: "active" });
    stub.restore();
    stub = installFetchStub({
      mcpResponse: (tool, body) => {
        if (tool === "get_session_review") throw new Error("mongo unreachable");
        return mcp.handler(tool, body);
      },
    });

    const fresh = createApp(makeConfigWithTtl(3600));
    const res = await fresh.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events: [keystrokeEvent("ses-no-hydrate", "e1")] }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { success: boolean };
    assert.equal(body.success, true);
  });
});


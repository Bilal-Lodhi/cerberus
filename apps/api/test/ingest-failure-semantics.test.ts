/**
 * The ingest write order, and what the response says when a step fails.
 *
 * Two properties, both from `docs/development/failure-semantics.md`:
 *
 *   1. **Durable evidence before side effects.** The risk assessment used to be
 *      written *last* — after the notification and the status change — so a process
 *      death in that window left a durably `locked` session with a delivered alert and
 *      no recorded justification.
 *   2. **A failed step is reported, not disguised.** A failed events write used to
 *      produce the same response as a fully successful one.
 *
 * The store double's failure hooks make every window reachable deterministically.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import { makeConfigWithTtl } from "./helpers.js";
import { authorizedHeaders, installFetchStub, type FetchStub } from "./helpers.js";
import { McpStoreDouble } from "./support/mcp-store-double.js";

/** A high-risk reply, so the auto-lock path is taken. */
const HIGH_RISK_AI = JSON.stringify({
  riskAssessmentId: "66666666-6666-4666-8666-666666666666",
  overallRiskScore: 97,
  dimensionScores: { dataExfiltration: 97, policyViolation: 92 },
  flags: [],
  exfiltrationReport: null,
  behavioralAnomalies: [],
  generatedAt: "2026-01-01T00:00:00.000Z",
});

/** A large paste, so the analysis trigger fires. */
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
    clientMetadata: { userAgent: "test", platform: "web" },
  };
}

interface IngestResult {
  status: number;
  body: Record<string, unknown>;
}

describe("ingest write ordering and honest responses", () => {
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

  async function ingest(
    sessionId: string,
    event: Record<string, unknown>,
  ): Promise<IngestResult> {
    const res = await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events: [event] }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  /** The tool names invoked, in order, since the last reset. */
  function callsSince(mark: number): string[] {
    return mcp.calls.slice(mark);
  }

  // ── Ordering ──────────────────────────────────────────────────────

  describe("durable evidence precedes side effects", () => {
    test("the assessment is written before the status change", async () => {
      const mark = mcp.calls.length;
      const result = await ingest("o-order", largePaste("o-order"));
      assert.equal(result.status, 200);

      const calls = callsSince(mark);
      const assessmentAt = calls.indexOf("store_risk_assessment");
      const statusAt = calls.indexOf("set_session_status");

      assert.ok(assessmentAt >= 0, "no assessment was written");
      assert.ok(statusAt >= 0, "the session was not locked");
      assert.ok(
        assessmentAt < statusAt,
        `the status changed before its evidence was written: ${calls.join(" → ")}`,
      );
    });

    test("the assessment is written before any notification", async () => {
      // The notification channels are unconfigured in this fixture, so `notifySlack`
      // and `sendEmail` return early. What is asserted is the *order* of the durable
      // write relative to the point at which they are called, which is observable
      // because the assessment write is the last MCP call before them.
      const mark = mcp.calls.length;
      await ingest("o-notify-order", largePaste("o-notify-order"));

      const calls = callsSince(mark);
      const assessmentAt = calls.indexOf("store_risk_assessment");
      assert.ok(assessmentAt >= 0);
      // Nothing that could be a side effect precedes it: the only MCP calls before it
      // are the telemetry write, the counter write and the corpus read.
      const before = calls.slice(0, assessmentAt);
      for (const tool of before) {
        assert.ok(
          [
            "get_session_review",
            "create_session",
            "ingest_micro_events",
            "update_session_counts",
            "list_reference_documents",
          ].includes(tool),
          `an unexpected call preceded the durable evidence: ${tool}`,
        );
      }
    });

    test("a failed assessment write leaves the session unlocked", async () => {
      // This is the window the ordering exists to close: the assessment is the only
      // durable artefact of the paid path, so without it there must be no lock.
      mcp.failToolTransport("store_risk_assessment");

      const result = await ingest("o-no-evidence", largePaste("o-no-evidence"));

      assert.equal(result.status, 200, "a failed assessment write failed the whole batch");
      assert.equal(result.body["assessmentPersisted"], false);
      assert.equal(
        mcp.sessions.get("o-no-evidence")?.["status"],
        "active",
        "the session was locked without durable evidence",
      );
    });

    test("a failed assessment write still stores the telemetry", async () => {
      mcp.failToolTransport("store_risk_assessment");
      await ingest("o-no-evidence-events", largePaste("o-no-evidence-events"));

      const events = await mcp.getSessionEvents("o-no-evidence-events");
      assert.equal(events.length, 1, "telemetry was lost because a later step failed");
      assert.equal(
        mcp.sessions.get("o-no-evidence-events")?.["eventCount"],
        1,
        "the durable counter was not advanced for stored telemetry",
      );
    });

    test("a successful assessment write is reported as persisted", async () => {
      const result = await ingest("o-persisted", largePaste("o-persisted"));
      assert.equal(result.body["assessmentPersisted"], true);
      assert.equal(mcp.sessions.get("o-persisted")?.["status"], "locked");
    });

    test("no assessment is reported when no analysis ran", async () => {
      // A small keystroke batch does not trigger analysis, so the question of whether
      // a payload is durable does not apply and the field is absent rather than false.
      const result = await ingest("o-no-analysis", {
        ...largePaste("o-no-analysis"),
        eventType: "KEYSTROKE",
        payload: { deltaMs: 200 },
      });

      assert.equal(result.status, 200);
      assert.equal(
        result.body["assessmentPersisted"],
        undefined,
        "a persistence verdict was reported for an analysis that never ran",
      );
    });
  });

  // ── The dedup branch tells the truth ──────────────────────────────

  describe("the code-hash dedup branch", () => {
    test("reports the reused payload as persisted when its write succeeded", async () => {
      await ingest("d-persisted", largePaste("d-persisted"));
      // The same workspace, a new eventId: dedup layer 2 reuses the cached payload.
      const again = await ingest(
        "d-persisted",
        { ...largePaste("d-persisted"), payload: { newText: "x".repeat(400), changeLength: 400 } },
      );

      assert.equal(again.body["assessmentPersisted"], true);
      assert.ok(again.body["riskPayload"], "the reused payload was not returned");
    });

    test("does not claim a persisted payload when the earlier write failed", async () => {
      // The assessment write fails, so the cached payload is not durable. A later
      // batch on the same workspace reuses it — and must not claim it is stored.
      mcp.failToolTransport("store_risk_assessment");
      const first = await ingest("d-unpersisted", largePaste("d-unpersisted"));
      assert.equal(first.body["assessmentPersisted"], false);

      const second = await ingest(
        "d-unpersisted",
        { ...largePaste("d-unpersisted"), payload: { newText: "x".repeat(400), changeLength: 400 } },
      );

      assert.equal(
        second.body["assessmentPersisted"],
        false,
        "a reused payload was reported as durable after its write had failed",
      );
    });

    test("the dedup branch reports the same telemetry fields as the main path", async () => {
      const batch = largePaste("d-shape");
      await ingest("d-shape", batch);
      const again = await ingest("d-shape", {
        ...batch,
        payload: { newText: "x".repeat(400), changeLength: 400 },
      });

      assert.equal(again.body["telemetryPersisted"], true);
      assert.equal(typeof again.body["processedCount"], "number");
      assert.equal(
        again.body["acceptedCount"],
        0,
        "the replay was reported as newly accepted",
      );
      assert.equal(again.body["duplicateCount"], 1);
    });
  });

  // ── Deletion reports the truth ────────────────────────────────────

  describe("deletion", () => {
    test("reports 503 and changes nothing when the store does not answer", async () => {
      await ingest("del-down", largePaste("del-down"));
      mcp.failToolTransport("delete_session");

      const res = await app.request("/api/v1/guardian/sessions/del-down", {
        method: "DELETE",
        headers: authorizedHeaders(),
      });

      assert.equal(res.status, 503, "an unreachable store was reported as a successful delete");
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, "SESSION_STORE_UNAVAILABLE");
      assert.equal(
        mcp.sessions.has("del-down"),
        true,
        "the session was reported deleted while it is still durable",
      );
    });

    test("a session still visible in memory is not reported as not-found", async () => {
      // The store answers, but matched nothing — a session that only ever existed in
      // memory. That is a real deletion from this process's point of view, not a 404.
      await ingest("del-memory-only", largePaste("del-memory-only"));
      await mcp.deleteSession("del-memory-only");

      const res = await app.request("/api/v1/guardian/sessions/del-memory-only", {
        method: "DELETE",
        headers: authorizedHeaders(),
      });

      assert.equal(res.status, 200);
    });

    test("a successful delete removes the session durably and from memory", async () => {
      await ingest("del-ok", largePaste("del-ok"));

      const res = await app.request("/api/v1/guardian/sessions/del-ok", {
        method: "DELETE",
        headers: authorizedHeaders(),
      });
      assert.equal(res.status, 200);

      assert.equal(mcp.sessions.has("del-ok"), false);
      const detail = await app.request("/api/v1/guardian/sessions/del-ok", {
        headers: authorizedHeaders(),
      });
      assert.equal(detail.status, 404);
    });

    test("deleting an unknown session is still 404", async () => {
      const res = await app.request("/api/v1/guardian/sessions/del-unknown", {
        method: "DELETE",
        headers: authorizedHeaders(),
      });
      assert.equal(res.status, 404);
    });
  });
});

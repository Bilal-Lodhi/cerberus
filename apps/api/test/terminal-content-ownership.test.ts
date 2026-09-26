/**
 * Terminal-content ownership.
 *
 * ── The problem ───────────────────────────────────────────────────────
 *
 * `update_session_terminal_content` is a **published MCP capability that no route called**,
 * so `monitored_sessions.terminalContent` was always absent. The review path therefore
 * recovered the workspace from a chain of three sources, with no rule saying which won:
 *
 *   1. `session.terminalContent` — the owner, and empty;
 *   2. the in-memory `currentCode` — lost on restart;
 *   3. the newest assessment's `codeSnapshot` — the workspace **when that assessment ran**,
 *      which is a *different fact* from "the workspace as monitoring ended".
 *
 * ── The decision ──────────────────────────────────────────────────────
 *
 * **The API adopts the capability.** `terminalContent` owns "the workspace as monitoring
 * ended" and is written once, by the transition that ends monitoring — `terminate`. The
 * other two sources become documented fallbacks rather than competing owners:
 * `currentCode` is the live workspace, and `codeSnapshot` is read only for a session
 * terminated before terminal content was written at all.
 *
 * The capability is **not** deprecated and **not** removed: it remains a published MCP
 * tool an external client may call directly. What changed is that the API now uses it.
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

/** A high-risk reply, so an assessment with a `codeSnapshot` exists to fall back to. */
const HIGH_RISK_AI = JSON.stringify({
  riskAssessmentId: "88888888-8888-4888-8888-888888888888",
  overallRiskScore: 90,
  dimensionScores: { dataExfiltration: 90, policyViolation: 85 },
  flags: [],
  exfiltrationReport: null,
  behavioralAnomalies: [],
  generatedAt: "2026-01-01T00:00:00.000Z",
});

describe("terminal-content ownership", () => {
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

  /** A large paste, so the workspace is set and an analysis runs. */
  function largePaste(sessionId: string, text = "x".repeat(400)): Record<string, unknown> {
    return {
      eventId: randomUUID(),
      sessionId,
      employeeId: "op-trader-001",
      auditId: "audit-2026-q1",
      vectorId: "tv-1",
      eventType: "PASTE",
      timestamp: new Date().toISOString(),
      payload: { newText: text, changeLength: text.length },
      clientMetadata: { userAgent: "t", platform: "web" },
    };
  }

  async function ingest(sessionId: string, text?: string): Promise<void> {
    const res = await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events: [largePaste(sessionId, text)] }),
    });
    assert.equal(res.status, 200);
  }

  async function terminate(sessionId: string) {
    const res = await app.request(`/api/v1/guardian/sessions/${sessionId}/terminate`, {
      method: "POST",
      headers: authorizedHeaders(),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function review(sessionId: string): Promise<Record<string, unknown>> {
    const res = await app.request(`/api/v1/sessions/${sessionId}`, {
      headers: authorizedHeaders(),
    });
    assert.equal(res.status, 200);
    return ((await res.json()) as { data: Record<string, unknown> }).data;
  }

  // ── The owner is written ──────────────────────────────────────────

  test("terminate writes terminalContent to the session document", async () => {
    // The write that makes the field an owner rather than a field nobody populates.
    await ingest("tc-write", "WORKSPACE AT TERMINATION");
    assert.equal((await terminate("tc-write")).status, 200);

    const session = await mcp.getSession("tc-write");
    assert.equal(
      session?.["terminalContent"],
      "WORKSPACE AT TERMINATION",
      "terminalContent was not written, so the field still has no owner",
    );
  });

  test("the review surface reads the owner", async () => {
    await ingest("tc-owner", "OWNER WORKSPACE");
    await terminate("tc-owner");

    assert.equal((await review("tc-owner"))["terminalContent"], "OWNER WORKSPACE");
  });

  test("the owner survives a restart, with no fallback needed", async () => {
    // The point of writing it: the review view no longer depends on reconstructing the
    // workspace from an assessment that records a different moment.
    await ingest("tc-restart", "DURABLE WORKSPACE");
    await terminate("tc-restart");

    // A fresh process: empty memory, same durable store.
    const restarted = createApp(makeConfigWithTtl(3600));
    const res = await restarted.request("/api/v1/sessions/tc-restart", {
      headers: authorizedHeaders(),
    });
    const body = (await res.json()) as { data: { terminalContent: string } };

    assert.equal(body.data.terminalContent, "DURABLE WORKSPACE");
  });

  test("a later ingest does not overwrite the preserved workspace", async () => {
    // A terminated session refuses telemetry, so the owner cannot be changed after the
    // transition — the value is genuinely terminal.
    await ingest("tc-immutable", "AS TERMINATED");
    await terminate("tc-immutable");

    const res = await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events: [largePaste("tc-immutable", "REPLACEMENT")] }),
    });
    assert.equal(res.status, 409);

    assert.equal((await review("tc-immutable"))["terminalContent"], "AS TERMINATED");
  });

  test("terminating twice does not lose the preserved workspace", async () => {
    await ingest("tc-twice", "ONCE");
    await terminate("tc-twice");
    await terminate("tc-twice");

    assert.equal((await review("tc-twice"))["terminalContent"], "ONCE");
  });

  // ── The fallbacks are fallbacks ───────────────────────────────────

  test("an un-terminated session still reports its live workspace", async () => {
    // No terminal content exists yet, so the review reads the live reconstruction. That is
    // a fallback, and the correct one for a session that is still running.
    await ingest("tc-live", "LIVE WORKSPACE");

    assert.equal((await review("tc-live"))["terminalContent"], "LIVE WORKSPACE");
  });

  test("a session terminated before this change falls back to the assessment snapshot", async () => {
    // The compatibility path. Such a session has no `terminalContent` and no live memory,
    // so the newest assessment's `codeSnapshot` is read — a different fact, but better than
    // an empty panel.
    mcp.seedSession({ sessionId: "tc-legacy", status: "terminated", employeeId: "op-1" });
    mcp.seedAssessment("tc-legacy", {
      overallRiskScore: 60,
      generatedAt: "2026-01-01T00:00:00.000Z",
      codeSnapshot: "SNAPSHOT AT ANALYSIS TIME",
    });

    assert.equal(
      (await review("tc-legacy"))["terminalContent"],
      "SNAPSHOT AT ANALYSIS TIME",
    );
  });

  test("the owner wins over the assessment snapshot when both exist", async () => {
    // The order is the ownership rule, stated as an assertion.
    mcp.seedSession({
      sessionId: "tc-both",
      status: "terminated",
      employeeId: "op-1",
      terminalContent: "THE OWNER",
    });
    mcp.seedAssessment("tc-both", {
      overallRiskScore: 60,
      generatedAt: "2026-01-01T00:00:00.000Z",
      codeSnapshot: "THE SNAPSHOT",
    });

    assert.equal((await review("tc-both"))["terminalContent"], "THE OWNER");
  });

  test("the newest assessment's snapshot is the one read", async () => {
    mcp.seedSession({ sessionId: "tc-newest", status: "terminated", employeeId: "op-1" });
    mcp.seedAssessment("tc-newest", {
      overallRiskScore: 20,
      generatedAt: "2026-01-01T00:00:00.000Z",
      codeSnapshot: "OLD",
    });
    mcp.seedAssessment("tc-newest", {
      overallRiskScore: 60,
      generatedAt: "2026-03-01T00:00:00.000Z",
      codeSnapshot: "NEW",
    });

    assert.equal((await review("tc-newest"))["terminalContent"], "NEW");
  });

  // ── Bounded reads ─────────────────────────────────────────────────

  test("preserving the workspace reads one assessment, not the history", async () => {
    // The read only happens when the workspace is **not** in memory — after a restart, or
    // for a session this process never ingested for. That is the path that needs the
    // fallback, and it is the one bounded to a single assessment: only the newest snapshot
    // can hold the most recent workspace, so reading the history would be work proportional
    // to the session's whole analysis history.
    mcp.seedSession({ sessionId: "tc-bounded", status: "active", employeeId: "op-1" });
    mcp.seedAssessment("tc-bounded", {
      overallRiskScore: 60,
      generatedAt: "2026-01-01T00:00:00.000Z",
      codeSnapshot: "FROM THE SNAPSHOT",
    });

    // A fresh process: empty memory, same durable store.
    const restarted = createApp(makeConfigWithTtl(3600));
    const restartedStub = stub;
    const res = await restarted.request("/api/v1/guardian/sessions/tc-bounded/terminate", {
      method: "POST",
      headers: authorizedHeaders(),
    });
    assert.equal(res.status, 200);

    // The preservation read happens **before** the transition, so it is the first
    // `get_session_review` in the window — the boundary's own read comes after it and does
    // not ask for assessments at all.
    const readCall = restartedStub.calls.find((call) =>
      call.url.endsWith("/tools/get_session_review"),
    );
    assert.ok(readCall, "no session read was made on the fallback path");

    const body = readCall.body as Record<string, unknown>;
    assert.equal(body["eventsLimit"], 0, "the read carried events it does not use");
    assert.equal(body["assessmentsLimit"], 1, "the read carried the whole analysis history");

    // And the fallback value is what got preserved.
    assert.equal(
      (await mcp.getSession("tc-bounded"))?.["terminalContent"],
      "FROM THE SNAPSHOT",
    );
  });

  // ── Best effort ───────────────────────────────────────────────────

  test("a failed preservation does not stop the termination", async () => {
    // An operator must be able to end monitoring even when the store is unhappy. The
    // telemetry and the assessments are already durable; losing the convenience of a
    // preserved workspace must not block the lifecycle action.
    await ingest("tc-fail", "WILL NOT BE PRESERVED");
    mcp.failToolTransport("update_session_terminal_content");

    const result = await terminate("tc-fail");

    assert.equal(result.status, 200, "a failed preservation blocked the termination");
    assert.equal(mcp.sessions.get("tc-fail")?.["status"], "terminated");
  });

  test("a failed preservation leaves the review readable", async () => {
    await ingest("tc-fail-review", "STILL READABLE");
    mcp.failToolTransport("update_session_terminal_content");
    await terminate("tc-fail-review");

    // The fallback chain still serves the live reconstruction, so the panel is not empty.
    assert.equal((await review("tc-fail-review"))["terminalContent"], "STILL READABLE");
  });

  test("the published capability is still callable by an MCP client", async () => {
    // Adopting it in the API must not remove it from the interface: an external MCP client
    // may still write terminal content directly.
    await ingest("tc-mcp-client", "FROM THE ROUTE");
    await terminate("tc-mcp-client");

    const response = await mcp.responder()("update_session_terminal_content", {
      sessionId: "tc-mcp-client",
      terminalContent: "FROM AN MCP CLIENT",
    });
    assert.equal(response.status, 200);

    const body = (await response.json()) as { success: boolean };
    assert.equal(body.success, true);
    assert.equal(
      (await mcp.getSession("tc-mcp-client"))?.["terminalContent"],
      "FROM AN MCP CLIENT",
    );
  });

  test("the raw capability reports success for a session that does not exist", async () => {
    // Pinned deliberately, as a limitation rather than a feature: `updateSession` matches on
    // `sessionId` and `{success: true}` follows either way, so the *tool* cannot tell a
    // real write from a no-op. The transition boundary adds the existence check the API
    // needs — see `session-transition.test.ts`, "terminal content is written only for a
    // session that exists". An external MCP client calling the tool directly still gets
    // this behaviour, which is why it is asserted rather than left implicit.
    const response = await mcp.responder()("update_session_terminal_content", {
      sessionId: "tc-does-not-exist",
      terminalContent: "GHOST",
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { success: boolean };
    assert.equal(body.success, true);
    assert.equal(
      await mcp.getSession("tc-does-not-exist"),
      null,
      "the tool created a session document",
    );
  });

  // ── The ownership rule, across two processes ──────────────────────
  //
  // The field is one fact — "the workspace as monitoring ended" — and it used to have no
  // owner: `terminate` wrote it **before** the transition and unconditionally, so two
  // processes terminating the same session both wrote and the last writer won, with whichever
  // process happened to hold the *staler* reconstruction. The rule is now that the process
  // whose terminal transition actually applied owns it.

  describe("the transition that applied owns the field", () => {
    let processA: ReturnType<typeof createApp>;
    let processB: ReturnType<typeof createApp>;

    beforeEach(() => {
      const config = makeConfigWithTtl(3600);
      processA = createApp(config);
      processB = createApp(config);
    });

    /** Ingest one large paste into a specific process. */
    async function ingestInto(
      target: ReturnType<typeof createApp>,
      sessionId: string,
      text: string,
    ): Promise<void> {
      const res = await target.request("/api/v1/guardian/ingest", {
        method: "POST",
        headers: authorizedHeaders(),
        body: JSON.stringify({ events: [largePaste(sessionId, text)] }),
      });
      assert.equal(res.status, 200, await res.text());
    }

    async function terminateVia(
      target: ReturnType<typeof createApp>,
      sessionId: string,
    ): Promise<number> {
      const res = await target.request(
        `/api/v1/guardian/sessions/${sessionId}/terminate`,
        { method: "POST", headers: authorizedHeaders() },
      );
      return res.status;
    }

    async function reviewVia(
      target: ReturnType<typeof createApp>,
      sessionId: string,
    ): Promise<Record<string, unknown>> {
      const res = await target.request(`/api/v1/sessions/${sessionId}`, {
        headers: authorizedHeaders(),
      });
      assert.equal(res.status, 200);
      return ((await res.json()) as { data: Record<string, unknown> }).data;
    }

    async function currentCodeVia(
      target: ReturnType<typeof createApp>,
      sessionId: string,
    ): Promise<string> {
      const res = await target.request(`/api/v1/guardian/sessions/${sessionId}`, {
        headers: authorizedHeaders(),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { session?: { currentCode?: string } };
      return body.session?.currentCode ?? "";
    }

    test("a second terminate does not overwrite the workspace the first preserved", async () => {
      // Both processes ingest the same session, so both hold a **different** reconstruction:
      // A holds what A saw and B holds what B saw. Both are legitimate; only one may own the
      // field.
      await ingestInto(processA, "tc-owner", "A SAW THIS");
      await ingestInto(processB, "tc-owner", "B SAW THAT");

      const aWorkspace = await currentCodeVia(processA, "tc-owner");
      const bWorkspace = await currentCodeVia(processB, "tc-owner");
      // Both non-empty, and different. Without the first assertion the test could pass
      // vacuously: B holding no workspace would fall back to the durable content and skip the
      // write for a reason that has nothing to do with ownership.
      assert.notEqual(aWorkspace, "", "precondition: process A holds a workspace");
      assert.notEqual(bWorkspace, "", "precondition: process B holds a workspace");
      assert.notEqual(
        aWorkspace,
        bWorkspace,
        "precondition: the two processes must hold different reconstructions",
      );

      // A terminates first, so A's transition applies and A owns the field.
      assert.equal(await terminateVia(processA, "tc-owner"), 200);
      const winner = await reviewVia(processA, "tc-owner");
      assert.equal(
        winner["terminalContent"],
        aWorkspace,
        "the process whose transition applied did not own the field",
      );

      // B terminates second. Its transition is a legal no-op — the session is already
      // terminated — so it did not claim the session and must not overwrite.
      assert.equal(
        await terminateVia(processB, "tc-owner"),
        200,
        "re-terminating an already-terminated session must stay a legal no-op",
      );

      const after = await reviewVia(processB, "tc-owner");
      assert.equal(
        after["terminalContent"],
        aWorkspace,
        "a terminate that did not claim the session overwrote the preserved workspace",
      );
    });

    test("a terminate that is refused writes no content at all", async () => {
      // The old order wrote the workspace **before** the transition, so a refused terminate
      // still wrote content. A session that does not exist cannot own terminal content.
      assert.equal(await terminateVia(processA, "tc-ghost"), 404);

      assert.equal(
        mcp.sessions.get("tc-ghost"),
        undefined,
        "a refused terminate created or touched a session document",
      );
    });

    test("a terminated session with no content is repaired by a later terminate", async () => {
      // The case `onlyIfAbsent` exists for: the winning process died between its transition
      // and its content write, so the session is terminated and holds nothing. A later
      // terminate may fill it from the documented fallback — and must never overwrite content
      // that is already there, which the previous test covers.
      mcp.seedSession({
        sessionId: "tc-repair",
        status: "terminated",
        employeeId: "op-1",
        auditId: "audit-1",
      });
      mcp.seedAssessment("tc-repair", {
        overallRiskScore: 60,
        generatedAt: "2026-01-01T00:00:00.000Z",
        codeSnapshot: "FROM THE SNAPSHOT",
      });

      assert.equal(await terminateVia(processA, "tc-repair"), 200);

      assert.equal(
        (await reviewVia(processA, "tc-repair"))["terminalContent"],
        "FROM THE SNAPSHOT",
        "a terminated session with no content was not repaired",
      );
    });
  });
});

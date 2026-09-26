/**
 * The session transition boundary.
 *
 * Three groups, deliberately separated:
 *
 *   1. **The transition table**, driven through the real routes, so what is asserted
 *      is what an operator can reach. Every allowed transition, every disallowed one,
 *      a repeated transition, and the terminal state.
 *   2. **Invariants under concurrency, restart and a stale cache** — the properties
 *      that a single-threaded happy path cannot show.
 *   3. **The boundary in isolation**, against a stub cache, for the outcomes that are
 *      hard to provoke through a route (a store that does not answer, a document
 *      holding a status the durable vocabulary cannot hold).
 *
 * The headline regression is in group 1: a terminated session used to accept
 * telemetry and be moved to `locked` by a high-risk batch. See
 * `docs/development/state-transition-model.md` §3.1.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import {
  createSessionTransitions,
  acceptsTelemetry,
  type SessionTransitionCache,
} from "../src/services/session-transition.js";
import { createManualClock } from "../src/services/session-liveness.js";
import {
  SESSION_TRANSITION_CODES,
  normalizeStatus,
  type DurableSessionStatus,
  type PersistedSessionStatus,
} from "../src/services/session-status.js";
import {
  authorizedHeaders,
  installFetchStub,
  makeConfigWithTtl,
  type FetchStub,
} from "./helpers.js";
import { McpStoreDouble } from "./support/mcp-store-double.js";

/** A high-risk AI reply, so ingest's auto-lock threshold is cleared. */
const HIGH_RISK_AI = JSON.stringify({
  riskAssessmentId: "44444444-4444-4444-8444-444444444444",
  overallRiskScore: 98,
  dimensionScores: { dataExfiltration: 98, policyViolation: 95 },
  flags: [],
  exfiltrationReport: null,
  behavioralAnomalies: [],
  generatedAt: "2026-01-01T00:00:00.000Z",
});

/** A low-risk AI reply, so ingest's auto-clear threshold is cleared. */
const LOW_RISK_AI = JSON.stringify({
  riskAssessmentId: "55555555-5555-4555-8555-555555555555",
  overallRiskScore: 2,
  dimensionScores: { dataExfiltration: 2, policyViolation: 1 },
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

/** A single KEYSTROKE, so a batch exists without triggering analysis. */
function keystroke(sessionId: string, eventId = randomUUID(), deltaMs = 120): Record<string, unknown> {
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

// ═══════════════════════════════════════════════════════════════════
// Group 1 — the transition table, through the real routes
// ═══════════════════════════════════════════════════════════════════

describe("session transition table", () => {
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

  /**
   * Swaps the stub for one with a different AI reply.
   *
   * `resetAIProvider()` is load-bearing: the OpenAI SDK captures `fetch` at client
   * construction and `getAIProvider()` memoises that client, so without the reset the
   * provider keeps using the previous stub's `fetch` and the new reply is ignored.
   */
  function swapStub(aiResponse: string): void {
    stub.restore();
    resetAIProvider();
    stub = installFetchStub({ mcpResponse: mcp.responder(), aiResponse });
  }

  /** The durable status the store holds. The authority for every assertion here. */
  function durableStatus(sessionId: string): unknown {
    return mcp.sessions.get(sessionId)?.["status"];
  }

  async function ingest(
    sessionId: string,
    event: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events: [event] }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function terminate(sessionId: string) {
    const res = await app.request(`/api/v1/guardian/sessions/${sessionId}/terminate`, {
      method: "POST",
      headers: authorizedHeaders(),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function reactivate(sessionId: string) {
    const res = await app.request(`/api/v1/guardian/sessions/${sessionId}/reactivate`, {
      method: "POST",
      headers: authorizedHeaders(),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  // ── The confirmed P1 ──────────────────────────────────────────────

  describe("a terminated session is terminal", () => {
    test("ingest after terminate is refused with SESSION_TERMINATED", async () => {
      await ingest("ses-p1", keystroke("ses-p1"));
      assert.equal((await terminate("ses-p1")).status, 200);
      assert.equal(durableStatus("ses-p1"), "terminated");

      // A high-risk batch: before the fix this was accepted, stored, counted, and
      // moved the session to `locked`.
      const res = await ingest("ses-p1", largePaste("ses-p1"));

      assert.equal(res.status, 409, "telemetry was accepted for a terminated session");
      assert.equal(res.body["code"], SESSION_TRANSITION_CODES.SESSION_TERMINAL);
      assert.equal(res.body["status"], "terminated");
      assert.match(String(res.body["error"]), /terminated/i);
    });

    test("the durable status is untouched by a refused ingest", async () => {
      await ingest("ses-p1-durable", keystroke("ses-p1-durable"));
      await terminate("ses-p1-durable");

      await ingest("ses-p1-durable", largePaste("ses-p1-durable"));

      assert.equal(
        durableStatus("ses-p1-durable"),
        "terminated",
        "a refused ingest changed the durable status",
      );
    });

    test("a refused ingest stores no telemetry and advances no counter", async () => {
      await ingest("ses-p1-events", keystroke("ses-p1-events", "before"));
      await terminate("ses-p1-events");

      const before = await mcp.getSession("ses-p1-events");
      const eventsBefore = (await mcp.getSessionEvents("ses-p1-events")).length;

      await ingest("ses-p1-events", largePaste("ses-p1-events", "after"));

      const after = await mcp.getSession("ses-p1-events");
      const eventsAfter = (await mcp.getSessionEvents("ses-p1-events")).length;

      assert.equal(eventsAfter, eventsBefore, "telemetry was stored for a terminated session");
      assert.equal(
        after?.["eventCount"],
        before?.["eventCount"],
        "a counter advanced for a terminated session",
      );
      assert.equal(after?.["pasteCount"], before?.["pasteCount"]);
    });

    test("a refused ingest does not auto-lock", async () => {
      // The auto-lock path had no precondition either, so this is the second half of
      // the same defect: even if telemetry were admitted, the lock must not fire.
      swapStub(HIGH_RISK_AI);

      await ingest("ses-p1-lock", keystroke("ses-p1-lock"));
      await terminate("ses-p1-lock");

      await ingest("ses-p1-lock", largePaste("ses-p1-lock"));

      assert.equal(durableStatus("ses-p1-lock"), "terminated");
    });

    test("a terminated session is still fully readable for review", async () => {
      // Refusing telemetry must not hide evidence: that is the whole point of keeping
      // `terminated` distinct from deletion.
      await ingest("ses-p1-review", keystroke("ses-p1-review"));
      await terminate("ses-p1-review");

      const res = await app.request("/api/v1/sessions/ses-p1-review", {
        headers: authorizedHeaders(),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        data: { status: string; timeline: unknown[] };
      };
      assert.equal(body.data.status, "terminated");
      assert.equal(body.data.timeline.length, 1);
    });
  });

  // ── Allowed transitions ───────────────────────────────────────────

  describe("allowed transitions", () => {
    test("active → terminated", async () => {
      await ingest("t-active-term", keystroke("t-active-term"));
      assert.equal((await terminate("t-active-term")).status, 200);
      assert.equal(durableStatus("t-active-term"), "terminated");
    });

    test("locked → terminated", async () => {
      swapStub(HIGH_RISK_AI);
      await ingest("t-locked-term", largePaste("t-locked-term"));
      assert.equal(durableStatus("t-locked-term"), "locked");

      assert.equal((await terminate("t-locked-term")).status, 200);
      assert.equal(durableStatus("t-locked-term"), "terminated");
    });

    test("active → locked on a high-risk batch", async () => {
      swapStub(HIGH_RISK_AI);
      await ingest("t-autolock", largePaste("t-autolock"));
      assert.equal(durableStatus("t-autolock"), "locked");
    });

    test("locked → active on a low-risk batch", async () => {
      swapStub(HIGH_RISK_AI);
      await ingest("t-autoclear", largePaste("t-autoclear"));
      assert.equal(durableStatus("t-autoclear"), "locked");

      // A different workspace, so the code-hash dedup layer does not reuse the payload.
      swapStub(LOW_RISK_AI);
      await ingest(
        "t-autoclear",
        { ...largePaste("t-autoclear"), payload: { newText: "y".repeat(400), changeLength: 400 } },
      );
      assert.equal(durableStatus("t-autoclear"), "active");
    });

    test("locked → active on reactivate", async () => {
      swapStub(HIGH_RISK_AI);
      await ingest("t-react-locked", largePaste("t-react-locked"));
      assert.equal(durableStatus("t-react-locked"), "locked");

      const res = await reactivate("t-react-locked");
      assert.equal(res.status, 200);
      assert.equal(res.body["previousStatus"], "locked");
      assert.equal(durableStatus("t-react-locked"), "active");
    });
  });

  // ── Repeated transitions ──────────────────────────────────────────

  describe("repeating a transition", () => {
    test("terminate twice is idempotent and reports success both times", async () => {
      await ingest("t-term-twice", keystroke("t-term-twice"));

      assert.equal((await terminate("t-term-twice")).status, 200);
      const second = await terminate("t-term-twice");

      assert.equal(second.status, 200, "a repeated terminate was refused");
      assert.equal(second.body["success"], true);
      assert.equal(durableStatus("t-term-twice"), "terminated");
    });

    test("reactivate twice is idempotent", async () => {
      await ingest("t-react-twice", keystroke("t-react-twice"));

      assert.equal((await reactivate("t-react-twice")).status, 200);
      const second = await reactivate("t-react-twice");

      assert.equal(second.status, 200);
      assert.equal(second.body["previousStatus"], "active");
      assert.equal(durableStatus("t-react-twice"), "active");
    });

    test("a repeated terminate does not resurrect the live-registry entry", async () => {
      await ingest("t-term-registry", keystroke("t-term-registry"));
      await terminate("t-term-registry");
      await terminate("t-term-registry");

      const list = await app.request("/api/v1/guardian/sessions", {
        headers: authorizedHeaders(),
      });
      const body = (await list.json()) as { data: Array<Record<string, unknown>> };
      assert.equal(
        body.data.find((entry) => entry["sessionId"] === "t-term-registry"),
        undefined,
        "a terminated session reappeared in the live list",
      );
    });
  });

  // ── Disallowed transitions ────────────────────────────────────────

  describe("disallowed transitions", () => {
    test("terminated → active via reactivate is refused", async () => {
      await ingest("t-term-react", keystroke("t-term-react"));
      await terminate("t-term-react");

      const res = await reactivate("t-term-react");

      assert.equal(res.status, 409);
      assert.equal(res.body["code"], SESSION_TRANSITION_CODES.SESSION_TERMINAL);
      assert.equal(res.body["status"], "terminated");
      assert.equal(durableStatus("t-term-react"), "terminated");
    });

    test("terminated → locked via auto-lock is refused", async () => {
      // Reached directly, because ingest now refuses a terminated session before the
      // analysis path runs. This pins the second line of defence.
      swapStub(HIGH_RISK_AI);

      await ingest("t-term-lock", keystroke("t-term-lock"));
      await terminate("t-term-lock");

      const transitions = createSessionTransitions({
        config: makeConfigWithTtl(3600),
        cache: nullCache(),
      });
      const result = await transitions.autoLock("t-term-lock");

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, SESSION_TRANSITION_CODES.SESSION_TERMINAL);
      assert.equal(durableStatus("t-term-lock"), "terminated");
    });

    test("a transition for an unknown session is 404", async () => {
      assert.equal((await terminate("nope-terminate")).status, 404);
      assert.equal((await reactivate("nope-reactivate")).status, 404);
    });
  });

  // ── Restart ───────────────────────────────────────────────────────

  describe("after a restart", () => {
    /** A fresh process: empty in-memory registries over the same durable store. */
    function freshApp(): ReturnType<typeof createApp> {
      return createApp(makeConfigWithTtl(3600));
    }

    test("a terminated session is not resurrected as live", async () => {
      await ingest("r-terminated", keystroke("r-terminated"));
      await terminate("r-terminated");

      const restarted = freshApp();
      const list = await restarted.request("/api/v1/guardian/sessions", {
        headers: authorizedHeaders(),
      });
      const body = (await list.json()) as { data: Array<Record<string, unknown>> };
      assert.equal(
        body.data.find((entry) => entry["sessionId"] === "r-terminated"),
        undefined,
        "a restart brought a terminated session back into the live list",
      );
    });

    test("a restarted process still refuses ingest for a terminated session", async () => {
      await ingest("r-terminated-ingest", keystroke("r-terminated-ingest"));
      await terminate("r-terminated-ingest");

      const restarted = freshApp();
      const res = await restarted.request("/api/v1/guardian/ingest", {
        method: "POST",
        headers: authorizedHeaders(),
        body: JSON.stringify({ events: [largePaste("r-terminated-ingest")] }),
      });

      assert.equal(res.status, 409);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, SESSION_TRANSITION_CODES.SESSION_TERMINAL);
    });

    test("a lock survives a restart", async () => {
      swapStub(HIGH_RISK_AI);
      await ingest("r-locked", largePaste("r-locked"));
      assert.equal(durableStatus("r-locked"), "locked");

      const restarted = freshApp();

      // The live list is the documented recovery path: it is the only in-memory
      // surface that rebuilds the registry from MongoDB. `GET /guardian/sessions/:id`
      // reads memory only and has no durable fallback of its own — a gap recorded in
      // `docs/development/state-transition-model.md`, not asserted here.
      const list = await restarted.request("/api/v1/guardian/sessions", {
        headers: authorizedHeaders(),
      });
      const listed = (await list.json()) as { data: Array<Record<string, unknown>> };
      const entry = listed.data.find((row) => row["sessionId"] === "r-locked");

      assert.ok(entry, "a restart lost the session entirely");
      assert.equal(
        entry["status"],
        "locked",
        "a restart lost a durable lock — this is the divergence the boundary removes",
      );

      // And the detail route agrees, now that recovery has run.
      const res = await restarted.request("/api/v1/guardian/sessions/r-locked", {
        headers: authorizedHeaders(),
      });
      const body = (await res.json()) as { session: { status: string } };
      assert.equal(body.session.status, "locked");
    });

    test("a durable lock is visible through the review surface without recovery", async () => {
      // The review route reads the durable document directly, so it is the surface a
      // caller can trust immediately after a restart.
      swapStub(HIGH_RISK_AI);
      await ingest("r-locked-review", largePaste("r-locked-review"));

      const restarted = freshApp();
      const res = await restarted.request("/api/v1/sessions/r-locked-review", {
        headers: authorizedHeaders(),
      });
      const body = (await res.json()) as { data: { status: string } };
      assert.equal(body.data.status, "locked");
    });
  });

  // ── Stale cache vs newer durable state ────────────────────────────

  describe("when the cache disagrees with the durable document", () => {
    test("the durable status decides, not the cache", async () => {
      // This process holds the session as `active`. Another writer terminates it
      // durably. Reactivate must read the truth rather than trusting its own cache.
      await ingest("c-stale", keystroke("c-stale"));
      await mcp.setSessionStatus("c-stale", "terminated");

      const res = await reactivate("c-stale");

      assert.equal(res.status, 409, "the cache was trusted over the durable document");
      assert.equal(res.body["code"], SESSION_TRANSITION_CODES.SESSION_TERMINAL);
    });

    test("a refusal reconciles the cache to the durable value", async () => {
      await ingest("c-reconcile", keystroke("c-reconcile"));
      await mcp.setSessionStatus("c-reconcile", "terminated");

      // The refusal reads `terminated` and repairs the cache from it, so the read
      // paths stop reporting the stale value.
      await reactivate("c-reconcile");

      const detail = await app.request("/api/v1/guardian/sessions/c-reconcile", {
        headers: authorizedHeaders(),
      });
      const body = (await detail.json()) as { session: { status: string } };
      assert.equal(
        body.session.status,
        "terminated",
        "the stale cache value was still being reported after a refusal that read the truth",
      );
    });

    test("a durable lock the cache does not know about is applied, not ignored", async () => {
      // The reverse direction: memory says `active`, durable says `locked`. A
      // reactivate is legal from `locked`, so it must succeed and report the true
      // previous status rather than the cached one.
      await ingest("c-stale-locked", keystroke("c-stale-locked"));
      await mcp.setSessionStatus("c-stale-locked", "locked");

      const res = await reactivate("c-stale-locked");

      assert.equal(res.status, 200);
      assert.equal(
        res.body["previousStatus"],
        "locked",
        "the reported previous status came from the cache",
      );
      assert.equal(durableStatus("c-stale-locked"), "active");
    });
  });

  // ── Concurrency ───────────────────────────────────────────────────

  describe("concurrent transitions", () => {
    test("terminate racing auto-lock: exactly one applies, the loser is a conflict", async () => {
      // Both read `active` before either writes, which is the interleaving the
      // predicate exists for. Deterministic, because the two reads are started
      // together and the writes are serialised by the event loop — no sleeps.
      await ingest("k-race", keystroke("k-race"));

      const transitions = createSessionTransitions({
        config: makeConfigWithTtl(3600),
        cache: nullCache(),
      });

      const [terminateResult, lockResult] = await Promise.all([
        transitions.terminate("k-race"),
        transitions.autoLock("k-race"),
      ]);

      const applied = [terminateResult, lockResult].filter(
        (result) => result.ok && result.applied,
      );
      const refused = [terminateResult, lockResult].filter((result) => !result.ok);

      assert.equal(applied.length, 1, "both racing transitions were applied");
      assert.equal(refused.length, 1, "the losing transition did not report a refusal");

      const loser = refused[0];
      if (loser.ok) return;
      assert.equal(
        loser.code,
        SESSION_TRANSITION_CODES.SESSION_CONFLICT,
        `the loser reported ${loser.code} rather than a conflict`,
      );

      // The durable status is the winner's, and it is a legal state.
      const finalStatus = durableStatus("k-race");
      assert.ok(
        finalStatus === "terminated" || finalStatus === "locked",
        `the race left an illegal status: ${String(finalStatus)}`,
      );
      const winner = applied[0];
      if (winner.ok) assert.equal(finalStatus, winner.status);
    });

    test("two terminates racing both succeed and leave one terminated session", async () => {
      // Terminate is idempotent, so a lost race is not a conflict — both callers asked
      // for the same end state and both get it.
      await ingest("k-two-terminates", keystroke("k-two-terminates"));

      const transitions = createSessionTransitions({
        config: makeConfigWithTtl(3600),
        cache: nullCache(),
      });

      const results = await Promise.all([
        transitions.terminate("k-two-terminates"),
        transitions.terminate("k-two-terminates"),
      ]);

      assert.ok(
        results.every((result) => result.ok),
        "an idempotent transition reported a failure under concurrency",
      );
      assert.equal(durableStatus("k-two-terminates"), "terminated");
    });

    test("two ingests racing do not double-count", async () => {
      // Two batches with distinct eventIds, sent together. Both must be stored and
      // counted exactly once each.
      const [first, second] = await Promise.all([
        ingest("k-ingest", keystroke("k-ingest", "race-a", 100)),
        ingest("k-ingest", keystroke("k-ingest", "race-b", 200)),
      ]);

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);

      const events = await mcp.getSessionEvents("k-ingest");
      assert.equal(events.length, 2, "a racing ingest lost or duplicated an event");
      assert.equal((await mcp.getSession("k-ingest"))?.["eventCount"], 2);
    });

    test("a duplicate event in two concurrent batches is stored once", async () => {
      const event = keystroke("k-dup", "shared-event-id", 150);

      const results = await Promise.all([
        ingest("k-dup", event),
        ingest("k-dup", event),
      ]);

      assert.equal(results[0].status, 200);
      assert.equal(results[1].status, 200);

      const events = await mcp.getSessionEvents("k-dup");
      assert.equal(events.length, 1, "a concurrently retried event was stored twice");

      const acceptedTotal = results.reduce(
        (sum, result) => sum + Number(result.body["acceptedCount"] ?? 0),
        0,
      );
      assert.equal(acceptedTotal, 1, "the accepted report counted the event twice");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 2 — the boundary in isolation
// ═══════════════════════════════════════════════════════════════════

/** A cache that records nothing, for tests that assert only the durable outcome. */
function nullCache(): SessionTransitionCache {
  return {
    read: () => null,
    apply: () => {},
    evict: () => {},
  };
}

/** A cache backed by a map, for tests that assert what the boundary repairs. */
function recordingCache() {
  const statuses = new Map<string, PersistedSessionStatus>();
  const evicted: string[] = [];
  const cache: SessionTransitionCache = {
    read: (sessionId) => statuses.get(sessionId) ?? null,
    apply: (sessionId, status) => {
      statuses.set(sessionId, status);
    },
    evict: (sessionId) => {
      evicted.push(sessionId);
    },
  };
  return { cache, statuses, evicted };
}

describe("session transition boundary", () => {
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

  function boundary(cache: SessionTransitionCache = nullCache()) {
    return createSessionTransitions({
      config: makeConfigWithTtl(3600),
      cache,
      clock: createManualClock(Date.parse("2026-06-01T12:00:00.000Z")),
    });
  }

  async function seed(sessionId: string, status: DurableSessionStatus): Promise<void> {
    await mcp.createSession({ sessionId, employeeId: "op-1", auditId: "audit-1" });
    await mcp.setSessionStatus(sessionId, status);
  }

  test("acceptsTelemetry is false only for a terminated session", () => {
    assert.equal(acceptsTelemetry("terminated"), false);
    for (const status of ["active", "locked", "flagged", "investigating", "cleared"] as const) {
      assert.equal(acceptsTelemetry(status), true, `${status} should accept telemetry`);
    }
  });

  test("a store that does not answer is 503 and changes nothing", async () => {
    await seed("b-store-down", "active");
    mcp.failToolTransport("get_session_review");

    const result = await boundary().terminate("b-store-down");

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, SESSION_TRANSITION_CODES.SESSION_STORE_UNAVAILABLE);
    assert.equal(result.httpStatus, 503);
    assert.equal(mcp.sessions.get("b-store-down")?.["status"], "active");
  });

  test("a status write that does not answer is 503 and leaves the old status", async () => {
    // The read succeeds, so the transition is legal; only the write fails. The
    // previous implementation reported `200 success: true` here.
    await seed("b-write-down", "active");
    mcp.failToolTransport("set_session_status");

    const result = await boundary().terminate("b-write-down");

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, SESSION_TRANSITION_CODES.SESSION_STORE_UNAVAILABLE);
    assert.equal(
      mcp.sessions.get("b-write-down")?.["status"],
      "active",
      "the durable status changed despite the write failing",
    );
  });

  test("a write the store refuses is a conflict, not a success", async () => {
    // `updated: false` is what the compare-and-set returns when the predicate did not
    // match. Simulated by making the write report that.
    await seed("b-conflict", "active");
    stub.restore();
    stub = installFetchStub({
      mcpResponse: async (tool, body) => {
        if (tool === "set_session_status") {
          return Response.json({ success: true, status: body["status"], updated: false });
        }
        return mcp.responder()(tool, body);
      },
    });

    const result = await boundary().terminate("b-conflict");

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, SESSION_TRANSITION_CODES.SESSION_CONFLICT);
    assert.equal(result.httpStatus, 409);
  });

  test("a document holding a derived status is refused as an invalid transition", async () => {
    // `flagged` is never written, so a document holding it is a data-integrity
    // problem. It is not terminal, so the refusal says "not a legal start state"
    // rather than pretending the session has ended.
    await mcp.createSession({ sessionId: "b-derived", employeeId: "op-1", auditId: "a" });
    mcp.sessions.get("b-derived")!["status"] = "flagged";

    const result = await boundary().terminate("b-derived");

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, SESSION_TRANSITION_CODES.INVALID_SESSION_TRANSITION);
  });

  test("a legal no-op reports applied: false and writes no status", async () => {
    await seed("b-noop", "active");
    const before = mcp.sessions.get("b-noop")?.["updatedAt"];

    const result = await boundary().reactivate("b-noop");

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.applied, false, "a no-op reported that it applied a change");
    assert.equal(result.previousStatus, "active");
    assert.equal(
      mcp.sessions.get("b-noop")?.["updatedAt"],
      before,
      "a no-op wrote the document",
    );
  });

  test("the cache is repaired from the durable outcome, not from the intent", async () => {
    const { cache, statuses, evicted } = recordingCache();
    await seed("b-cache", "active");

    const result = await boundary(cache).terminate("b-cache");

    assert.equal(result.ok, true);
    assert.equal(statuses.get("b-cache"), "terminated");
    assert.deepEqual(evicted, ["b-cache"], "terminate did not evict the live registry");
  });

  test("a refused transition does not apply the requested change to the cache", async () => {
    const { cache, statuses } = recordingCache();
    await seed("b-cache-refused", "terminated");
    statuses.set("b-cache-refused", "active");

    const result = await boundary(cache).reactivate("b-cache-refused");

    assert.equal(result.ok, false);
    assert.equal(
      statuses.get("b-cache-refused"),
      "terminated",
      "a refused transition left the cache claiming a status it did not reach",
    );
  });

  test("a failed durable write does not change the cache", async () => {
    const { cache, statuses } = recordingCache();
    await seed("b-cache-failed", "active");
    statuses.set("b-cache-failed", "active");
    mcp.failToolTransport("set_session_status");

    const result = await boundary(cache).terminate("b-cache-failed");

    assert.equal(result.ok, false);
    assert.equal(
      statuses.get("b-cache-failed"),
      "active",
      "a cache was updated for a transition that did not durably happen",
    );
  });

  test("terminal content is written only for a session that exists", async () => {
    await seed("b-content", "active");

    const written = await boundary().updateTerminalContent("b-content", "WORKSPACE");
    assert.equal(written.ok, true);
    assert.equal((await mcp.getSession("b-content"))?.["terminalContent"], "WORKSPACE");

    const missing = await boundary().updateTerminalContent("b-content-missing", "GHOST");
    assert.equal(missing.ok, false);
    if (missing.ok) return;
    assert.equal(missing.code, SESSION_TRANSITION_CODES.SESSION_NOT_FOUND);
  });

  test("every refusal carries a client-facing message and no internal detail", async () => {
    await seed("b-message", "terminated");

    const result = await boundary().reactivate("b-message");

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.message.length > 0);
    assert.doesNotMatch(result.message, /\bat \w+ \(/, "a stack frame leaked into a message");
    assert.doesNotMatch(result.message, /MongoServerError|ECONNREFUSED/);
  });
});

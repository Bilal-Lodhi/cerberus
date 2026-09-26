/**
 * The live session list across **two API processes and one database**.
 *
 * ── What this suite is ────────────────────────────────────────────────
 *
 * Every other session suite runs one app instance. That is the shape the live read paths
 * were written for, and it is why the defect this file exists for went unnoticed: with one
 * process, "read this process's memory" and "read the truth" are the same instruction.
 *
 * Here two `createApp()` instances share one `McpStoreDouble`, which is two API processes
 * against one MongoDB. The double implements the real tool registry and applies the
 * production update document, so `$max` counters and `$setOnInsert` event identity are the
 * real ones. What is not real is the network hop and the BSON encoding — that is what
 * `state-flows.test.ts` and the real-Mongo integration job cover.
 *
 * ── The two defects it pins ───────────────────────────────────────────
 *
 *   1. **A durably terminated session was reported live.** Process A terminates it; B still
 *      holds it with its old status, and B's live list kept returning `active` until the TTL
 *      elapsed, a transition happened to run through B's boundary, or B restarted.
 *   2. **Another process's sessions were missing.** B's registry holds only what B deployed,
 *      and the durable query ran only when B's memory was *empty* — so with B holding any
 *      local session at all, A's sessions never appeared.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import { MCP_TOOL_NAMES } from "../src/services/mcp-tool-names.js";
import { authorizedHeaders, installFetchStub, makeConfigWithTtl, type FetchStub } from "./helpers.js";
import { McpStoreDouble } from "./support/mcp-store-double.js";

type App = ReturnType<typeof createApp>;

let stub: FetchStub;
let mcp: McpStoreDouble;
/** Two API processes. One shared store, reached through the same `fetch` stub. */
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

/**
 * A keystroke event.
 *
 * Deliberately a signal event with a slow rhythm: it advances `eventCount` and nothing
 * else, so these tests never reach the paid analysis path and never depend on a score.
 */
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

async function ingest(
  target: App,
  sessionId: string,
  events: Array<Record<string, unknown>>,
): Promise<void> {
  const response = await target.request("/api/v1/guardian/ingest", {
    method: "POST",
    headers: authorizedHeaders(),
    body: JSON.stringify({ events }),
  });
  // Read the body only on failure: an assertion message is evaluated eagerly, so putting
  // `await response.text()` in one consumes the body even when the assertion passes.
  if (response.status !== 200) {
    assert.fail(`ingest failed (${response.status}): ${await response.text()}`);
  }
}

interface LiveListBody {
  success: boolean;
  data: Array<Record<string, unknown>>;
  reconciled: boolean;
}

async function liveList(target: App): Promise<LiveListBody> {
  const response = await target.request("/api/v1/guardian/sessions", {
    headers: authorizedHeaders(),
  });
  if (response.status !== 200) {
    assert.fail(`live list failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as LiveListBody;
}

async function liveListRow(target: App, sessionId: string) {
  const body = await liveList(target);
  return body.data.find((row) => row["sessionId"] === sessionId);
}

async function terminate(target: App, sessionId: string): Promise<void> {
  const response = await target.request(
    `/api/v1/guardian/sessions/${sessionId}/terminate`,
    { method: "POST", headers: authorizedHeaders() },
  );
  if (response.status !== 200) {
    assert.fail(`terminate failed (${response.status}): ${await response.text()}`);
  }
}

describe("process B's live list and process A's sessions", () => {
  test("a session only process A has ingested is visible to process B", async () => {
    await ingest(processA, "mw-a-only", [keystroke("mw-a-only"), keystroke("mw-a-only")]);

    // B holds nothing for this session: it never deployed it and never ingested for it.
    const row = await liveListRow(processB, "mw-a-only");

    assert.ok(row, "process B's live list omitted a session only process A had ingested");
    assert.equal(row["statusSource"], "durable");
    assert.equal(row["status"], "active");
    // B has no workspace for it, and says so rather than implying one.
    assert.equal(row["ephemeralStateAvailable"], false);
  });

  test("a session process A deployed is visible to process B before any telemetry", async () => {
    const deployed = await processA.request("/api/v1/guardian/deploy", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        employeeUid: "op-trader-001",
        sessionId: "mw-deployed",
        matrixId: "audit-2026-q1",
        targetSystem: "Core Trading Ledger",
      }),
    });
    assert.equal(deployed.status, 201, await deployed.text());

    const row = await liveListRow(processB, "mw-deployed");
    assert.ok(row, "process B's live list omitted a session process A deployed");
    assert.equal(row["status"], "active");
  });

  test("the durable counters process A wrote are the ones process B reports", async () => {
    await ingest(processA, "mw-counters", [
      keystroke("mw-counters"),
      keystroke("mw-counters"),
      keystroke("mw-counters"),
    ]);

    const row = await liveListRow(processB, "mw-counters");

    assert.ok(row);
    // B ingested nothing, so a process-local count would be 0. Before the durable query ran
    // on every request, this is what B reported.
    assert.equal(row["eventCount"], 3);
  });
});

describe("process A terminates a session process B is holding", () => {
  test("process B stops reporting it live in the same request that would have", async () => {
    // B holds the session in its own memory, which is the state that used to defeat the
    // durable path: the query ran only when B's memory was empty.
    await ingest(processB, "mw-terminated", [keystroke("mw-terminated")]);
    assert.ok(await liveListRow(processB, "mw-terminated"), "precondition: B lists it");

    await terminate(processA, "mw-terminated");

    const row = await liveListRow(processB, "mw-terminated");
    assert.equal(
      row,
      undefined,
      "process B still reported a durably terminated session as live",
    );
  });

  test("the row is gone even though the review surfaces still show it as terminated", async () => {
    await ingest(processB, "mw-review", [keystroke("mw-review")]);
    await terminate(processA, "mw-review");

    // The live list is not live; the review surfaces retain the evidence.
    assert.equal(await liveListRow(processB, "mw-review"), undefined);

    const review = await processB.request("/api/v1/sessions/mw-review", {
      headers: authorizedHeaders(),
    });
    assert.equal(review.status, 200);
    const body = (await review.json()) as { data?: Record<string, unknown> };
    assert.equal(body.data?.["status"], "terminated");
  });

  test("process B's cached status is repaired, so a later unreconciled read is still true", async () => {
    await ingest(processB, "mw-repair", [keystroke("mw-repair")]);
    await terminate(processA, "mw-repair");

    // The reconciled read drops it and repairs B's cache toward the document.
    assert.equal(await liveListRow(processB, "mw-repair"), undefined);

    // Now the store stops answering. The statuses on this page are B's own — and because the
    // cache was repaired rather than left stale, the terminated session is still excluded.
    // Without the repair this read would report it as `active` again, which is the whole
    // reason the repair is one-directional and part of the read path.
    mcp.failToolTransport(MCP_TOOL_NAMES.LIST_SESSIONS, "mongo unreachable");

    const body = await liveList(processB);
    assert.equal(body.reconciled, false);
    assert.equal(
      body.data.find((row) => row["sessionId"] === "mw-repair"),
      undefined,
      "a stale cache re-reported a terminated session once the store stopped answering",
    );
  });
});

describe("when the store does not answer", () => {
  test("the page is served, marked unreconciled, and every row is labelled process-local", async () => {
    await ingest(processB, "mw-unreconciled", [keystroke("mw-unreconciled")]);
    mcp.failToolTransport(MCP_TOOL_NAMES.LIST_SESSIONS, "mongo unreachable");

    const body = await liveList(processB);

    // Refusing outright would take the live dashboard down during a store blip. Claiming the
    // value is durable would be a lie. So it is served, and it is labelled.
    assert.equal(body.reconciled, false);
    const row = body.data.find((entry) => entry["sessionId"] === "mw-unreconciled");
    assert.ok(row);
    assert.equal(row["statusSource"], "process-local");
  });

  test("an unreachable store is not reported as an empty page", async () => {
    await ingest(processB, "mw-not-empty", [keystroke("mw-not-empty")]);
    mcp.failToolTransport(MCP_TOOL_NAMES.LIST_SESSIONS, "mongo unreachable");

    const body = await liveList(processB);

    assert.equal(body.success, true);
    assert.equal(body.data.length, 1);
  });
});

describe("the reconciled flag", () => {
  test("a normal list reports itself reconciled", async () => {
    await ingest(processA, "mw-flag", [keystroke("mw-flag")]);

    const body = await liveList(processB);
    assert.equal(body.reconciled, true);
  });

  test("every row on a reconciled page says which source answered for its status", async () => {
    await ingest(processA, "mw-sources", [keystroke("mw-sources")]);
    await ingest(processB, "mw-local", [keystroke("mw-local")]);

    const body = await liveList(processB);

    for (const row of body.data) {
      assert.ok(
        row["statusSource"] === "durable" || row["statusSource"] === "process-local",
        `row ${String(row["sessionId"])} had no usable statusSource`,
      );
    }
    // Both sessions exist durably, so both statuses came from the document.
    assert.equal(body.data.every((row) => row["statusSource"] === "durable"), true);
  });
});

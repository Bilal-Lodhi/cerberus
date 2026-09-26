/**
 * Two API processes, one real MongoDB.
 *
 * ── Why this suite exists ─────────────────────────────────────────────
 *
 * Every other session suite runs one app instance, and the in-process multi-writer suites run
 * two app instances against one **double**. Neither exercises the combination this phase is
 * about: **two real processes, the real tool registry, the real MongoDB driver, one set of
 * documents.**
 *
 * That combination is where the multi-writer defects actually live, for the same reason the
 * single-writer defects lived there: a double agrees with the route about what an update means,
 * and MongoDB decides for itself. `$max` on an absolute counter, a compare-and-set that matches
 * nothing, `$inc` applied per document — all of those are driver behaviours, and none of them
 * can be observed through a double.
 *
 * ── Gating ────────────────────────────────────────────────────────────
 *
 * Runs when `CERBERUS_TEST_MONGODB_URI` is set and is **skipped with a stated reason** when it
 * is not. CI provides a `mongo:7` and asserts that nothing was skipped, so a green run means
 * this actually ran.
 *
 * ── Deterministic, not sleep-based ────────────────────────────────────
 *
 * Where an ordering is needed it is established by awaiting the first operation, not by
 * sleeping. Where genuine interleaving is the point — two terminates racing — the operations are
 * issued together with `Promise.all` and the assertion is the **invariant** that must hold under
 * any interleaving, rather than a guess about which one wins.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { MongoClient } from "mongodb";

import { MongoStore } from "../../../../packages/mcp-mongodb/src/mongo-client.js";
import { createApp } from "../../src/index.js";
import { resetAIProvider } from "../../src/ai/provider.js";
import {
  authorizedHeaders,
  installFetchStub,
  makeConfigWithTtl,
  type FetchStub,
} from "../helpers.js";
import { realStoreResponder } from "../support/real-store-responder.js";

const REAL_MONGODB_URI = process.env["CERBERUS_TEST_MONGODB_URI"]?.trim() ?? "";

type App = ReturnType<typeof createApp>;

/** A keystroke: advances `eventCount` and nothing else, so no paid analysis runs. */
function keystroke(sessionId: string, eventId: string): Record<string, unknown> {
  return {
    eventId,
    sessionId,
    employeeId: "op-trader-001",
    auditId: "audit-2026-q1",
    vectorId: "tv-1",
    eventType: "KEYSTROKE",
    timestamp: new Date().toISOString(),
    payload: { deltaMs: 500 },
    clientMetadata: { userAgent: "multi-process", platform: "web" },
  };
}

/** A large paste, so the workspace is set and a high-risk analysis runs. */
function largePaste(sessionId: string, eventId: string, text: string): Record<string, unknown> {
  return {
    eventId,
    sessionId,
    employeeId: "op-trader-001",
    auditId: "audit-2026-q1",
    vectorId: "tv-1",
    eventType: "PASTE",
    timestamp: new Date().toISOString(),
    payload: { newText: text, changeLength: text.length },
    clientMetadata: { userAgent: "multi-process", platform: "web" },
  };
}

async function withTwoProcesses(
  run: (context: {
    processA: App;
    processB: App;
    store: MongoStore;
    restartA: () => App;
    databaseName: string;
  }) => Promise<void>,
  options: { aiResponse?: string } = {},
): Promise<void> {
  const databaseName = `cerberus_multi_process_${randomUUID().replace(/-/g, "")}`;
  const store = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });
  await store.connect();

  const stub = installFetchStub({
    mcpResponse: realStoreResponder(store),
    ...(options.aiResponse ? { aiResponse: options.aiResponse } : {}),
  });

  try {
    const config = makeConfigWithTtl(3600);
    await run({
      // Two processes. Both reach the same store, through the same seam a real HTTP hop to the
      // adapter would use, and neither shares any in-memory state with the other.
      processA: createApp(config),
      processB: createApp(config),
      store,
      restartA: () => createApp(config),
      databaseName,
    });
  } finally {
    stub.restore();
    resetAIProvider();
    await store.disconnect();

    const client = new MongoClient(REAL_MONGODB_URI);
    try {
      await client.connect();
      await client.db(databaseName).dropDatabase();
    } finally {
      await client.close();
    }
  }
}

async function ingest(
  target: App,
  events: Array<Record<string, unknown>>,
): Promise<void> {
  const response = await target.request("/api/v1/guardian/ingest", {
    method: "POST",
    headers: authorizedHeaders(),
    body: JSON.stringify({ events }),
  });
  if (response.status !== 200) {
    assert.fail(`ingest failed (${response.status}): ${await response.text()}`);
  }
}

async function liveList(target: App): Promise<Array<Record<string, unknown>>> {
  const response = await target.request("/api/v1/guardian/sessions", {
    headers: authorizedHeaders(),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { data: Array<Record<string, unknown>> }).data;
}

async function liveListRow(target: App, sessionId: string) {
  return (await liveList(target)).find((row) => row["sessionId"] === sessionId);
}

async function liveDetail(target: App, sessionId: string) {
  const response = await target.request(`/api/v1/guardian/sessions/${sessionId}`, {
    headers: authorizedHeaders(),
  });
  // Read the body only on failure: an assertion message is evaluated eagerly, so putting
  // `await response.text()` in one consumes the body even when the assertion passes.
  if (response.status !== 200) {
    assert.fail(`live detail failed (${response.status}): ${await response.text()}`);
  }
  return ((await response.json()) as { session: Record<string, unknown> }).session;
}

async function reviewDetail(target: App, sessionId: string) {
  const response = await target.request(`/api/v1/sessions/${sessionId}`, {
    headers: authorizedHeaders(),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}

async function terminate(target: App, sessionId: string): Promise<number> {
  const response = await target.request(
    `/api/v1/guardian/sessions/${sessionId}/terminate`,
    { method: "POST", headers: authorizedHeaders() },
  );
  return response.status;
}

async function durableCounters(store: MongoStore, sessionId: string) {
  const document = await store.getSession(sessionId);
  assert.ok(document, `no durable document for ${sessionId}`);
  return {
    eventCount: Number(document["eventCount"] ?? 0),
    pasteCount: Number(document["pasteCount"] ?? 0),
    focusLossCount: Number(document["focusLossCount"] ?? 0),
  };
}

if (REAL_MONGODB_URI) {
  describe("multi-process — two API processes against one real MongoDB", () => {
    beforeEach(() => resetAIProvider());
    afterEach(() => resetAIProvider());

    // ── Counters under two writers ────────────────────────────────────

    test("two processes accepting distinct events both count", async () => {
      await withTwoProcesses(async ({ processA, processB, store }) => {
        const sessionId = "mp-counters";

        // A creates the session and takes a baseline.
        await ingest(processA, [keystroke(sessionId, "a1"), keystroke(sessionId, "a2"), keystroke(sessionId, "a3")]);
        assert.equal((await durableCounters(store, sessionId)).eventCount, 3);

        // B has never seen the session, so it hydrates from the document and adds its own two.
        await ingest(processB, [keystroke(sessionId, "b1"), keystroke(sessionId, "b2")]);

        assert.equal(
          (await durableCounters(store, sessionId)).eventCount,
          5,
          "a concurrent writer's events were lost from the durable total",
        );
      });
    });

    test("two processes ingesting at the same time still produce the sum", async () => {
      await withTwoProcesses(async ({ processA, processB, store }) => {
        const sessionId = "mp-concurrent-counters";
        // The session must exist first, so this measures the counter race rather than a
        // concurrent create.
        await ingest(processA, [keystroke(sessionId, "seed")]);

        // Issued together, so the two counter writes genuinely interleave. The assertion is the
        // invariant that must hold under **any** interleaving: five distinct events were
        // accepted, so the durable total is five.
        await Promise.all([
          ingest(processA, [keystroke(sessionId, "a1"), keystroke(sessionId, "a2"), keystroke(sessionId, "a3")]),
          ingest(processB, [keystroke(sessionId, "b1"), keystroke(sessionId, "b2")]),
        ]);

        assert.equal((await durableCounters(store, sessionId)).eventCount, 6);
      });
    });

    test("the same event sent to both processes is counted once", async () => {
      await withTwoProcesses(async ({ processA, processB, store }) => {
        const sessionId = "mp-duplicate";

        await ingest(processA, [keystroke(sessionId, "shared")]);
        // A different process, a different in-process dedup ring, the same durable identity.
        await ingest(processB, [keystroke(sessionId, "shared")]);

        assert.equal((await durableCounters(store, sessionId)).eventCount, 1);
      });
    });

    // ── Reads across processes ────────────────────────────────────────

    test("a session process A created is visible to process B's live list and detail", async () => {
      await withTwoProcesses(async ({ processA, processB }) => {
        const sessionId = "mp-visibility";
        await ingest(processA, [keystroke(sessionId, "a1")]);

        const row = await liveListRow(processB, sessionId);
        assert.ok(row, "process B's live list omitted a session process A created");
        assert.equal(row["statusSource"], "durable");

        const detail = await liveDetail(processB, sessionId);
        assert.equal(detail["sessionId"], sessionId);
        assert.equal(detail["eventCount"], 1);
        assert.equal(detail["source"], "durable");
        assert.equal(detail["ephemeralStateAvailable"], false);
      });
    });

    test("process B reports the status process A set, on every surface", async () => {
      await withTwoProcesses(async ({ processA, processB }) => {
        const sessionId = "mp-status";
        await ingest(processA, [keystroke(sessionId, "a1")]);

        const terminated = await terminate(processA, sessionId);
        assert.equal(terminated, 200);

        // The live list drops it, the live detail reports the durable status, and the review
        // surface agrees with both. One durable truth, three surfaces.
        assert.equal(await liveListRow(processB, sessionId), undefined);
        assert.equal((await liveDetail(processB, sessionId))["status"], "terminated");
        assert.equal((await reviewDetail(processB, sessionId))["status"], "terminated");
      });
    });

    test("process B's ingest is refused for a session process A terminated", async () => {
      await withTwoProcesses(async ({ processA, processB }) => {
        const sessionId = "mp-terminated-ingest";
        await ingest(processA, [keystroke(sessionId, "a1")]);
        assert.equal(await terminate(processA, sessionId), 200);

        const response = await processB.request("/api/v1/guardian/ingest", {
          method: "POST",
          headers: authorizedHeaders(),
          body: JSON.stringify({ events: [keystroke(sessionId, "late")] }),
        });

        assert.equal(response.status, 409, "a terminated session accepted telemetry");
        const body = (await response.json()) as { code?: string };
        assert.equal(body["code"], "SESSION_TERMINATED");
      });
    });

    // ── Two writers racing one session ────────────────────────────────

    test("two concurrent terminates leave one durable truth and one preserved workspace", async () => {
      await withTwoProcesses(
        async ({ processA, processB, store }) => {
          const sessionId = "mp-race-terminate";
          // Distinct workspaces, one per process, so the two preserves differ.
          await ingest(processA, [largePaste(sessionId, "a1", "A".repeat(300))]);
          await ingest(processB, [largePaste(sessionId, "b1", "B".repeat(300))]);

          const aWorkspace = String((await liveDetail(processA, sessionId))["currentCode"]);
          const bWorkspace = String((await liveDetail(processB, sessionId))["currentCode"]);

          // Issued together. Either may win; the invariant is that one of them does, and that
          // the loser does not overwrite what the winner preserved.
          const [statusA, statusB] = await Promise.all([
            terminate(processA, sessionId),
            terminate(processB, sessionId),
          ]);

          assert.ok(
            statusA === 200 || statusA === 409,
            `unexpected terminate status ${statusA}`,
          );
          assert.ok(
            statusB === 200 || statusB === 409,
            `unexpected terminate status ${statusB}`,
          );

          const document = await store.getSession(sessionId);
          assert.equal(document?.["status"], "terminated", "the session is not terminated");

          const preserved = String(document?.["terminalContent"] ?? "");
          assert.ok(
            preserved === aWorkspace || preserved === bWorkspace,
            `the preserved workspace is neither process's: ${JSON.stringify(preserved.slice(0, 20))}`,
          );

          // A third terminate must not change it. This is the stale-write-back the ownership
          // rule exists to prevent.
          await terminate(processA, sessionId);
          const after = await store.getSession(sessionId);
          assert.equal(after?.["terminalContent"], preserved);
        },
        {
          aiResponse: JSON.stringify({
            riskAssessmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            overallRiskScore: 90,
            dimensionScores: { dataExfiltration: 90, policyViolation: 85 },
            flags: [],
            exfiltrationReport: null,
            behavioralAnomalies: [],
            generatedAt: "2026-01-01T00:00:00.000Z",
          }),
        },
      );
    });

    test("a restart of one process does not disturb the other's view", async () => {
      await withTwoProcesses(async ({ processA, processB, store, restartA }) => {
        const sessionId = "mp-restart";
        await ingest(processA, [keystroke(sessionId, "a1"), keystroke(sessionId, "a2")]);

        // A fresh process A: empty memory, same documents. B is untouched and still holds the
        // session in its own memory.
        const freshA = restartA();

        assert.equal((await durableCounters(store, sessionId)).eventCount, 2);
        assert.equal((await liveDetail(freshA, sessionId))["eventCount"], 2);
        assert.equal((await liveDetail(processB, sessionId))["eventCount"], 2);

        // And B can still advance the session, with the restarted A observing it.
        await ingest(processB, [keystroke(sessionId, "b1")]);

        assert.equal((await durableCounters(store, sessionId)).eventCount, 3);
        assert.equal((await liveDetail(freshA, sessionId))["eventCount"], 3);
      });
    });
  });
} else {
  // The repository's convention: a precondition that is absent produces a **skip with a stated
  // reason**, never a pass. A pass here would say the two-process guarantees were exercised,
  // which is exactly the claim this file exists to make or to withhold.
  test(
    "skipped: CERBERUS_TEST_MONGODB_URI is not set",
    { skip: true },
    () => {},
  );
}

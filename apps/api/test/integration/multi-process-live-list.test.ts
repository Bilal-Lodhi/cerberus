/**
 * Two API processes, one real MongoDB, and the **live list** — the surface this cycle changed.
 *
 * ── Why this is separate from `multi-process.test.ts` ─────────────────
 *
 * That suite covers the multi-writer model: counters, cross-process visibility, concurrent
 * terminates, restart. This one covers the question the bounded query raises and nothing else did:
 * now that the list is answered by a **filtered** query rather than by a full scan, can a session
 * the durable record has finished with still reach the page — because this process holds it in
 * memory, because another process terminated it, or because a document arrived between the
 * migration and the query?
 *
 * The answer rests on one branch of the predicate. `list_sessions` is given this process's own
 * session ids, and returns their documents **whatever those documents say**; without that, a
 * durably-terminated session this process still holds would look absent durably, and the
 * reconciler would answer from the cache and republish it as live. Every test below is a way of
 * asking whether that branch is doing its job.
 *
 * ── What "request snapshot" means here, stated honestly ───────────────
 *
 * A list request reads the durable documents once, at one instant. A transition that commits
 * **after** that read is not in the answer, and cannot be: the response is a snapshot, and the
 * alternative — reading again per session — is the N+1 the list path must not have. So the
 * assertions are:
 *
 *   - a transition that committed **before** a read is always reflected in it;
 *   - a transition racing a read may land on either side, and the test asserts the **invariant**
 *     that holds under both orderings rather than guessing a winner;
 *   - a read issued **after** a racing transition settles always converges, and no session is
 *     ever *permanently* wrong.
 *
 * ── Gating ────────────────────────────────────────────────────────────
 *
 * Runs when `CERBERUS_TEST_MONGODB_URI` is set, and is **skipped with a stated reason** when it is
 * not. The CI integration job provides a `mongo:7` and asserts that nothing was skipped.
 */

import { test, describe } from "node:test";
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
} from "../helpers.js";
import { realStoreResponder } from "../support/real-store-responder.js";

const REAL_MONGODB_URI = process.env["CERBERUS_TEST_MONGODB_URI"]?.trim() ?? "";

type App = ReturnType<typeof createApp>;

/** A keystroke: advances `eventCount` and nothing else, so no paid analysis runs. */
function keystroke(sessionId: string, eventId: string): Record<string, unknown> {
  return {
    eventId,
    sessionId,
    employeeId: "op-live-list",
    auditId: "audit-live-list",
    vectorId: "tv-1",
    eventType: "KEYSTROKE",
    timestamp: new Date().toISOString(),
    payload: { deltaMs: 400 },
    clientMetadata: { userAgent: "multi-process-live-list", platform: "web" },
  };
}

/** Two processes over one database, both reaching the real store through the real tool registry. */
async function withTwoProcesses(
  run: (context: {
    processA: App;
    processB: App;
    store: MongoStore;
    restartA: () => App;
  }) => Promise<void>,
): Promise<void> {
  const databaseName = `cerberus_two_process_list_${randomUUID().replace(/-/g, "")}`;
  const store = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });
  // `connect()` applies the migrations and then creates the indexes, which is the documented path
  // — so both processes read through the **bounded** query rather than the fallback.
  await store.connect();
  assert.equal(
    store.liveListQueryIsBounded,
    true,
    "the store is not answering the bounded query, so this suite would not be testing it",
  );

  const stub = installFetchStub({ mcpResponse: realStoreResponder(store) });

  try {
    const config = makeConfigWithTtl(3600);
    await run({
      processA: createApp(config),
      processB: createApp(config),
      store,
      restartA: () => createApp(config),
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

async function ingest(target: App, events: Array<Record<string, unknown>>): Promise<void> {
  const response = await target.request("/api/v1/guardian/ingest", {
    method: "POST",
    headers: authorizedHeaders(),
    body: JSON.stringify({ events }),
  });
  if (response.status !== 200) {
    assert.fail(`ingest failed (${response.status}): ${await response.text()}`);
  }
}

/** The live list as a map from session id to row, so a missing session is visible. */
async function liveList(target: App): Promise<Map<string, Record<string, unknown>>> {
  const response = await target.request("/api/v1/guardian/sessions", {
    headers: authorizedHeaders(),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    data: Array<Record<string, unknown>>;
    reconciled: boolean;
  };
  assert.equal(body.reconciled, true, "the page was served unreconciled");
  return new Map(body.data.map((row) => [String(row["sessionId"]), row]));
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

if (REAL_MONGODB_URI) {
  describe("the bounded live list across two processes", () => {
    test("a session process A holds locally disappears once B terminates it", async () => {
      await withTwoProcesses(async ({ processA, processB }) => {
        const sessionId = "two-process-list-1";
        // A ingests, so **A holds the session in memory** — which is the case the predicate's
        // session-id branch exists for.
        await ingest(processA, [keystroke(sessionId, "evt-1")]);
        assert.ok(
          (await liveList(processA)).has(sessionId),
          "the session is not on A's list before it is terminated",
        );

        await terminate(processB, sessionId);

        // A still holds it. Without the session-id branch the query would not return its
        // document, the reconciler would see no durable record, and A would answer from its cache.
        const page = await liveList(processA);
        assert.equal(
          page.has(sessionId),
          false,
          "a durably terminated session is still on the list of the process that holds it locally",
        );

        // And B, which never held it, agrees.
        assert.equal((await liveList(processB)).has(sessionId), false);
      });
    });

    test("the terminated session stays gone, on every subsequent read", async () => {
      await withTwoProcesses(async ({ processA, processB }) => {
        const sessionId = "two-process-list-2";
        await ingest(processA, [keystroke(sessionId, "evt-1")]);
        await terminate(processB, sessionId);

        // The read that discovers the divergence repairs this process's cache, so no later read
        // has to rediscover it — and no later read may resurrect it.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          assert.equal(
            (await liveList(processA)).has(sessionId),
            false,
            `read ${attempt + 1} on A reported the terminated session as live`,
          );
        }
        assert.equal((await liveList(processB)).has(sessionId), false);
      });
    });

    test("the repaired cache refuses telemetry for the session B terminated", async () => {
      await withTwoProcesses(async ({ processA, processB }) => {
        const sessionId = "two-process-list-3";
        await ingest(processA, [keystroke(sessionId, "evt-1")]);
        await terminate(processB, sessionId);
        await liveList(processA);

        // The repair is one-directional — a read corrects the cache, never the document — and its
        // effect is that the terminal state is now this process's own knowledge too.
        const response = await processA.request("/api/v1/guardian/ingest", {
          method: "POST",
          headers: authorizedHeaders(),
          body: JSON.stringify({ events: [keystroke(sessionId, "evt-2")] }),
        });
        assert.equal(
          response.status,
          409,
          "telemetry was accepted for a session the durable record has terminated",
        );
      });
    });

    test("a list racing a terminate lands on one side or the other, and converges", async () => {
      await withTwoProcesses(async ({ processA, processB }) => {
        const sessionId = "two-process-list-4";
        await ingest(processA, [keystroke(sessionId, "evt-1")]);

        // Issued together, with no ordering imposed. Either ordering is a correct answer to a
        // snapshot read; what is not correct is a session that is *permanently* wrong, so the
        // invariant is asserted rather than a winner.
        const [racingPage] = await Promise.all([
          liveList(processA),
          terminate(processB, sessionId),
        ]);

        if (racingPage.has(sessionId)) {
          // The read was served from the durable state as it was *before* the terminate committed.
          assert.equal(
            racingPage.get(sessionId)?.["status"],
            "active",
            "the racing page reported a status the session never held",
          );
        }

        // Whichever side it landed on, the next read is correct on both processes.
        assert.equal((await liveList(processA)).has(sessionId), false);
        assert.equal((await liveList(processB)).has(sessionId), false);
      });
    });

    test("both processes see the same live set, from the bounded query", async () => {
      await withTwoProcesses(async ({ processA, processB }) => {
        // A creates and holds two sessions; B creates one it holds and one it does not.
        await ingest(processA, [keystroke("two-process-list-a1", "a-1")]);
        await ingest(processA, [keystroke("two-process-list-a2", "a-2")]);
        await ingest(processB, [keystroke("two-process-list-b1", "b-1")]);

        const pageA = await liveList(processA);
        const pageB = await liveList(processB);

        assert.deepEqual(
          [...pageA.keys()].sort(),
          [...pageB.keys()].sort(),
          "the two processes disagree about which sessions are live",
        );
        for (const sessionId of ["two-process-list-a1", "two-process-list-a2", "two-process-list-b1"]) {
          assert.ok(pageA.has(sessionId), `${sessionId} is missing from A's list`);
        }
      });
    });

    test("a restarted process answers from the bounded query and agrees with the other", async () => {
      await withTwoProcesses(async ({ processA, processB, restartA }) => {
        const sessionId = "two-process-list-5";
        await ingest(processA, [keystroke(sessionId, "evt-1")]);

        // A restart is a process with empty memory: it holds no session ids, so its first list is
        // the bounded query with no local branch at all.
        const fresh = restartA();
        const page = await liveList(fresh);
        assert.ok(page.has(sessionId), "the restarted process does not see the session");
        assert.equal(
          page.get(sessionId)?.["statusSource"],
          "durable",
          "the restarted process did not answer from durable truth",
        );

        await terminate(processB, sessionId);
        assert.equal((await liveList(fresh)).has(sessionId), false);
        assert.equal((await liveList(processA)).has(sessionId), false);
      });
    });

    test("a session written after the migration is on both lists, and its termination is too", async () => {
      await withTwoProcesses(async ({ processA, processB, store }) => {
        // A document created by the store **after** the migration pass has a `Date` `updatedAt`
        // and a durable status, which is the shape a straggler writes. The predicate's `updatedAt`
        // branch is what keeps it visible without any derived field having to be maintained.
        const sessionId = "two-process-list-6";
        await store.createSession({
          sessionId,
          employeeId: "op-live-list",
          auditId: "audit-live-list",
          matrixId: "audit-live-list",
          targetSystem: "straggler",
          status: "active",
        });

        assert.ok((await liveList(processA)).has(sessionId), "a freshly written session is missing");
        assert.ok((await liveList(processB)).has(sessionId), "a freshly written session is missing");

        await terminate(processB, sessionId);
        assert.equal((await liveList(processA)).has(sessionId), false);
        assert.equal((await liveList(processB)).has(sessionId), false);
      });
    });
  });
} else {
  test(
    "the bounded live list across two processes",
    { skip: "CERBERUS_TEST_MONGODB_URI is not set, so there are no two processes to run" },
    () => {},
  );
}

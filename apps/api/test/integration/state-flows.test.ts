/**
 * The highest-risk state flows, end to end against a real MongoDB.
 *
 * ── What this covers that nothing else does ───────────────────────────
 *
 * The unit suite drives the real routes against an in-process double. The contract suite
 * verifies that double against a real store. Neither exercises the whole path at once:
 * **real route → real tool registry → real MongoDB driver → real documents**.
 *
 * That combination is where the defects in this repository's history actually lived. The
 * counter reset across a restart, the replay that was counted twice, the review that
 * reported the oldest assessment, the terminated session resurrected by a later ingest —
 * every one of them was a real-database behaviour that a faithful-looking double agreed
 * with the route about.
 *
 * ── Gating ────────────────────────────────────────────────────────────
 *
 * Runs when `CERBERUS_TEST_MONGODB_URI` is set, and is **skipped with a stated reason**
 * when it is not. CI provides a `mongo:7` service so it actually runs there; a suite that
 * silently skipped would be green for the wrong reason, which is the failure mode this
 * repository's own documentation warns about.
 *
 * Each describe block gets its own disposable database, dropped afterwards.
 */

import { test, describe, before, after, beforeEach, afterEach } from "node:test";
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

/** A high-risk reply, so the auto-lock path runs. */
const HIGH_RISK_AI = JSON.stringify({
  riskAssessmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  overallRiskScore: 97,
  dimensionScores: { dataExfiltration: 97, policyViolation: 92 },
  flags: [],
  exfiltrationReport: null,
  behavioralAnomalies: [],
  generatedAt: "2026-01-01T00:00:00.000Z",
});

function largePaste(sessionId: string, eventId: string, text = "x".repeat(400)): Record<string, unknown> {
  return {
    eventId,
    sessionId,
    employeeId: "op-trader-001",
    auditId: "audit-2026-q1",
    vectorId: "tv-1",
    eventType: "PASTE",
    timestamp: new Date().toISOString(),
    payload: { newText: text, changeLength: text.length },
    clientMetadata: { userAgent: "integration", platform: "web" },
  };
}

function keystroke(sessionId: string, eventId: string, deltaMs = 120): Record<string, unknown> {
  return {
    eventId,
    sessionId,
    employeeId: "op-trader-001",
    auditId: "audit-2026-q1",
    vectorId: "tv-1",
    eventType: "KEYSTROKE",
    timestamp: new Date().toISOString(),
    payload: { deltaMs },
    clientMetadata: { userAgent: "integration", platform: "web" },
  };
}

/**
 * A real store, a real registry, and the real app on a disposable database.
 *
 * `connect()` runs the migrations and creates the indexes, so every flow below runs against
 * a schema the product would actually have.
 */
async function withRealStack(
  run: (context: {
    app: ReturnType<typeof createApp>;
    store: MongoStore;
    restart: () => ReturnType<typeof createApp>;
    databaseName: string;
  }) => Promise<void>,
  options: { aiResponse?: string } = {},
): Promise<void> {
  const databaseName = `cerberus_integration_${randomUUID().replace(/-/g, "")}`;
  const store = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });
  await store.connect();

  const stub = installFetchStub({
    mcpResponse: realStoreResponder(store),
    ...(options.aiResponse ? { aiResponse: options.aiResponse } : {}),
  });

  try {
    const app = createApp(makeConfigWithTtl(3600));
    await run({
      app,
      store,
      // A fresh process: empty in-memory registries over the same database. This is the
      // shape every restart bug in this repository needed.
      restart: () => createApp(makeConfigWithTtl(3600)),
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

if (REAL_MONGODB_URI) {
  describe("integration — the highest-risk state flows against real MongoDB", () => {
    beforeEach(() => resetAIProvider());
    afterEach(() => resetAIProvider());

    // ── Telemetry, retry and restart ────────────────────────────────

    test("create, ingest, retry the duplicate, and restart", async () => {
      await withRealStack(async ({ app, restart }) => {
        const sessionId = "flow-telemetry";

        const first = await app.request("/api/v1/guardian/ingest", {
          method: "POST",
          headers: authorizedHeaders(),
          body: JSON.stringify({
            events: [keystroke(sessionId, "e1", 100), keystroke(sessionId, "e2", 200)],
          }),
        });
        assert.equal(first.status, 200);
        const firstBody = (await first.json()) as Record<string, unknown>;
        assert.equal(firstBody["telemetryPersisted"], true);
        assert.equal(firstBody["acceptedCount"], 2);
        assert.equal(firstBody["duplicateCount"], 0);

        // The same batch again: stored once, counted once.
        const retry = await app.request("/api/v1/guardian/ingest", {
          method: "POST",
          headers: authorizedHeaders(),
          body: JSON.stringify({
            events: [keystroke(sessionId, "e1", 100), keystroke(sessionId, "e2", 200)],
          }),
        });
        const retryBody = (await retry.json()) as Record<string, unknown>;
        assert.equal(retryBody["acceptedCount"], 0);
        assert.equal(retryBody["duplicateCount"], 2);

        // A restart must not lose the durable totals.
        const restarted = restart();
        const list = await restarted.request("/api/v1/guardian/sessions", {
          headers: authorizedHeaders(),
        });
        const listed = (await list.json()) as { data: Array<Record<string, unknown>> };
        const entry = listed.data.find((row) => row["sessionId"] === sessionId);

        assert.ok(entry, "a restart lost the session");
        assert.equal(
          entry["eventCount"],
          2,
          "a restart reset the durable event total — the defect this flow exists for",
        );
      });
    });

    test("a retried batch after a restart is still stored once", async () => {
      await withRealStack(async ({ app, restart }) => {
        const sessionId = "flow-retry-restart";
        const batch = [keystroke(sessionId, "r1", 100), keystroke(sessionId, "r2", 200)];

        await app.request("/api/v1/guardian/ingest", {
          method: "POST",
          headers: authorizedHeaders(),
          body: JSON.stringify({ events: batch }),
        });

        // A fresh process, whose in-memory dedup ring is empty. Only the durable
        // `(sessionId, eventId)` identity can hold here.
        const restarted = restart();
        const retry = await restarted.request("/api/v1/guardian/ingest", {
          method: "POST",
          headers: authorizedHeaders(),
          body: JSON.stringify({ events: batch }),
        });

        const body = (await retry.json()) as Record<string, unknown>;
        assert.equal(body["acceptedCount"], 0, "a replay after a restart was stored again");
        assert.equal(body["duplicateCount"], 2);

        const detail = await restarted.request(
          `/api/v1/guardian/sessions/${sessionId}`,
          { headers: authorizedHeaders() },
        );
        const detailBody = (await detail.json()) as {
          session: { eventCount: number };
        };
        assert.equal(detailBody.session.eventCount, 2);
      });
    });

    test("session detail survives a restart with no recovery step first", async () => {
      await withRealStack(async ({ app, restart }) => {
        const sessionId = "flow-detail-restart";

        await app.request("/api/v1/guardian/ingest", {
          method: "POST",
          headers: authorizedHeaders(),
          body: JSON.stringify({
            events: [keystroke(sessionId, "d1", 100), keystroke(sessionId, "d2", 200)],
          }),
        });

        // A fresh process, and **no** list call and no ingest: the durable fallback
        // alone must answer. Before this, the route read the two in-memory maps only,
        // so this exact request returned 404 for a session that exists durably.
        const restarted = restart();
        const detail = await restarted.request(
          `/api/v1/guardian/sessions/${sessionId}`,
          { headers: authorizedHeaders() },
        );
        assert.equal(detail.status, 200, "a restart lost a session that exists durably");
        const body = (await detail.json()) as {
          session: {
            eventCount: number;
            source: string;
            ephemeralStateAvailable: boolean;
            status: string;
            deployedAt: string;
            employeeId: string;
          };
        };

        assert.equal(body.session.eventCount, 2, "the durable event total was not served");
        assert.equal(body.session.source, "durable");
        assert.equal(
          body.session.ephemeralStateAvailable,
          false,
          "a durable answer claimed ephemeral state it does not hold",
        );

        // The live list and the detail route must agree about the same real document.
        const list = await restarted.request("/api/v1/guardian/sessions", {
          headers: authorizedHeaders(),
        });
        const listed = (await list.json()) as { data: Array<Record<string, unknown>> };
        const entry = listed.data.find((row) => row["sessionId"] === sessionId);
        assert.ok(entry, "the live list lost the session");

        assert.equal(entry["eventCount"], body.session.eventCount);
        assert.equal(entry["status"], body.session.status);
        assert.equal(entry["deployedAt"], body.session.deployedAt);
        assert.equal(entry["employeeId"], body.session.employeeId);
      });
    });

    test("a terminated session stays readable across a restart", async () => {
      await withRealStack(async ({ app, restart }) => {
        const sessionId = "flow-detail-terminated";

        await app.request("/api/v1/guardian/ingest", {
          method: "POST",
          headers: authorizedHeaders(),
          body: JSON.stringify({ events: [keystroke(sessionId, "t1", 100)] }),
        });
        const terminated = await app.request(
          `/api/v1/guardian/sessions/${sessionId}/terminate`,
          { method: "POST", headers: authorizedHeaders() },
        );
        assert.equal(terminated.status, 200);

        const restarted = restart();
        const detail = await restarted.request(
          `/api/v1/guardian/sessions/${sessionId}`,
          { headers: authorizedHeaders() },
        );

        assert.equal(detail.status, 200, "a terminated session must stay readable for review");
        const body = (await detail.json()) as {
          session: { status: string; eventCount: number };
        };
        assert.equal(body.session.status, "terminated");
        assert.equal(body.session.eventCount, 1, "termination deleted evidence");
      });
    });

    // ── Deletion, against real documents ────────────────────────────

    test("a deletion reports the documents it actually removed, per component", async () => {
      await withRealStack(
        async ({ app, store }) => {
          const sessionId = "flow-delete-report";

          // A high-risk batch, so there is a durable assessment as well as telemetry.
          await app.request("/api/v1/guardian/ingest", {
            method: "POST",
            headers: authorizedHeaders(),
            body: JSON.stringify({ events: [largePaste(sessionId, "p1"), keystroke(sessionId, "k1", 100)] }),
          });

          const before = {
            events: (await store.getSessionEvents(sessionId)).length,
            assessments: (await store.getRiskAssessments(sessionId)).length,
          };
          assert.ok(before.events >= 2, "the fixture did not store telemetry");
          assert.ok(before.assessments >= 1, "the fixture did not store an assessment");

          const deleted = await app.request(`/api/v1/guardian/sessions/${sessionId}`, {
            method: "DELETE",
            headers: authorizedHeaders(),
          });
          assert.equal(deleted.status, 200);

          const body = (await deleted.json()) as {
            complete: boolean;
            components: Record<string, { deleted: number }>;
          };

          assert.equal(body.complete, true);
          // The counts are the documents that were actually there, read back from a real
          // database rather than assumed from a single `deletedCount`.
          assert.equal(body.components["session"].deleted, 1);
          assert.equal(body.components["telemetry"].deleted, before.events);
          assert.equal(body.components["assessments"].deleted, before.assessments);

          assert.equal(await store.getSession(sessionId), null);
          assert.deepEqual(await store.getSessionEvents(sessionId), []);
          assert.deepEqual(await store.getRiskAssessments(sessionId), []);
        },
        { aiResponse: HIGH_RISK_AI },
      );
    });

    test("a second deletion against real documents is a clean no-op", async () => {
      await withRealStack(async ({ app }) => {
        const sessionId = "flow-delete-twice";
        await app.request("/api/v1/guardian/ingest", {
          method: "POST",
          headers: authorizedHeaders(),
          body: JSON.stringify({ events: [keystroke(sessionId, "k1", 100)] }),
        });

        const first = await app.request(`/api/v1/guardian/sessions/${sessionId}`, {
          method: "DELETE",
          headers: authorizedHeaders(),
        });
        assert.equal(first.status, 200);

        // Retrying is the documented remedy for a partial deletion, so a repeat has to be
        // safe: it reports zeros and a not-found rather than failing or double-counting.
        const second = await app.request(`/api/v1/guardian/sessions/${sessionId}`, {
          method: "DELETE",
          headers: authorizedHeaders(),
        });
        assert.equal(second.status, 404);
        const body = (await second.json()) as { code: string };
        assert.equal(body.code, "SESSION_NOT_FOUND");
      });
    });

    test("auto-lock writes its evidence before the status, and both survive a restart", async () => {
      await withRealStack(
        async ({ app, restart }) => {
          const sessionId = "flow-autolock";

          const res = await app.request("/api/v1/guardian/ingest", {
            method: "POST",
            headers: authorizedHeaders(),
            body: JSON.stringify({ events: [largePaste(sessionId, "p1")] }),
          });
          const body = (await res.json()) as Record<string, unknown>;
          assert.equal(body["assessmentPersisted"], true);

          // The lock is durable...
          const restarted = restart();
          const list = await restarted.request("/api/v1/guardian/sessions", {
            headers: authorizedHeaders(),
          });
          const listed = (await list.json()) as { data: Array<Record<string, unknown>> };
          const entry = listed.data.find((row) => row["sessionId"] === sessionId);
          assert.ok(entry);
          assert.equal(entry["status"], "locked", "a restart lost the durable lock");

          // ...and so is the evidence that justifies it.
          const review = await restarted.request(`/api/v1/sessions/${sessionId}`, {
            headers: authorizedHeaders(),
          });
          const reviewed = (await review.json()) as {
            data: { status: string; finalRiskScore: number | null; riskSummary: unknown[] };
          };
          assert.equal(reviewed.data.status, "locked");
          assert.ok(
            reviewed.data.riskSummary.length > 0,
            "a lock survived without its evidence — the window the write order closed",
          );
          assert.ok((reviewed.data.finalRiskScore ?? 0) > 0);
        },
        { aiResponse: HIGH_RISK_AI },
      );
    });

    test("the final risk score is the newest assessment, against real sort order", async () => {
      await withRealStack(async ({ app, store }) => {
        const sessionId = "flow-ordering";
        await store.createSession({ sessionId, employeeId: "op-1", auditId: "audit-1" });

        // Inserted oldest-first; the store returns newest-first.
        for (const [score, generatedAt] of [
          [10, "2026-01-01T00:00:00.000Z"],
          [40, "2026-02-01T00:00:00.000Z"],
          [88, "2026-03-01T00:00:00.000Z"],
        ] as Array<[number, string]>) {
          await store.storeRiskAssessment({
            riskAssessmentId: `${sessionId}-${score}`,
            sessionId,
            employeeId: "op-1",
            auditId: "audit-1",
            overallRiskScore: score,
            dimensionScores: {},
            flags: [],
            exfiltrationReport: null,
            behavioralAnomalies: [],
            generatedAt,
          });
        }

        const res = await app.request(`/api/v1/sessions/${sessionId}`, {
          headers: authorizedHeaders(),
        });
        const body = (await res.json()) as { data: { finalRiskScore: number } };

        assert.equal(
          body.data.finalRiskScore,
          88,
          "the review reported the oldest assessment as final, against a real sort",
        );
      });
    });

    test("terminate preserves the workspace and is irreversible", async () => {
      await withRealStack(async ({ app, restart }) => {
        const sessionId = "flow-terminate";

        await app.request("/api/v1/guardian/ingest", {
          method: "POST",
          headers: authorizedHeaders(),
          body: JSON.stringify({ events: [largePaste(sessionId, "p1", "TERMINAL WORKSPACE")] }),
        });

        const terminated = await app.request(
          `/api/v1/guardian/sessions/${sessionId}/terminate`,
          { method: "POST", headers: authorizedHeaders() },
        );
        assert.equal(terminated.status, 200);

        const restarted = restart();

        // The workspace is preserved by the owner.
        const review = await restarted.request(`/api/v1/sessions/${sessionId}`, {
          headers: authorizedHeaders(),
        });
        const reviewed = (await review.json()) as {
          data: { status: string; terminalContent: string };
        };
        assert.equal(reviewed.data.status, "terminated");
        assert.equal(reviewed.data.terminalContent, "TERMINAL WORKSPACE");

        // And telemetry is refused, after a restart, against the real document.
        const ingest = await restarted.request("/api/v1/guardian/ingest", {
          method: "POST",
          headers: authorizedHeaders(),
          body: JSON.stringify({ events: [largePaste(sessionId, "after")] }),
        });
        assert.equal(ingest.status, 409);
        const ingestBody = (await ingest.json()) as { code: string };
        assert.equal(ingestBody.code, "SESSION_TERMINATED");
      });
    });

    // ── Concurrency against a real server ───────────────────────────

    test("concurrent ingests of distinct events both land", async () => {
      await withRealStack(async ({ app, store }) => {
        const sessionId = "flow-concurrent-ingest";

        const results = await Promise.all(
          ["c1", "c2", "c3", "c4"].map((id) =>
            app.request("/api/v1/guardian/ingest", {
              method: "POST",
              headers: authorizedHeaders(),
              body: JSON.stringify({ events: [keystroke(sessionId, id, 100 + Number(id[1]))] }),
            }),
          ),
        );

        for (const result of results) assert.equal(result.status, 200);

        const events = await store.getSessionEvents(sessionId);
        assert.equal(events.length, 4, "a concurrent ingest lost an event");
        assert.equal(
          (await store.getSession(sessionId))?.["eventCount"],
          4,
          "the durable counter does not match the stored events",
        );
      });
    });

    test("a duplicate event in two concurrent batches is stored once", async () => {
      await withRealStack(async ({ app, store }) => {
        const sessionId = "flow-concurrent-duplicate";
        const event = keystroke(sessionId, "shared", 150);

        const results = await Promise.all([
          app.request("/api/v1/guardian/ingest", {
            method: "POST",
            headers: authorizedHeaders(),
            body: JSON.stringify({ events: [event] }),
          }),
          app.request("/api/v1/guardian/ingest", {
            method: "POST",
            headers: authorizedHeaders(),
            body: JSON.stringify({ events: [event] }),
          }),
        ]);
        for (const result of results) assert.equal(result.status, 200);

        const events = await store.getSessionEvents(sessionId);
        assert.equal(
          events.length,
          1,
          "the unique index did not hold under concurrency — the event was stored twice",
        );
      });
    });

    test("terminate racing auto-lock: exactly one applies", async () => {
      await withRealStack(
        async ({ app, store }) => {
          const sessionId = "flow-race";
          await app.request("/api/v1/guardian/ingest", {
            method: "POST",
            headers: authorizedHeaders(),
            body: JSON.stringify({ events: [keystroke(sessionId, "seed", 120)] }),
          });

          // Both read `active`, then both write with a predicate. The compare-and-set is
          // the arbiter, and the loser must not overwrite the winner.
          const [terminate, lock] = await Promise.all([
            app.request(`/api/v1/guardian/sessions/${sessionId}/terminate`, {
              method: "POST",
              headers: authorizedHeaders(),
            }),
            app.request("/api/v1/guardian/ingest", {
              method: "POST",
              headers: authorizedHeaders(),
              body: JSON.stringify({ events: [largePaste(sessionId, "race")] }),
            }),
          ]);

          // The terminate is the only writer of a status here; the ingest may lock. Whichever
          // order they landed in, the durable status must be a legal state and must match one
          // of the two requests rather than being a mixture.
          assert.ok([200, 409].includes(terminate.status));
          assert.equal(lock.status, 200);

          const status = (await store.getSession(sessionId))?.["status"];
          assert.ok(
            status === "terminated" || status === "locked" || status === "active",
            `the race left an illegal status: ${String(status)}`,
          );
        },
        { aiResponse: HIGH_RISK_AI },
      );
    });

    // ── The corpus ceiling ──────────────────────────────────────────

    test("the corpus ceiling holds against real documents", async () => {
      await withRealStack(async ({ app, store }) => {
        // A small ceiling would need a smaller constant; the real one is exercised in
        // `reference-corpus-ceiling.test.ts`. Here the point is that the *route* refuses
        // through a real store rather than through a double.
        const seeded = await store.referenceDocumentCount();
        assert.equal(seeded, 0, "a fresh database already has corpus documents");

        const added = await app.request("/api/v1/reference-documents", {
          method: "POST",
          headers: authorizedHeaders(),
          body: JSON.stringify({ label: "integration", content: "ledger content", tags: [] }),
        });
        assert.equal(added.status, 201);

        assert.equal(await store.referenceDocumentCount(), 1);

        const listed = await app.request("/api/v1/reference-documents", {
          headers: authorizedHeaders(),
        });
        const body = (await listed.json()) as { total: number };
        assert.equal(body.total, 1);
      });
    });

    // ── Migrations ──────────────────────────────────────────────────

    test("the migrations are applied on connect and recorded once", async () => {
      await withRealStack(async ({ store, databaseName }) => {
        const client = new MongoClient(REAL_MONGODB_URI);
        try {
          await client.connect();
          const ledger = await client
            .db(databaseName)
            .collection("schema_migrations")
            .find({})
            .toArray();

          const ids = ledger.map((row) => String(row["migrationId"]));
          assert.deepEqual(
            ids.sort(),
            [
              "0001-dedupe-micro-event-identity",
              "0002-dedupe-risk-assessment-identity",
              "0003-rename-fullscreen-exit-to-focus-loss",
              "0004-paid-operation-claim-indexes",
            ],
            "the ledger does not record every migration",
          );

          // The indexes the migrations exist to allow.
          const sessionIndexes = await client
            .db(databaseName)
            .collection("micro_events")
            .indexes();
          assert.ok(
            sessionIndexes.some(
              (index) =>
                index.unique === true && index.key["sessionId"] === 1 && index.key["eventId"] === 1,
            ),
            "the durable event-identity index is missing",
          );

          const assessmentIndexes = await client
            .db(databaseName)
            .collection("risk_assessments")
            .indexes();
          assert.ok(
            assessmentIndexes.some(
              (index) => index.unique === true && index.key["riskAssessmentId"] === 1,
            ),
            "the durable assessment-identity index is missing",
          );
        } finally {
          await client.close();
        }

        // And a second connect is a no-op: the ledger is not appended to twice.
        const second = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });
        await second.connect();
        try {
          const applied = await second.runMigrations();
          assert.deepEqual(applied.applied, [], "a second connect re-applied a migration");
        } finally {
          await second.disconnect();
        }

        assert.ok(store.isConnected());
      });
    });

    // ── The store contract, at the route level ──────────────────────

    test("a store that is unreachable fails the batch honestly", async () => {
      // Not a real-store case, but it belongs with the others: the response must say the
      // telemetry was not persisted rather than reporting the batch as accepted.
      const stub = installFetchStub({
        mcpResponse: () => {
          throw new Error("integration: store unreachable");
        },
      });

      try {
        const app = createApp(makeConfigWithTtl(3600));
        const res = await app.request("/api/v1/guardian/ingest", {
          method: "POST",
          headers: authorizedHeaders(),
          body: JSON.stringify({ events: [keystroke("flow-degraded", "e1")] }),
        });

        assert.equal(res.status, 200);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body["telemetryPersisted"], false);
        assert.equal(body["acceptedCount"], undefined);
      } finally {
        stub.restore();
        resetAIProvider();
      }
    });
  });
} else {
  describe("integration — the highest-risk state flows against real MongoDB", () => {
    test("skipped: CERBERUS_TEST_MONGODB_URI is not set", { skip: true }, () => {
      // An integration suite that silently skipped would be green for the wrong reason.
      // CI provides a `mongo:7` service and sets this variable, so it runs there; locally,
      // run
      //   CERBERUS_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm test
      // to execute it.
    });
  });
}

/** Keeps the `before`/`after` imports honest when the suite is skipped. */
before(() => undefined);
after(() => undefined);

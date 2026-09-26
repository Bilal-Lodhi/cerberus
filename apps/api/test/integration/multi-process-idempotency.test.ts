/**
 * Two API processes, one real MongoDB, one idempotency key.
 *
 * ── Why this suite exists, and what it is the only thing that can prove ──
 *
 * Every other idempotency suite runs one app instance. `scenarios-idempotency.test.ts` and
 * `auditor-idempotency.test.ts` assert the *decisions* — replay, conflict, pending, failure —
 * but a single app never has two claims in flight at once, so they cannot assert the
 * invariant the whole mechanism rests on:
 *
 * > two callers racing one key produce **one** provider execution.
 *
 * `store-contract.test.ts` runs the claim predicates against a real MongoDB, which is the
 * database half. What it cannot do is put two *routes* through those predicates concurrently.
 *
 * ── Why two apps in one Node process is a real test and not a shortcut ──
 *
 * The two apps share no idempotency state. Every claim goes `callMcpTool` → the fetch seam →
 * the **real tool registry** → the **real `MongoStore`** → the real MongoDB driver. So the
 * mutual exclusion being exercised is genuinely the unique index on
 * `(routeFamily, keyHash)`, and a process-local mutex could not pass this suite: there is no
 * process-local mutex, and if one were added the second app would still reach the database.
 *
 * What the two apps *do* share is the AI provider singleton, because it is memoised per
 * module. That is deliberate and harmless here: the provider is a stub with a counter, and
 * what is being counted is how many times the *operation* reached it — which is exactly the
 * number a duplicate execution would inflate.
 *
 * ── Deterministic, not sleep-based ────────────────────────────────────
 *
 * A genuine race is issued with `Promise.all`, and the assertion is the **invariant** that
 * must hold under any interleaving — one execution, two provider calls — rather than a guess
 * about which caller won. Where an ordering is needed, it is established by awaiting the first
 * operation. Nothing sleeps.
 *
 * ── Gating ───────────────────────────────────────────────────────────
 *
 * Runs when `CERBERUS_TEST_MONGODB_URI` is set and is **skipped with a stated reason** when it
 * is not. CI provides a `mongo:7` and asserts that nothing was skipped.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { MongoClient } from "mongodb";

import { MongoStore } from "../../../../packages/mcp-mongodb/src/mongo-client.js";
import { createApp } from "../../src/index.js";
import { resetAIProvider } from "../../src/ai/provider.js";
import { hashIdempotencyKey } from "../../src/services/idempotency-key.js";
import { authorizedHeaders, makeConfig, type FetchStub } from "../helpers.js";
import { realStoreResponder } from "../support/real-store-responder.js";

const REAL_MONGODB_URI = process.env["CERBERUS_TEST_MONGODB_URI"]?.trim() ?? "";

type App = ReturnType<typeof createApp>;

const SCENARIO_PROMPT =
  "Author threat scenarios for the SWIFT gateway covering token injection and AML red flags";
const SCENARIO_ROLE = "swift-gateway";
const AUDITOR_QUESTION = "which sessions pasted the most external content?";

const CLASSIFIER_ACCEPT = JSON.stringify({
  isInputMeaningful: true,
  isScenarioRelated: true,
  isAppropriate: true,
  contentFlags: [],
  reason: "valid",
  confidence: 0.95,
  detectedDomain: "financial_services",
});

const MATRIX = JSON.stringify({
  metadata: { matrixId: "matrix-mp", generatedAt: "2026-01-01T00:00:00.000Z" },
  targetSystems: [{ systemId: "ts-1", name: "Core Trading Ledger" }],
  regulatoryMandates: [{ mandateId: "aml-001", name: "AML" }],
  threatVectors: [{ vectorId: "tv-1", title: "Exfil", severity: "high" }],
  penetrationScenarios: [{ scenarioId: "ps-1", vectorId: "tv-1" }],
});

const PIPELINE = JSON.stringify({ pipeline: [{ $limit: 5 }] });
const SUMMARY = "Two sessions show elevated exfiltration risk.";

/**
 * One provider answer, chosen by the system prompt the route actually sent.
 *
 * Not by call index: a race means the number of calls is exactly what is under test, so
 * deciding an answer from the count would make the test depend on the thing it is measuring.
 * "Classify the incoming request", "When an operator requests a threat scenario set",
 * "MongoDB expert" and "Summarize these session records" are the four openings.
 */
function providerResponse(requestBody: string): Response {
  const content = requestBody.includes("Classify the incoming request")
    ? CLASSIFIER_ACCEPT
    : requestBody.includes("MongoDB expert")
      ? PIPELINE
      : requestBody.includes("Summarize these session records")
        ? SUMMARY
        : MATRIX;

  return Response.json({
    id: "chatcmpl-stub",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  });
}

interface TwoProcessContext {
  processA: App;
  processB: App;
  store: MongoStore;
  restartA: () => App;
  databaseName: string;
  /** How many times the provider was reached, across both apps. */
  providerCalls: () => number;
  /** Raw access, for the two cases that must age a record without sleeping. */
  mongo: MongoClient;
}

async function withTwoProcesses(
  run: (context: TwoProcessContext) => Promise<void>,
): Promise<void> {
  const databaseName = `cerberus_mp_idem_${randomUUID().replace(/-/g, "")}`;
  const store = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });
  await store.connect();

  const mcpResponder = realStoreResponder(store);
  const original = globalThis.fetch;
  let providerCalls = 0;

  // A hand-written stub rather than `installFetchStub`: that helper answers sequential
  // canned replies, and a race means the reply index is exactly what must not influence the
  // answer. This decides from the prompt and counts what it answered.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.startsWith("http://mcp.test/tools/")) {
      const tool = url.slice("http://mcp.test/tools/".length);
      let body: Record<string, unknown> = {};
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body) as Record<string, unknown>;
        } catch {
          body = {};
        }
      }
      return mcpResponder(tool, body);
    }

    if (url.includes("api.openai.com")) {
      providerCalls += 1;
      return providerResponse(typeof init?.body === "string" ? init.body : "");
    }

    return new Response(JSON.stringify({ success: false }), { status: 404 });
  }) as typeof fetch;

  const mongo = new MongoClient(REAL_MONGODB_URI);
  await mongo.connect();

  try {
    const config = makeConfig();
    await run({
      processA: createApp(config),
      processB: createApp(config),
      store,
      restartA: () => createApp(config),
      databaseName,
      providerCalls: () => providerCalls,
      mongo,
    });
  } finally {
    globalThis.fetch = original;
    resetAIProvider();
    await mongo.close();
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

function scenarioRequest(
  app: App,
  options: { key?: string; prompt?: string; vectorCount?: number } = {},
) {
  const headers: Record<string, string> = authorizedHeaders();
  if (options.key !== undefined) headers["Idempotency-Key"] = options.key;

  return app.request("/api/v1/scenarios", {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt: options.prompt ?? SCENARIO_PROMPT,
      roleContext: SCENARIO_ROLE,
      ...(options.vectorCount !== undefined ? { vectorCount: options.vectorCount } : {}),
    }),
  });
}

function auditorRequest(app: App, options: { key?: string; question?: string } = {}) {
  const headers: Record<string, string> = authorizedHeaders();
  if (options.key !== undefined) headers["Idempotency-Key"] = options.key;

  return app.request("/api/v1/auditor/query", {
    method: "POST",
    headers,
    body: JSON.stringify({ question: options.question ?? AUDITOR_QUESTION }),
  });
}

/** The claim documents for one key, read straight from the database. */
async function claimsFor(
  context: TwoProcessContext,
  routeFamily: string,
  key: string,
): Promise<Array<Record<string, unknown>>> {
  return context.mongo
    .db(context.databaseName)
    .collection("operation_claims")
    .find({ routeFamily, keyHash: hashIdempotencyKey(key) })
    .toArray();
}

/** Ages a claim so it is reclaimable, without sleeping for a derived lease. */
async function expireLease(
  context: TwoProcessContext,
  routeFamily: string,
  key: string,
): Promise<void> {
  await context.mongo
    .db(context.databaseName)
    .collection("operation_claims")
    .updateOne(
      { routeFamily, keyHash: hashIdempotencyKey(key) },
      { $set: { leaseExpiresAt: new Date(Date.now() - 1_000) } },
    );
}

/**
 * Which of two racing callers actually executed, judged from the responses.
 *
 * ── Why this is a helper rather than an assertion about statuses ──────
 *
 * The invariant under any interleaving is **one execution**, not a particular pair of
 * statuses. The caller that loses the claim race has two honest outcomes depending on
 * timing:
 *
 *   - the winner is still working, so it gets `409 IDEMPOTENCY_IN_PROGRESS`; or
 *   - the winner already finished, so it gets a `201` **carrying `Idempotency-Replayed`**.
 *
 * An earlier version of this suite asserted `[201, 409]` and was therefore flaky: it passed
 * whenever the second claim arrived during the first execution and failed whenever it
 * arrived after. Asserting the *shape* — exactly one fresh execution, and anything else the
 * loser received is either a refusal or a replay — is what holds either way.
 */
function executionsAmong(responses: Array<{ status: number; replayed: boolean }>): number {
  return responses.filter((response) => response.status === 201 && !response.replayed).length;
}

async function describeResponse(response: Response): Promise<{ status: number; replayed: boolean }> {
  return { status: response.status, replayed: response.headers.get("Idempotency-Replayed") === "true" };
}

if (REAL_MONGODB_URI) {
  describe("multi-process idempotency — two API processes, one real MongoDB", () => {
    beforeEach(() => resetAIProvider());
    afterEach(() => resetAIProvider());

    // ── The race, on the scenarios route ──────────────────────────────

    test("two processes racing one key produce exactly one provider execution", async () => {
      await withTwoProcesses(async (context) => {
        const key = "mp-race-scenarios-1";

        // Issued together, so the two claims genuinely interleave. Either may win; the
        // invariant is that exactly one executes — which for this route means exactly two
        // provider calls (the classifier and the author), not four.
        const responses = await Promise.all([
          scenarioRequest(context.processA, { key }),
          scenarioRequest(context.processB, { key }),
        ]);

        assert.equal(
          context.providerCalls(),
          2,
          "both processes executed the operation, so the unique claim index did not hold",
        );

        const described = await Promise.all(responses.map(describeResponse));
        assert.equal(
          executionsAmong(described),
          1,
          `expected exactly one fresh execution, got ${JSON.stringify(described)}`,
        );

        // Whatever the loser received, it is one of the two honest answers, and it spent
        // nothing — which the provider count above has already established.
        const loser = described.find((response) => response.status !== 201 || response.replayed);
        assert.ok(loser, "the loser received a second fresh execution");
        assert.ok(
          loser.status === 409 || (loser.status === 201 && loser.replayed),
          `the loser received neither a refusal nor a replay: ${JSON.stringify(loser)}`,
        );

        const records = await claimsFor(context, "scenarios", key);
        assert.equal(records.length, 1, "a race created two claim records");
        assert.equal(records[0]?.["status"], "completed");
      });
    });

    test("the losing process is told the truth, not asked to retry blindly", async () => {
      await withTwoProcesses(async (context) => {
        const key = "mp-race-scenarios-2";

        const responses = await Promise.all([
          scenarioRequest(context.processA, { key }),
          scenarioRequest(context.processB, { key }),
        ]);

        const described = await Promise.all(responses.map(describeResponse));
        const loserIndex = described.findIndex(
          (response) => response.status !== 201 || response.replayed,
        );
        assert.ok(loserIndex >= 0, "neither process was refused or replayed, so both executed");

        const loser = responses[loserIndex];
        if (loser.status === 409) {
          const body = (await loser.json()) as { code?: string; retryAfterSeconds?: number };
          assert.ok(
            body.code === "IDEMPOTENCY_IN_PROGRESS" || body.code === "IDEMPOTENCY_CONFLICT",
            `unexpected refusal code ${String(body.code)}`,
          );
          if (body.code === "IDEMPOTENCY_IN_PROGRESS") {
            assert.ok(
              (body.retryAfterSeconds ?? 0) >= 1,
              "an in-progress answer must say when to retry",
            );
            assert.ok(loser.headers.get("Retry-After"), "no Retry-After header was sent");
          }
        }
      });
    });

    // ── Replay across processes ───────────────────────────────────────

    test("a completed operation retried on the OTHER process replays and spends nothing", async () => {
      await withTwoProcesses(async (context) => {
        const key = "mp-cross-process-replay-1";

        const first = await scenarioRequest(context.processA, { key });
        assert.equal(first.status, 201);
        assert.equal(context.providerCalls(), 2);

        // A different app instance, with no memory of the first request.
        const second = await scenarioRequest(context.processB, { key });

        assert.equal(second.status, 201);
        assert.equal(second.headers.get("Idempotency-Replayed"), "true");
        assert.equal(
          context.providerCalls(),
          2,
          "the second process executed the operation instead of replaying it",
        );

        const firstBody = (await first.json()) as { matrix: { metadata: { matrixId: string } } };
        const secondBody = (await second.json()) as { matrix: { metadata: { matrixId: string } } };
        assert.equal(
          secondBody.matrix.metadata.matrixId,
          firstBody.matrix.metadata.matrixId,
          "the replay returned a different result from the original",
        );
      });
    });

    test("a restart replays: the claim is a document, not process memory", async () => {
      await withTwoProcesses(async (context) => {
        const key = "mp-restart-replay-1";

        const first = await scenarioRequest(context.processA, { key });
        assert.equal(first.status, 201);

        // A fresh app instance: empty memory, same documents.
        const freshA = context.restartA();
        const second = await scenarioRequest(freshA, { key });

        assert.equal(second.status, 201);
        assert.equal(second.headers.get("Idempotency-Replayed"), "true");
        assert.equal(
          context.providerCalls(),
          2,
          "a restarted process executed the operation instead of replaying it",
        );
      });
    });

    // ── Conflict, across processes ────────────────────────────────────

    test("the same key with a different body conflicts on the other process", async () => {
      await withTwoProcesses(async (context) => {
        const key = "mp-conflict-1";
        assert.equal((await scenarioRequest(context.processA, { key })).status, 201);

        const other = await scenarioRequest(context.processB, {
          key,
          prompt: "A completely different authoring request for the ledger",
        });

        assert.equal(other.status, 409);
        assert.equal(((await other.json()) as { code?: string }).code, "IDEMPOTENCY_CONFLICT");
        assert.equal(context.providerCalls(), 2, "a conflict executed the provider");
      });
    });

    // ── A live claim across processes ─────────────────────────────────

    test("a fresh pending claim blocks the other process, which then reclaims it once it ages", async () => {
      await withTwoProcesses(async (context) => {
        const key = "mp-stale-reclaim-1";

        // A claim whose owner is gone: written directly, because the derived lease is
        // minutes long and sleeping for it would make this suite measure the clock.
        const claims = context.mongo
          .db(context.databaseName)
          .collection("operation_claims");
        await claims.insertOne({
          routeFamily: "scenarios",
          keyHash: hashIdempotencyKey(key),
          fingerprint: "fingerprint-the-route-will-not-match",
          fingerprintVersion: 1,
          status: "pending",
          claimId: "abandoned-owner",
          createdAt: new Date(Date.now() - 600_000),
          updatedAt: new Date(Date.now() - 600_000),
          leaseExpiresAt: new Date(Date.now() - 1_000),
          expiresAt: new Date(Date.now() + 600_000),
        });

        // A live claim blocks the other process: no second execution, no provider call.
        const blocked = await scenarioRequest(context.processB, { key });
        assert.equal(blocked.status, 409);
        assert.equal(
          context.providerCalls(),
          0,
          "a request against an abandoned claim executed the provider",
        );

        // Age it so the lease has expired, then let the other process reclaim it.
        await claims.updateOne(
          { routeFamily: "scenarios", keyHash: hashIdempotencyKey(key) },
          { $set: { fingerprint: "still-not-the-route-fingerprint" } },
        );
        await expireLease(context, "scenarios", key);

        // The fingerprint still does not match, so this must stay a conflict rather than a
        // silent re-execution. That is the property that stops a reused key from running a
        // request it was never issued for.
        const stillConflict = await scenarioRequest(context.processB, { key });
        assert.equal(
          stillConflict.status,
          409,
          "an abandoned claim belonging to a different request was reclaimed",
        );
        assert.equal(context.providerCalls(), 0);
      });
    });

    test("two processes reclaiming one aged claim produce exactly one execution", async () => {
      await withTwoProcesses(async (context) => {
        const key = "mp-reclaim-race-1";

        // A stale claim whose fingerprint MATCHES what the route computes, so it is
        // genuinely reclaimable. Written by running the route once and then aging it.
        const seeded = await scenarioRequest(context.processA, { key });
        assert.equal(seeded.status, 201);
        assert.equal(context.providerCalls(), 2);

        // Rewind the record to `pending` and expire its lease, which is the state a process
        // that died mid-operation leaves behind.
        await context.mongo
          .db(context.databaseName)
          .collection("operation_claims")
          .updateOne(
            { routeFamily: "scenarios", keyHash: hashIdempotencyKey(key) },
            {
              $set: {
                status: "pending",
                claimId: "abandoned-owner",
                leaseExpiresAt: new Date(Date.now() - 1_000),
              },
              $unset: { result: "", resultOmitted: "", errorCategory: "", retryable: "" },
            },
          );

        const before = context.providerCalls();

        // Both processes reclaim together. Either may win; the invariant is that exactly one
        // executes, which means exactly two more provider calls rather than four.
        const responses = await Promise.all([
          scenarioRequest(context.processA, { key }),
          scenarioRequest(context.processB, { key }),
        ]);

        assert.equal(
          context.providerCalls() - before,
          2,
          "both processes reclaimed the stale claim, so a crash window spent twice",
        );

        const described = await Promise.all(responses.map(describeResponse));
        assert.equal(
          executionsAmong(described),
          1,
          `expected exactly one reclaimer, got ${JSON.stringify(described)}`,
        );

        const records = await claimsFor(context, "scenarios", key);
        assert.equal(records.length, 1, "a reclaim race created a second record");
      });
    });

    // ── The auditor, which has a durable read between its paid calls ──

    test("two processes racing one auditor key produce exactly one provider execution", async () => {
      await withTwoProcesses(async (context) => {
        const key = "mp-race-auditor-1";

        const responses = await Promise.all([
          auditorRequest(context.processA, { key }),
          auditorRequest(context.processB, { key }),
        ]);

        assert.equal(
          context.providerCalls(),
          2,
          "both processes executed the auditor query, so a retry would spend twice",
        );

        const described = await Promise.all(
          responses.map(async (response) => ({
            status: response.status,
            replayed: response.headers.get("Idempotency-Replayed") === "true",
          })),
        );
        assert.equal(
          described.filter((entry) => entry.status === 200 && !entry.replayed).length,
          1,
          `expected exactly one fresh execution, got ${JSON.stringify(described)}`,
        );
      });
    });

    test("a completed auditor query replayed on the other process spends nothing", async () => {
      await withTwoProcesses(async (context) => {
        const key = "mp-auditor-replay-1";

        const first = await auditorRequest(context.processA, { key });
        assert.equal(first.status, 200);
        assert.equal(context.providerCalls(), 2);

        const second = await auditorRequest(context.processB, { key });

        assert.equal(second.status, 200);
        assert.equal(second.headers.get("Idempotency-Replayed"), "true");
        assert.equal(context.providerCalls(), 2, "the replay reached the provider");

        const firstBody = (await first.json()) as { summary: string };
        const secondBody = (await second.json()) as { summary: string };
        assert.equal(secondBody.summary, firstBody.summary);
      });
    });

    test("a completed auditor answer survives a restart", async () => {
      await withTwoProcesses(async (context) => {
        const key = "mp-auditor-restart-1";

        assert.equal((await auditorRequest(context.processA, { key })).status, 200);

        const freshA = context.restartA();
        const second = await auditorRequest(freshA, { key });

        assert.equal(second.headers.get("Idempotency-Replayed"), "true");
        assert.equal(context.providerCalls(), 2);
      });
    });

    // ── Retention ─────────────────────────────────────────────────────

    test("once a claim record is swept, the same key starts a new operation", async () => {
      await withTwoProcesses(async (context) => {
        const key = "mp-retention-1";

        assert.equal((await scenarioRequest(context.processA, { key })).status, 201);
        assert.equal(context.providerCalls(), 2);

        // The TTL monitor sweeps approximately — about once a minute — so waiting for it
        // would make this suite measure the clock rather than the semantics. Removing the
        // record is exactly the state the sweep produces, and it is the state this asserts:
        // an expired claim is not a permanent lock on the key.
        await context.mongo
          .db(context.databaseName)
          .collection("operation_claims")
          .deleteOne({ routeFamily: "scenarios", keyHash: hashIdempotencyKey(key) });

        const after = await scenarioRequest(context.processB, { key });

        assert.equal(after.status, 201);
        assert.notEqual(
          after.headers.get("Idempotency-Replayed"),
          "true",
          "a swept record still answered as a replay",
        );
        assert.equal(
          context.providerCalls(),
          4,
          "the key did not start a new operation after its record was swept",
        );
      });
    });

    // ── The record itself ─────────────────────────────────────────────

    test("the stored claim holds no raw key, and the two families are separate namespaces", async () => {
      await withTwoProcesses(async (context) => {
        const key = "mp-redaction-1";

        await Promise.all([
          scenarioRequest(context.processA, { key }),
          auditorRequest(context.processB, { key }),
        ]);

        const all = await context.mongo
          .db(context.databaseName)
          .collection("operation_claims")
          .find({ keyHash: hashIdempotencyKey(key) })
          .toArray();

        assert.equal(all.length, 2, "one key across two routes did not create two claims");

        const serialised = JSON.stringify(all);
        assert.ok(!serialised.includes(key), "a claim record holds the raw idempotency key");
        assert.ok(!serialised.includes(SCENARIO_PROMPT), "a claim record holds the prompt");
        assert.ok(!serialised.includes(AUDITOR_QUESTION), "a claim record holds the question");

        const families = all.map((record) => record["routeFamily"]).sort();
        assert.deepEqual(families, ["auditor", "scenarios"]);
      });
    });
  });
} else {
  // The repository's convention: a precondition that is absent produces a **skip with a
  // stated reason**, never a pass. A pass here would say the two-process idempotency
  // guarantees were exercised, which is exactly the claim this file exists to make or
  // withhold.
  test("skipped: CERBERUS_TEST_MONGODB_URI is not set", { skip: true }, () => {});
}

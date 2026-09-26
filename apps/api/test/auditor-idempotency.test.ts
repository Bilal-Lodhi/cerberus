/**
 * `POST /api/v1/auditor/query` — durable idempotency, and a truthful answer.
 *
 * ── What this covers ──────────────────────────────────────────────────
 *
 * The auditor is the second paid route, and it differs from `/scenarios` in the way that
 * matters most for idempotency: **a durable read sits between its two paid calls.** So a
 * failure can occur after money has been spent and before anything usable exists, and the
 * route has to be honest about which of those happened.
 *
 * That is why the store-unavailable case is here rather than in a separate suite. The route
 * used to answer a failed `list_sessions` with `200` and a summary over an **empty** record
 * set — indistinguishable from a store that answered "no sessions matched". Once the
 * response is recorded for replay, that becomes worse than untruthful: the fabricated answer
 * is replayed for the whole retention window. A response is only worth remembering if it is
 * true, so the fix and the mechanism belong together.
 *
 * ── The provider is counted at the stub ───────────────────────────────
 *
 * "The response looked replayed" is not evidence that money was not spent, so every case
 * that asserts a replay also asserts the provider call count.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import { hashIdempotencyKey } from "../src/services/idempotency-key.js";
import { fingerprintAuditorRequest } from "../src/services/request-fingerprint.js";
import { authorizedHeaders, makeConfig } from "./helpers.js";
import { McpStoreDouble } from "./support/mcp-store-double.js";

const QUESTION = "which sessions pasted the most external content?";

const PIPELINE = JSON.stringify({ pipeline: [{ $limit: 5 }] });
const SUMMARY = "Two sessions show elevated exfiltration risk.";

/**
 * The scenarios route's two answers, needed by the one case that drives both paid routes
 * through the same app to prove their key namespaces are separate.
 */
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
  metadata: { matrixId: "matrix-1", generatedAt: "2026-01-01T00:00:00.000Z" },
  targetSystems: [{ systemId: "ts-1", name: "Core Trading Ledger" }],
  regulatoryMandates: [{ mandateId: "aml-001", name: "AML" }],
  threatVectors: [{ vectorId: "tv-1", title: "Exfil", severity: "high" }],
  penetrationScenarios: [{ scenarioId: "ps-1", vectorId: "tv-1" }],
});

interface TestStack {
  app: ReturnType<typeof createApp>;
  store: McpStoreDouble;
  aiCalls: () => number;
  setAi: (responder: (requestBody: string) => Response) => void;
  restore: () => void;
}

function aiChat(content: string, status = 200): Response {
  if (status !== 200) {
    return Response.json({ error: { message: `provider said ${status}` } }, { status });
  }
  return Response.json({
    id: "chatcmpl-stub",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  });
}

/**
 * The healthy provider, distinguished by system prompt.
 *
 * "MongoDB expert" is `toMongoPipeline`'s opening line; "Summarize these session records" is
 * `summarizeSessionRecords`'. Counting calls would be fragile here — the route makes two,
 * but a failure between them changes the count. The two scenarios prompts are answered too,
 * because one case drives both paid routes through the same app.
 */
function healthyAi(requestBody: string): Response {
  if (requestBody.includes("MongoDB expert")) return aiChat(PIPELINE);
  if (requestBody.includes("Summarize these session records")) return aiChat(SUMMARY);
  if (requestBody.includes("Classify the incoming request")) return aiChat(CLASSIFIER_ACCEPT);
  return aiChat(MATRIX);
}

function installStack(): TestStack {
  const store = new McpStoreDouble();
  const mcpResponder = store.responder();
  const original = globalThis.fetch;

  let aiCalls = 0;
  let aiResponder: (requestBody: string) => Response = healthyAi;

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
      aiCalls += 1;
      return aiResponder(typeof init?.body === "string" ? init.body : "");
    }

    return new Response(JSON.stringify({ success: false }), { status: 404 });
  }) as typeof fetch;

  return {
    app: createApp(makeConfig()),
    store,
    aiCalls: () => aiCalls,
    setAi: (responder) => {
      aiResponder = responder;
    },
    restore: () => {
      globalThis.fetch = original;
      resetAIProvider();
    },
  };
}

function post(
  stack: TestStack,
  options: { key?: string; question?: string; requestId?: string } = {},
) {
  const headers: Record<string, string> = authorizedHeaders();
  if (options.key !== undefined) headers["Idempotency-Key"] = options.key;
  if (options.requestId !== undefined) headers["X-Request-Id"] = options.requestId;

  return stack.app.request("/api/v1/auditor/query", {
    method: "POST",
    headers,
    body: JSON.stringify({ question: options.question ?? QUESTION }),
  });
}

function claims(store: McpStoreDouble): Array<Record<string, unknown>> {
  return [...store.operationClaims.values()];
}

/** A session document as `list_sessions` returns one. */
function seedSession(store: McpStoreDouble, sessionId: string, score: number): void {
  store.seedSession({
    sessionId,
    employeeId: "op-trader-001",
    auditId: "audit-2026-q1",
    status: "active",
    eventCount: 4,
    pasteCount: 2,
    overallRiskScore: score,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

describe("POST /api/v1/auditor/query — idempotency", () => {
  let stack: TestStack;

  beforeEach(() => {
    resetAIProvider();
    stack = installStack();
    seedSession(stack.store, "ses-1", 91);
    seedSession(stack.store, "ses-2", 42);
  });

  afterEach(() => {
    stack.restore();
  });

  // ── The header contract ───────────────────────────────────────────

  test("no key: today's behaviour, and no record is written", async () => {
    const res = await post(stack);

    assert.equal(res.status, 200);
    const body = (await res.json()) as { summary: string; raw: unknown[] };
    assert.equal(body.summary, SUMMARY);
    assert.equal(body.raw.length, 2, "the route did not return the sessions it read");
    assert.equal(stack.aiCalls(), 2, "the auditor makes two paid calls");
    assert.equal(claims(stack.store).length, 0, "a request with no key created a claim");
  });

  test("an invalid key is a 400, and nothing is claimed and nothing is spent", async () => {
    const res = await post(stack, { key: "bad key" });

    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code?: string }).code, "INVALID_IDEMPOTENCY_KEY");
    assert.equal(stack.aiCalls(), 0);
    assert.equal(claims(stack.store).length, 0);
  });

  // ── Same key, same request ────────────────────────────────────────

  test("the same key and question executes once and replays the first answer", async () => {
    const key = "auditor-retry-1";

    const first = await post(stack, { key });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { summary: string; raw: unknown[] };
    assert.equal(stack.aiCalls(), 2);

    const second = await post(stack, { key });

    assert.equal(stack.aiCalls(), 2, "a retry executed the auditor a second time");
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("Idempotency-Replayed"), "true");

    const secondBody = (await second.json()) as typeof firstBody;
    assert.equal(secondBody.summary, firstBody.summary);
    assert.deepEqual(secondBody.raw, firstBody.raw);
  });

  test("a different question is a conflict, and spends nothing", async () => {
    const key = "auditor-conflict-1";
    await post(stack, { key });
    assert.equal(stack.aiCalls(), 2);

    const second = await post(stack, { key, question: "a completely different question" });

    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as { code?: string }).code, "IDEMPOTENCY_CONFLICT");
    assert.equal(stack.aiCalls(), 2, "a conflict executed the provider");
  });

  test("leading whitespace is a different request, because the route does not trim it", async () => {
    // The route validates `question.trim()` is non-empty but passes `question` through
    // untrimmed to both paid calls, so these are genuinely two provider inputs.
    const key = "auditor-whitespace-1";
    await post(stack, { key });

    const second = await post(stack, { key, question: ` ${QUESTION}` });
    assert.equal(second.status, 409);
    assert.equal(stack.aiCalls(), 2);
  });

  // ── A fresh pending claim ─────────────────────────────────────────

  test("a fresh pending claim answers 409 with Retry-After and spends nothing", async () => {
    const key = "auditor-pending-1";
    stack.store.operationClaims.set(`auditor\u0000${hashIdempotencyKey(key)}`, {
      routeFamily: "auditor",
      keyHash: hashIdempotencyKey(key),
      fingerprint: fingerprintAuditorRequest({ question: QUESTION }),
      fingerprintVersion: 1,
      status: "pending",
      claimId: "someone-elses-claim",
      createdAt: new Date(),
      updatedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 600_000),
    });

    const res = await post(stack, { key });

    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code?: string }).code, "IDEMPOTENCY_IN_PROGRESS");
    assert.ok(res.headers.get("Retry-After"));
    assert.equal(stack.aiCalls(), 0);
  });

  // ── The claim store being unreachable ─────────────────────────────

  test("an unreachable claim store is a 503, and nothing is spent", async () => {
    stack.store.failToolTransport("claim_paid_operation", "mongo unreachable");

    const res = await post(stack, { key: "auditor-store-down-1" });

    assert.equal(res.status, 503);
    assert.equal(
      ((await res.json()) as { code?: string }).code,
      "IDEMPOTENCY_STATE_UNAVAILABLE",
    );
    assert.equal(stack.aiCalls(), 0);
  });

  // ── The truthfulness fix ──────────────────────────────────────────

  test("a failed session read is a 503, not a summary over nothing", async () => {
    // The route used to return 200 with a summary of an empty record set, which is
    // indistinguishable from a store that answered "no sessions matched".
    stack.store.failToolTransport("list_sessions", "mongo unreachable");

    const res = await post(stack, { key: "auditor-read-failure-1" });

    assert.equal(res.status, 503);
    const body = (await res.json()) as { code?: string; summary?: string; retryable?: boolean };
    assert.equal(body.code, "AUDITOR_STORE_UNAVAILABLE");
    assert.equal(body.retryable, true);
    assert.equal(body.summary, undefined, "an outage was reported as an audit finding");

    // The pipeline call was already made, so the operation produced nothing usable and is
    // recorded retryably: a same-key retry re-executes rather than replaying the outage.
    const record = claims(stack.store)[0];
    assert.ok(record);
    assert.equal(record["status"], "failed");
    assert.equal(record["retryable"], true);
  });

  test("a retry after a failed session read re-executes rather than replaying", async () => {
    const key = "auditor-read-retry-1";
    stack.store.failToolTransport("list_sessions", "mongo unreachable");
    assert.equal((await post(stack, { key })).status, 503);

    stack.store.clearFailures();
    const before = stack.aiCalls();
    const retry = await post(stack, { key });

    assert.equal(retry.status, 200);
    assert.ok(stack.aiCalls() > before, "a retry replayed the outage instead of executing");
    assert.equal(((await retry.json()) as { summary: string }).summary, SUMMARY);
  });

  // ── Provider failure ──────────────────────────────────────────────

  test("a provider failure is recorded retryably and reported additively", async () => {
    const key = "auditor-provider-down-1";
    stack.setAi(() => aiChat("", 401));

    const res = await post(stack, { key });

    // The status and the code are unchanged from before this cycle: a caller that ignores
    // `retryable` sees exactly what it saw before.
    assert.equal(res.status, 500);
    const body = (await res.json()) as { code?: string; retryable?: boolean };
    assert.equal(body.code, "AUDITOR_QUERY_FAILED");
    assert.equal(body.retryable, true, "a provider outage was not reported as retryable");

    const record = claims(stack.store)[0];
    assert.ok(record);
    assert.equal(record["status"], "failed");
    assert.equal(record["retryable"], true);

    stack.setAi(healthyAi);
    const before = stack.aiCalls();
    const retry = await post(stack, { key });

    assert.equal(retry.status, 200);
    assert.ok(stack.aiCalls() > before, "a retry after a provider outage did not execute");
  });

  // ── Replay identity ───────────────────────────────────────────────

  test("a replayed answer carries the CURRENT request's correlation identity", async () => {
    const key = "auditor-correlation-1";

    // The success body carries no correlationId, so the observable identity is the response
    // header — which must be the current request's on both the first call and the replay.
    const first = await post(stack, { key, requestId: "auditor-original" });
    assert.equal(first.headers.get("X-Request-Id"), "auditor-original");

    const second = await post(stack, { key, requestId: "auditor-retry" });
    assert.equal(second.headers.get("X-Request-Id"), "auditor-retry");
    assert.equal(second.headers.get("Idempotency-Replayed"), "true");
  });

  // ── Redaction ─────────────────────────────────────────────────────

  test("no claim record holds the raw key or the question", async () => {
    const key = "auditor-redaction-1";
    await post(stack, { key });

    const serialised = JSON.stringify(claims(stack.store));

    assert.ok(!serialised.includes(key), "a claim record holds the raw idempotency key");
    assert.ok(!serialised.includes(QUESTION), "a claim record holds the question");
    assert.ok(serialised.includes(hashIdempotencyKey(key)), "the digest should be stored");

    // The response body IS stored, deliberately: the record exists to answer a retry without
    // spending again, which means it has to hold the answer.
    const record = claims(stack.store)[0];
    assert.ok(record);
    assert.equal((record["result"] as { status: number }).status, 200);
  });

  // ── The two routes are separate namespaces ────────────────────────

  test("a key used on one paid route does not collide with the other", async () => {
    const key = "shared-key-across-routes-1";

    // The scenarios route is in the same app, so a key used there and here must produce two
    // separate operations rather than one answering for the other.
    const scenarios = await stack.app.request("/api/v1/scenarios", {
      method: "POST",
      headers: authorizedHeaders({ "Idempotency-Key": key }),
      body: JSON.stringify({
        prompt: "Author threat scenarios for the SWIFT gateway covering token injection",
        roleContext: "swift-gateway",
      }),
    });
    assert.equal(scenarios.status, 201);

    const auditor = await post(stack, { key });
    assert.equal(
      auditor.status,
      200,
      "an auditor request was answered from a scenarios claim, or refused as a conflict",
    );
    assert.equal(claims(stack.store).length, 2, "the two routes shared one claim record");
  });
});

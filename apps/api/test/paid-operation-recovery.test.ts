/**
 * Failure injection on the paid-operation claim.
 *
 * ── What this suite is for ────────────────────────────────────────────
 *
 * The happy paths and the ordinary refusals are covered elsewhere. This is the suite for the
 * states a healthy system never reaches: a provider that hangs, a provider that refuses, a
 * store that stops answering **after** money has been spent, and a result too large to keep.
 *
 * Those are the states where a wrong answer costs money rather than a wrong number on a
 * dashboard, and they are the ones a design document cannot prove. Every case here asserts
 * two things at once: **what the caller is told**, and **what the durable record says** — so
 * a route that reported the right thing while leaving the record in a state that would
 * re-spend on the next retry fails.
 *
 * ── The case this suite exists for ────────────────────────────────────
 *
 * *The provider succeeded and the completion write did not.* Cerberus observed a successful
 * paid call and then could not record it. The money is spent. Leaving the claim `pending`
 * would be the worst possible answer: it would sit until its lease expired, and the next
 * retry would reclaim it and spend **again** — on an operation that had already run.
 *
 * The route now records a failure that says exactly what happened: non-retryable, carrying a
 * small truthful substitute for the result that could not be retained. A same-key retry
 * answers from that record. §3.11 of the state model documents the residual window — when the
 * store is unreachable for that write too — and this suite asserts both halves, including the
 * half that cannot be closed.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import { hashIdempotencyKey } from "../src/services/idempotency-key.js";
import { completePaidOperation } from "../src/services/paid-operation.js";
import { MAX_STORED_RESULT_BYTES } from "../src/services/idempotency-limits.js";
import { authorizedHeaders, makeConfig } from "./helpers.js";
import { McpStoreDouble } from "./support/mcp-store-double.js";

const PROMPT = "Author threat scenarios for the SWIFT gateway covering token injection";
const ROLE = "swift-gateway";

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

function healthyAi(requestBody: string): Response {
  return aiChat(
    requestBody.includes("Classify the incoming request") ? CLASSIFIER_ACCEPT : MATRIX,
  );
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

function post(stack: TestStack, key?: string) {
  const headers: Record<string, string> = authorizedHeaders();
  if (key !== undefined) headers["Idempotency-Key"] = key;

  return stack.app.request("/api/v1/scenarios", {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: PROMPT, roleContext: ROLE }),
  });
}

function claims(store: McpStoreDouble): Array<Record<string, unknown>> {
  return [...store.operationClaims.values()];
}

describe("paid-operation claim — failure injection", () => {
  let stack: TestStack;

  beforeEach(() => {
    resetAIProvider();
    stack = installStack();
  });

  afterEach(() => {
    stack.restore();
  });

  // ── Provider failures ─────────────────────────────────────────────

  test("a provider quota error is retryable: the retry re-executes", async () => {
    const key = "fi-quota-1";
    stack.setAi(() => aiChat("", 429));

    const first = await post(stack, key);

    // The route reports the outage as it always has, and fail-closes on the classifier.
    assert.equal(first.status, 503);

    const record = claims(stack.store)[0];
    assert.ok(record, "the quota failure was not recorded");
    assert.equal(record["status"], "failed");
    assert.equal(
      record["retryable"],
      true,
      "a quota error was recorded non-retryable, so the key would be poisoned until it expired",
    );

    stack.setAi(healthyAi);
    const before = stack.aiCalls();
    const retry = await post(stack, key);

    assert.equal(retry.status, 201);
    assert.ok(stack.aiCalls() > before, "the retry replayed the quota error instead of executing");
  });

  test("a provider transport failure exhausts its attempts and is still retryable", async () => {
    const key = "fi-transport-1";
    // The provider client's own retry ladder runs, then gives up. What matters here is the
    // classification the route records, not how many attempts the client made.
    stack.setAi(() => aiChat("", 500));

    const first = await post(stack, key);
    assert.equal(first.status, 503);

    const record = claims(stack.store)[0];
    assert.ok(record);
    assert.equal(record["retryable"], true);
  });

  // ── The provider succeeded, and the completion write did not ──────

  test("a provider success whose completion write fails is recorded non-retryable", async () => {
    const key = "fi-completion-write-1";

    // The provider answers normally; only the completion write fails. This is the ambiguous
    // window: money is spent and the result cannot be recorded.
    stack.store.failToolTransport("complete_paid_operation", "mongo unreachable");

    const first = await post(stack, key);

    // The caller still receives the result the work produced — the operation did succeed.
    assert.equal(first.status, 201);

    const record = claims(stack.store)[0];
    assert.ok(record, "no claim record exists at all");
    assert.equal(
      record["status"],
      "failed",
      "the claim was left pending, so a retry after its lease would spend a second time",
    );
    assert.equal(
      record["retryable"],
      false,
      "a failure where the provider was observed to succeed was recorded as retryable, so a " +
        "same-key retry would spend again on an operation that already ran",
    );
    assert.equal(record["errorCategory"], "result-persist-failed");

    // The substitute is small, truthful, and says the money was already spent.
    const substitute = record["result"] as { status: number; body: { code?: string; error?: string } };
    assert.equal(substitute.status, 503);
    assert.equal(substitute.body.code, "IDEMPOTENCY_STATE_UNAVAILABLE");
    assert.match(String(substitute.body.error), /already ran|spend again/);
  });

  test("a same-key retry after that failure replays it instead of spending again", async () => {
    const key = "fi-completion-write-2";
    stack.store.failToolTransport("complete_paid_operation", "mongo unreachable");

    const first = await post(stack, key);
    assert.equal(first.status, 201);
    const spent = stack.aiCalls();
    assert.equal(spent, 2);

    // The store recovers, and the same key is retried.
    stack.store.clearFailures();
    const retry = await post(stack, key);

    assert.equal(
      stack.aiCalls(),
      spent,
      "a same-key retry spent again on an operation the provider had already completed",
    );
    assert.equal(retry.status, 503, "the retry should replay the recorded failure");
    assert.equal(retry.headers.get("Idempotency-Replayed"), "true");
    const body = (await retry.json()) as { code?: string };
    assert.equal(body.code, "IDEMPOTENCY_STATE_UNAVAILABLE");
  });

  test("the residual window: when the store is unreachable for BOTH writes, the claim stays pending", async () => {
    const key = "fi-residual-1";

    // The claim itself must land — otherwise this measures the pre-claim refusal, which is a
    // different case. Only the two *writes* fail.
    stack.store.failToolTransport("complete_paid_operation", "mongo unreachable");
    stack.store.failToolTransport("fail_paid_operation", "mongo unreachable");

    const first = await post(stack, key);
    assert.equal(first.status, 201);

    const record = claims(stack.store)[0];
    assert.ok(record, "the claim itself should have landed");
    assert.equal(
      record["status"],
      "pending",
      "the record reached a terminal state, which should not be possible with both writes down",
    );
    assert.equal(
      record["retryable"],
      undefined,
      "a failure was recorded despite the store refusing both writes",
    );

    // This is the window the mechanism cannot close: the claim sits `pending`, its lease
    // eventually expires, and a retry after that **will** execute again. It is asserted rather
    // than described, so nobody has to take the documentation's word for it.
    assert.equal(
      record["errorCategory"],
      undefined,
      "an error category was written without a failure write succeeding",
    );
  });

  // ── A result too large to retain ──────────────────────────────────

  test("a large but parser-bounded result is stored whole, so the ceiling is not reached", async () => {
    const key = "fi-large-legal-1";

    // The provider's output is bounded by the parsers before it ever reaches the route, so the
    // "too large to retain" branch is **not reachable through the route**. This asserts that
    // rather than assuming it: a matrix whose fields are as large as the parser will allow is
    // stored whole, with no `resultOmitted`.
    const large = "x".repeat(200_000);
    stack.setAi((requestBody) =>
      requestBody.includes("Classify the incoming request")
        ? aiChat(CLASSIFIER_ACCEPT)
        : aiChat(
            JSON.stringify({
              metadata: { matrixId: "matrix-large", generatedAt: "2026-01-01T00:00:00.000Z" },
              targetSystems: [{ systemId: "ts-1", name: large }],
              regulatoryMandates: [{ mandateId: "aml-001", name: large }],
              threatVectors: [{ vectorId: "tv-1", title: large, severity: "high" }],
              penetrationScenarios: [{ scenarioId: "ps-1", vectorId: "tv-1" }],
            }),
          ),
    );

    const res = await post(stack, key);
    assert.equal(res.status, 201);

    const record = claims(stack.store)[0];
    assert.ok(record);
    assert.equal(record["status"], "completed");
    assert.equal(
      record["resultOmitted"],
      undefined,
      "a parser-bounded result exceeded the retention ceiling, so the ceiling needs re-measuring",
    );

    // And it replays whole.
    const spent = stack.aiCalls();
    const retry = await post(stack, key);
    assert.equal(stack.aiCalls(), spent);
    assert.equal(retry.headers.get("Idempotency-Replayed"), "true");
  });

  // ── A result too large to retain, at the boundary the route cannot reach ──

  test("an over-large result is recorded completed with a truthful substitute", async () => {
    const key = "fi-too-large-1";

    // Driven through the service rather than the route, because the route cannot produce a
    // result this large: the parsers bound the provider's output long before it gets here. The
    // branch is defensive, and the honest thing is to test it directly and say so rather than
    // to leave it unexercised.
    const claim = await stack.store.claimPaidOperation({
      routeFamily: "scenarios",
      keyHash: hashIdempotencyKey(key),
      fingerprint: "fingerprint-for-the-boundary-test",
      fingerprintVersion: 1,
      leaseMs: 60_000,
      ttlMs: 300_000,
    });
    assert.equal(claim.outcome, "claimed");
    if (claim.outcome !== "claimed") return;

    const config = makeConfig();
    const context = {
      routeFamily: "scenarios" as const,
      keyHash: hashIdempotencyKey(key),
      fingerprint: "fingerprint-for-the-boundary-test",
      claimId: claim.claimId,
      ttlMs: 300_000,
      keyId: "boundary-test",
      claimedAtMs: Date.now(),
      reclaimed: false,
    };

    await completePaidOperation(config, context, {
      status: 201,
      body: { success: true, matrix: "y".repeat(MAX_STORED_RESULT_BYTES + 1_000) },
    });

    const record = claims(stack.store)[0];
    assert.ok(record);
    assert.equal(record["status"], "completed");
    assert.equal(record["resultOmitted"], "too-large");

    const substitute = record["result"] as { status: number; body: { code?: string; error?: string } };
    assert.equal(substitute.status, 503);
    assert.equal(substitute.body.code, "IDEMPOTENCY_STATE_UNAVAILABLE");
    assert.match(String(substitute.body.error), /too large|spend again/);
  });

  // ── The replay read failing ───────────────────────────────────────

  test("a replay whose claim read fails is a 503, and spends nothing", async () => {
    const key = "fi-replay-read-1";
    assert.equal((await post(stack, key)).status, 201);
    const spent = stack.aiCalls();

    // The store stops answering. The route cannot know whether this key already ran, so the
    // only safe answer is to refuse — proceeding would be the one request the mechanism
    // cannot protect.
    stack.store.failToolTransport("claim_paid_operation", "mongo unreachable");

    const retry = await post(stack, key);

    assert.equal(retry.status, 503);
    assert.equal(((await retry.json()) as { code?: string }).code, "IDEMPOTENCY_STATE_UNAVAILABLE");
    assert.equal(stack.aiCalls(), spent, "a request was executed while the claim was unreadable");
  });

  test("a claim read that answers with an unknown outcome is refused, not executed", async () => {
    const key = "fi-unknown-outcome-1";

    // A build-skew case: the store answers with an outcome this API does not know. Treating
    // it as `execute` would spend on an answer that could not be read.
    const originalResponder = stack.store.responder();
    const original = globalThis.fetch;
    const base = original;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/tools/claim_paid_operation")) {
        return Response.json({ success: true, outcome: "something-new" });
      }
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
        return originalResponder(tool, body);
      }
      return base(input as RequestInfo, init);
    }) as typeof fetch;

    const res = await post(stack, key);

    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { code?: string }).code, "IDEMPOTENCY_STATE_UNAVAILABLE");
    assert.equal(stack.aiCalls(), 0, "an unreadable claim outcome was executed");

    globalThis.fetch = base;
  });

  // ── Claim-store failures before anything is spent ─────────────────

  test("a claim that answers without a claim id is refused rather than executed", async () => {
    const key = "fi-no-claim-id-1";

    // A claim this process cannot address is one it can never complete, so executing would
    // leave the record `pending` until its lease expired — with the money already spent.
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/tools/claim_paid_operation")) {
        return Response.json({ success: true, outcome: "claimed" });
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch;

    const res = await post(stack, key);

    assert.equal(res.status, 503);
    assert.equal(stack.aiCalls(), 0, "the provider was called for a claim that cannot be completed");

    globalThis.fetch = original;
  });

  // ── The store being unreachable before the claim ──────────────────

  test("a store that is unreachable before the claim spends nothing and writes nothing", async () => {
    const key = "fi-preclaim-1";
    stack.store.failToolTransport("claim_paid_operation", "mongo unreachable");

    const res = await post(stack, key);

    assert.equal(res.status, 503);
    assert.equal(stack.aiCalls(), 0);
    assert.equal(claims(stack.store).length, 0, "a claim was written despite the store refusing");
  });

  // ── Two sequential requests, one process ──────────────────────────

  test("two sequential identical requests execute once, with the second replaying", async () => {
    // The in-process version of the race. It cannot prove the mutual exclusion — a single
    // thread never has two claims in flight — but it does prove the route does not re-execute
    // for a caller that simply pressed the button twice.
    const key = "fi-sequential-1";

    assert.equal((await post(stack, key)).status, 201);
    assert.equal(stack.aiCalls(), 2);

    const second = await post(stack, key);
    assert.equal(second.status, 201);
    assert.equal(second.headers.get("Idempotency-Replayed"), "true");
    assert.equal(stack.aiCalls(), 2);
    assert.equal(claims(stack.store).length, 1);
  });

  // ── The redaction guarantee, under a maximal record ───────────────

  test("a completed record holds the digest and the result, and never the key or the prompt", async () => {
    const key = "fi-redaction-1";
    await post(stack, key);

    const record = claims(stack.store)[0];
    assert.ok(record);
    assert.equal(record["keyHash"], hashIdempotencyKey(key));
    assert.ok(!JSON.stringify(record).includes(key));
    assert.ok(!JSON.stringify(record).includes(PROMPT));
  });
});

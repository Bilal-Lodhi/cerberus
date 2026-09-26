/**
 * `POST /api/v1/scenarios` — durable idempotency, end to end through the real route.
 *
 * ── What this covers that the store contract cannot ───────────────────
 *
 * `store-contract.test.ts` proves the claim *protocol*: the predicates, the reclaim, the
 * conditional completion. It says nothing about whether the route uses it correctly — and
 * the ways a route can use it incorrectly are the expensive ones: claiming after the
 * provider call, answering a conflict by executing, replaying a body that still carries the
 * original request's identity, or forgetting to record an outcome so the record sits
 * `pending` until its lease expires.
 *
 * So every case here drives the real Hono route, with the real provider client and the real
 * tool registry, against a stateful store double. The provider is counted at the stub,
 * because "the response looked replayed" is not evidence that money was not spent.
 *
 * ── What it deliberately does not cover ───────────────────────────────
 *
 * The race. A single-process suite cannot put two claimants in flight at once, so
 * "exactly one of two concurrent requests executes" is asserted against a real MongoDB with
 * two real API processes by `test/integration/multi-process-idempotency.test.ts`. This file
 * asserts the *decisions*; that file asserts the *interleaving*.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import { hashIdempotencyKey } from "../src/services/idempotency-key.js";
import {
  fingerprintScenariosRequest,
} from "../src/services/request-fingerprint.js";
import { normalizeSeverityMix } from "../src/routes/scenarios.js";
import { authorizedHeaders, makeConfig } from "./helpers.js";
import { McpStoreDouble } from "./support/mcp-store-double.js";

const CLASSIFIER_ACCEPT = JSON.stringify({
  isInputMeaningful: true,
  isScenarioRelated: true,
  isAppropriate: true,
  contentFlags: [],
  reason: "valid",
  confidence: 0.95,
  detectedDomain: "financial_services",
});

const CLASSIFIER_REJECT = JSON.stringify({
  isInputMeaningful: true,
  isScenarioRelated: false,
  isAppropriate: true,
  contentFlags: [],
  reason: "Not a threat-scenario request.",
  confidence: 0.9,
  detectedDomain: "financial_services",
});

const MATRIX = JSON.stringify({
  metadata: { matrixId: "matrix-1", generatedAt: "2026-01-01T00:00:00.000Z" },
  targetSystems: [{ systemId: "ts-1", name: "Core Trading Ledger" }],
  regulatoryMandates: [{ mandateId: "aml-001", name: "AML" }],
  threatVectors: [{ vectorId: "tv-1", title: "Exfil", severity: "high" }],
  penetrationScenarios: [{ scenarioId: "ps-1", vectorId: "tv-1" }],
});

const PROMPT = "Author threat scenarios for the SWIFT gateway covering token injection";
const ROLE = "swift-gateway";

/** The request body the tests send, as an object. */
function scenarioBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { prompt: PROMPT, roleContext: ROLE, vectorCount: 3, ...overrides };
}

/**
 * The fingerprint the route will compute for a body.
 *
 * Derived through the same function the route uses, from the same normalised values, so a
 * test that seeds a claim directly seeds the one the route will look for.
 */
function fingerprintOf(body: Record<string, unknown> = {}): string {
  return fingerprintScenariosRequest({
    prompt: String(body["prompt"] ?? PROMPT).trim(),
    roleContext: String(body["roleContext"] ?? ROLE),
    vectorCount: Number(body["vectorCount"] ?? 3),
    severityMix: normalizeSeverityMix(body["severityMix"]),
  });
}

interface TestStack {
  app: ReturnType<typeof createApp>;
  store: McpStoreDouble;
  /** How many times the *provider* was called. The number that matters. */
  aiCalls: () => number;
  /**
   * Replaces the provider's answers.
   *
   * The responder receives the raw request body, so a test can distinguish the two paid
   * calls the route makes — the classifier and the matrix author — from the prompt the
   * provider was actually given, rather than by counting calls. Counting is fragile here:
   * a call that throws changes the count, and an off-by-one would make a test assert the
   * wrong thing while still passing.
   */
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
 * The healthy provider: a verdict for the classifier, a matrix for the author.
 *
 * Distinguished by the system prompt, which is the only thing that differs between the two
 * calls. "Classify the incoming request" is the classifier's own opening line.
 */
function healthyAi(requestBody: string): Response {
  return aiChat(
    requestBody.includes("Classify the incoming request") ? CLASSIFIER_ACCEPT : MATRIX,
  );
}

/**
 * A stack with a stateful claim store and a controllable provider.
 *
 * `installFetchStub` is deliberately not used: it answers every provider call with the same
 * canned content, and these cases need the provider to fail, then succeed, then fail again.
 * The seam is the same one — `globalThis.fetch` — so the real provider client, the real
 * parsers and the real route all execute.
 */
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
  options: { key?: string; body?: Record<string, unknown>; requestId?: string; rawBody?: string } = {},
) {
  const headers: Record<string, string> = authorizedHeaders();
  if (options.key !== undefined) headers["Idempotency-Key"] = options.key;
  if (options.requestId !== undefined) headers["X-Request-Id"] = options.requestId;

  return stack.app.request("/api/v1/scenarios", {
    method: "POST",
    headers,
    body: options.rawBody ?? JSON.stringify(options.body ?? scenarioBody()),
  });
}

/** The claim records the store holds, as a list. */
function claims(store: McpStoreDouble): Array<Record<string, unknown>> {
  return [...store.operationClaims.values()];
}

describe("POST /api/v1/scenarios — idempotency", () => {
  let stack: TestStack;

  beforeEach(() => {
    resetAIProvider();
    stack = installStack();
  });

  afterEach(() => {
    stack.restore();
  });

  // ── The header contract ───────────────────────────────────────────

  test("no key: today's behaviour, and no record is written", async () => {
    const res = await post(stack);

    assert.equal(res.status, 201);
    assert.equal(stack.aiCalls(), 2);
    assert.equal(
      claims(stack.store).length,
      0,
      "a request with no idempotency key created a claim, so the change is not additive",
    );
  });

  test("an invalid key is a 400, and nothing is claimed and nothing is spent", async () => {
    const res = await post(stack, { key: "not a valid key" });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "INVALID_IDEMPOTENCY_KEY");

    assert.equal(stack.aiCalls(), 0, "the provider was called despite a rejected key");
    assert.equal(claims(stack.store).length, 0, "a rejected key consumed an operation");
  });

  test("an over-long key is rejected before the provider", async () => {
    const res = await post(stack, { key: "k".repeat(256) });
    assert.equal(res.status, 400);
    assert.equal(stack.aiCalls(), 0);
  });

  // ── Same key, same request ────────────────────────────────────────

  test("the same key and the same body executes once and replays the first result", async () => {
    const key = "retry-me-1";

    const first = await post(stack, { key });
    assert.equal(first.status, 201);
    const firstBody = (await first.json()) as {
      matrix: { metadata: { matrixId: string } };
      mcpCorrelationId: string;
      generationRequestId: string;
    };
    assert.equal(stack.aiCalls(), 2, "the first execution must make both paid calls");

    const second = await post(stack, { key });

    // The whole point: one key, one execution. Counted at the stub, because a replayed
    // response is not evidence that money was not spent.
    assert.equal(stack.aiCalls(), 2, "a retry executed the operation a second time");

    assert.equal(second.status, 201);
    assert.equal(second.headers.get("Idempotency-Replayed"), "true");

    const secondBody = (await second.json()) as typeof firstBody;
    assert.equal(secondBody.matrix.metadata.matrixId, firstBody.matrix.metadata.matrixId);
    // The operation's own identity is part of the business result and is replayed verbatim.
    assert.equal(secondBody.mcpCorrelationId, firstBody.mcpCorrelationId);
    assert.equal(secondBody.generationRequestId, firstBody.generationRequestId);
  });

  test("a reordered body is the same request, and replays rather than conflicting", async () => {
    const key = "reordered-1";
    await post(stack, { key });

    // Same semantic fields, different key order. The route normalises the mix, so this is
    // the same request written differently.
    const reordered = JSON.stringify({
      vectorCount: 3,
      roleContext: ROLE,
      prompt: PROMPT,
    });
    const second = await post(stack, { key, rawBody: reordered });

    assert.equal(
      second.status,
      201,
      "a reordered body was treated as a different request, so a legitimate retry was refused",
    );
    assert.equal(second.headers.get("Idempotency-Replayed"), "true");
    assert.equal(stack.aiCalls(), 2, "the reordered retry executed a second time");
  });

  test("a severity mix written at a different scale is the same request", async () => {
    const key = "severity-scale-1";
    // The route normalises to sum 1 before building the prompt, so these are one request.
    await post(stack, { key, body: scenarioBody({ severityMix: { low: 1, medium: 1, high: 1, critical: 1 } }) });

    const second = await post(stack, {
      key,
      body: scenarioBody({ severityMix: { low: 25, medium: 25, high: 25, critical: 25 } }),
    });

    assert.equal(second.status, 201);
    assert.equal(second.headers.get("Idempotency-Replayed"), "true");
    assert.equal(stack.aiCalls(), 2, "an equivalent severity mix executed a second time");
  });

  // ── Same key, different request ───────────────────────────────────

  test("the same key with a different body is a conflict, and spends nothing", async () => {
    const key = "conflict-1";
    await post(stack, { key });
    assert.equal(stack.aiCalls(), 2);

    const second = await post(stack, { key, body: scenarioBody({ prompt: "A different prompt entirely for the ledger" }) });

    assert.equal(second.status, 409);
    const body = (await second.json()) as { code?: string; error?: string };
    assert.equal(body.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(stack.aiCalls(), 2, "a conflict executed the provider");

    // And the conflict reveals nothing about the request the key was first used for.
    assert.ok(
      !JSON.stringify(body).includes(PROMPT),
      "the conflict response leaked the original request",
    );
  });

  test("a changed vector count is a different request", async () => {
    const key = "conflict-2";
    await post(stack, { key });

    const second = await post(stack, { key, body: scenarioBody({ vectorCount: 7 }) });
    assert.equal(second.status, 409);
    assert.equal(stack.aiCalls(), 2);
  });

  // ── A fresh pending claim ─────────────────────────────────────────

  test("a fresh pending claim answers 409 with Retry-After and spends nothing", async () => {
    const key = "pending-1";

    // Seeded directly, because a single process cannot leave its own claim pending while it
    // answers a second request. The fingerprint is the one the route will compute.
    stack.store.operationClaims.set(`scenarios\u0000${hashIdempotencyKey(key)}`, {
      routeFamily: "scenarios",
      keyHash: hashIdempotencyKey(key),
      fingerprint: fingerprintOf(),
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
    const body = (await res.json()) as { code?: string; retryAfterSeconds?: number };
    assert.equal(body.code, "IDEMPOTENCY_IN_PROGRESS");
    assert.ok((body.retryAfterSeconds ?? 0) >= 1, "an in-progress answer must say when to retry");
    assert.ok(res.headers.get("Retry-After"), "no Retry-After header was sent");
    assert.equal(stack.aiCalls(), 0, "a request against a live claim executed the provider");
  });

  test("a stale claim with the same fingerprint is reclaimed and executes", async () => {
    const key = "stale-1";
    stack.store.operationClaims.set(`scenarios\u0000${hashIdempotencyKey(key)}`, {
      routeFamily: "scenarios",
      keyHash: hashIdempotencyKey(key),
      fingerprint: fingerprintOf(),
      fingerprintVersion: 1,
      status: "pending",
      claimId: "abandoned-claim",
      createdAt: new Date(Date.now() - 600_000),
      updatedAt: new Date(Date.now() - 600_000),
      // Already expired, so the process that owned it is treated as gone.
      leaseExpiresAt: new Date(Date.now() - 1),
      expiresAt: new Date(Date.now() + 600_000),
    });

    const res = await post(stack, { key });

    assert.equal(res.status, 201);
    assert.equal(stack.aiCalls(), 2, "an abandoned claim did not let the retry execute");
  });

  // ── Failure semantics ─────────────────────────────────────────────

  test("a provider failure is recorded retryably, and a retry re-executes", async () => {
    const key = "provider-down-1";

    // A fatal provider error: the SDK classifies it from the status and throws immediately,
    // rather than retrying into a slow backoff ladder.
    stack.setAi(() => aiChat("", 401));

    const first = await post(stack, { key });
    assert.equal(first.status, 503, "a classifier outage must fail closed");

    const record = claims(stack.store)[0];
    assert.ok(record, "the failure was not recorded, so the claim would sit pending");
    assert.equal(record["status"], "failed");
    assert.equal(record["retryable"], true, "a provider outage was recorded as non-retryable");

    // The provider recovers, and the same key executes rather than replaying the outage.
    stack.setAi(healthyAi);
    const before = stack.aiCalls();
    const second = await post(stack, { key });

    assert.equal(second.status, 201);
    assert.ok(
      stack.aiCalls() > before,
      "a retry after a provider outage replayed the failure instead of executing",
    );
  });

  test("a classifier rejection is recorded as completed, and a retry replays it for free", async () => {
    const key = "rejected-1";

    stack.setAi((requestBody) =>
      aiChat(requestBody.includes("Classify the incoming request") ? CLASSIFIER_REJECT : MATRIX),
    );

    const first = await post(stack, { key });
    assert.equal(first.status, 422);

    const record = claims(stack.store)[0];
    assert.ok(record);
    assert.equal(
      record["status"],
      "completed",
      "a classifier rejection is a legitimate outcome, not a failure",
    );

    // The classifier already ran and answered. A retry must not pay for it again.
    const before = stack.aiCalls();
    const second = await post(stack, { key });

    assert.equal(second.status, 422);
    assert.equal(second.headers.get("Idempotency-Replayed"), "true");
    assert.equal(
      stack.aiCalls(),
      before,
      "a retry of a rejected request paid for the classifier a second time",
    );
  });

  test("a replayed rejection carries the CURRENT request's correlation id", async () => {
    const key = "rejected-correlation-1";
    stack.setAi((requestBody) =>
      aiChat(requestBody.includes("Classify the incoming request") ? CLASSIFIER_REJECT : MATRIX),
    );

    const first = await post(stack, { key, requestId: "original-request-id" });
    assert.equal(first.status, 422);
    const firstBody = (await first.json()) as { correlationId?: string };
    assert.equal(firstBody.correlationId, "original-request-id");

    const second = await post(stack, { key, requestId: "retry-request-id" });
    assert.equal(second.status, 422);
    const secondBody = (await second.json()) as { correlationId?: string };

    // The business result is the original's; the observability identity is not. Replaying
    // the original id would tell a client its response belongs to a finished request.
    assert.equal(
      secondBody.correlationId,
      "retry-request-id",
      "a replayed response presented stale observability identity",
    );
    assert.equal(second.headers.get("X-Request-Id"), "retry-request-id");
  });

  // ── The store being unreachable ───────────────────────────────────

  test("an unreachable claim store is a 503, and nothing is spent", async () => {
    const key = "store-down-1";
    stack.store.failToolTransport("claim_paid_operation", "mongo unreachable");

    const res = await post(stack, { key });

    assert.equal(res.status, 503);
    const body = (await res.json()) as { code?: string; retryable?: boolean };
    assert.equal(body.code, "IDEMPOTENCY_STATE_UNAVAILABLE");
    assert.equal(body.retryable, true);
    assert.equal(
      stack.aiCalls(),
      0,
      "the provider was called while the mutual exclusion could not be enforced",
    );
  });

  // ── Redaction ─────────────────────────────────────────────────────

  test("no claim record holds the raw key, the prompt, or the question", async () => {
    const key = "redaction-1";
    await post(stack, { key });

    const serialised = JSON.stringify(claims(stack.store));

    assert.ok(!serialised.includes(key), "a claim record holds the raw idempotency key");
    assert.ok(!serialised.includes(PROMPT), "a claim record holds the prompt");
    assert.ok(!serialised.includes(ROLE), "a claim record holds the role context");
    // The digest is what is stored, and it is not reversible.
    assert.ok(serialised.includes(hashIdempotencyKey(key)));

    // ── And the response body IS stored, deliberately ──
    //
    // The record's whole purpose is to answer a retry without spending again, which means
    // it has to hold the answer. This is not a leak: it is the mechanism. What is *not*
    // stored is the input — the prompt and the key — which is what the forbidden-field list
    // covers.
    const record = claims(stack.store)[0];
    assert.ok(record);
    assert.equal((record["result"] as { status: number }).status, 201);
  });

  test("the claim record stores the request fingerprint, not the request", async () => {
    const key = "fingerprint-1";
    await post(stack, { key });

    const record = claims(stack.store)[0];
    assert.ok(record);
    assert.equal(record["fingerprint"], fingerprintOf());
    assert.equal(record["fingerprintVersion"], 1);
  });

  test("the completion refreshes the retention window from the end of the operation", async () => {
    const key = "ttl-1";
    await post(stack, { key });

    const record = claims(stack.store)[0];
    assert.ok(record);
    const expiresAt = record["expiresAt"] as Date;
    // 24 hours by default, measured from completion rather than from the claim.
    assert.ok(expiresAt.getTime() > Date.now() + 23 * 3600_000);
  });

  test("the lease is derived from the provider timeout, not from a second setting", async () => {
    const key = "lease-1";
    await post(stack, { key });

    const record = claims(stack.store)[0];
    assert.ok(record);
    const created = record["createdAt"] as Date;
    const lease = record["leaseExpiresAt"] as Date;

    // The test config's provider timeout is 5 000 ms, so the derived lease is
    // 2 × 5000 + 30 000 = 40 000 ms, clamped to the 60 000 ms floor.
    assert.equal(lease.getTime() - created.getTime(), 60_000);
  });

  // ── Two families, one process ─────────────────────────────────────

  test("a completed claim is not re-claimed, so the record is never overwritten", async () => {
    const key = "stable-1";
    await post(stack, { key });
    const firstClaimId = claims(stack.store)[0]?.["claimId"];

    await post(stack, { key });

    const records = claims(stack.store);
    assert.equal(records.length, 1, "a retry created a second claim record");
    assert.equal(records[0]?.["claimId"], firstClaimId, "a replay replaced the claim");
  });
});

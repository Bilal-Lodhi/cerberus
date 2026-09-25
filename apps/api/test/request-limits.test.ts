/**
 * Request-surface bounds.
 *
 * The API had no request body size limit at all — `@hono/node-server` exposes no
 * `bodyLimit` option and none was configured — so every route buffered whatever
 * the caller sent. These tests pin the global cap and the per-field caps that
 * protect the paid-inference boundary.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import { DEFAULT_MAX_BODY_BYTES } from "../src/config.js";
import { MAX_EVENTS_PER_BATCH } from "../src/routes/guardian.js";
import { MAX_AUDITOR_RESULTS, MAX_QUESTION_CHARS } from "../src/routes/auditor.js";
import {
  MAX_PROMPT_CHARS,
  MAX_ROLE_CONTEXT_CHARS,
} from "../src/routes/scenarios.js";
import { MAX_IDENTITY_FIELD_CHARS } from "../src/routes/identity.js";
import {
  authorizedHeaders,
  installFetchStub,
  makeConfig,
  makeConfigWithBodyLimit,
  type FetchStub,
} from "./helpers.js";

/** The classifier reply, so scenario requests clear stage 1 and stage 2. */
const classifierAccept = JSON.stringify({
  isInputMeaningful: true,
  isScenarioRelated: true,
  isAppropriate: true,
  contentFlags: [],
  reason: "valid",
  confidence: 0.95,
  detectedDomain: "financial_services",
});

describe("global request body limit", () => {
  /** Small cap so the boundary is exercised without multi-megabyte fixtures. */
  const CAP = 1024;

  let stub: FetchStub;

  beforeEach(() => {
    resetAIProvider();
    stub = installFetchStub();
  });

  afterEach(() => {
    stub.restore();
    resetAIProvider();
  });

  test("the documented default is 8 MiB", () => {
    assert.equal(DEFAULT_MAX_BODY_BYTES, 8 * 1024 * 1024);
    assert.equal(makeConfig().security.maxRequestBodyBytes, DEFAULT_MAX_BODY_BYTES);
  });

  test("rejects a body larger than the configured cap", async () => {
    const app = createApp(makeConfigWithBodyLimit(CAP));

    const res = await app.request("/api/v1/scenarios", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        prompt: "x".repeat(CAP * 2),
        roleContext: "swift-gateway",
      }),
    });

    assert.equal(res.status, 413);
    const body = (await res.json()) as {
      success: boolean;
      code: string;
      maxBytes: number;
      correlationId: string;
    };
    assert.equal(body.success, false);
    assert.equal(body.code, "PAYLOAD_TOO_LARGE");
    assert.equal(body.maxBytes, CAP);
    assert.ok(body.correlationId.length > 0, "413 response carried no correlation id");

    // The oversized body never reached a route, so nothing was billed or stored.
    assert.equal(stub.calls.length, 0, "an oversized request reached a downstream call");
  });

  test("rejects an oversized body before authentication", async () => {
    const app = createApp(makeConfigWithBodyLimit(CAP));

    // No credential at all. The size bound is a resource control, so it is
    // enforced regardless of who is asking.
    const res = await app.request("/api/v1/scenarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "x".repeat(CAP * 2) }),
    });

    assert.equal(res.status, 413);
    assert.equal(stub.calls.length, 0);
  });

  test("admits a body under the cap and lets the route validate it", async () => {
    const app = createApp(makeConfigWithBodyLimit(CAP));

    // Valid JSON, under the cap, but the prompt is missing: the route's own
    // validation must be what answers, not the size bound.
    const res = await app.request("/api/v1/scenarios", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ roleContext: "swift-gateway" }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /prompt/);
  });

  test("caps a body sent without a content-length header", async () => {
    const app = createApp(makeConfigWithBodyLimit(CAP));

    // A chunked body has no Content-Length, so the cap has to be applied while
    // the stream is read rather than from a declared length.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"prompt":"'));
        controller.enqueue(new TextEncoder().encode("x".repeat(CAP * 2)));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
    });

    const res = await app.request("/api/v1/scenarios", {
      method: "POST",
      headers: authorizedHeaders(),
      body: stream,
      // @ts-expect-error Node requires duplex for a streaming request body.
      duplex: "half",
    });

    assert.equal(res.status, 413);
    assert.equal(stub.calls.length, 0);
  });

  test("does not disturb GET requests", async () => {
    const app = createApp(makeConfigWithBodyLimit(CAP));

    const res = await app.request("/health");
    assert.equal(res.status, 200);
  });
});

describe("scenario request field caps", () => {
  let stub: FetchStub;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetAIProvider();
    stub = installFetchStub({ aiResponses: [classifierAccept] });
    app = createApp(makeConfig());
  });

  afterEach(() => {
    stub.restore();
    resetAIProvider();
  });

  test("rejects an over-long prompt before any inference is spent", async () => {
    const res = await app.request("/api/v1/scenarios", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        prompt: "x".repeat(MAX_PROMPT_CHARS + 1),
        roleContext: "swift-gateway",
      }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string; maxChars: number };
    assert.equal(body.code, "PROMPT_TOO_LONG");
    assert.equal(body.maxChars, MAX_PROMPT_CHARS);
    assert.equal(stub.calls.length, 0, "an over-long prompt was sent to the provider");
  });

  test("accepts a prompt exactly at the cap", async () => {
    const res = await app.request("/api/v1/scenarios", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        prompt: "x".repeat(MAX_PROMPT_CHARS),
        roleContext: "swift-gateway",
      }),
    });

    // Not a 400: the cap is inclusive. It may still fail later in the pipeline,
    // which is not what this test is about.
    assert.notEqual(res.status, 400);
  });

  test("rejects an over-long roleContext", async () => {
    const res = await app.request("/api/v1/scenarios", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        prompt: "Author threat scenarios for the SWIFT gateway",
        roleContext: "y".repeat(MAX_ROLE_CONTEXT_CHARS + 1),
      }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "ROLE_CONTEXT_TOO_LONG");
    assert.equal(stub.calls.length, 0);
  });
});

describe("auditor request caps", () => {
  let stub: FetchStub;

  beforeEach(() => {
    resetAIProvider();
  });

  afterEach(() => {
    stub.restore();
    resetAIProvider();
  });

  test("rejects an over-long question before any inference is spent", async () => {
    stub = installFetchStub({ aiResponses: [JSON.stringify({ pipeline: [] }), "summary"] });
    const app = createApp(makeConfig());

    const res = await app.request("/api/v1/auditor/query", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ question: "q".repeat(MAX_QUESTION_CHARS + 1) }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string; maxChars: number };
    assert.equal(body.code, "QUESTION_TOO_LONG");
    assert.equal(body.maxChars, MAX_QUESTION_CHARS);
    assert.equal(stub.calls.length, 0);
  });

  test("caps the result set even when the model's pipeline has no $limit", async () => {
    const sessions = Array.from({ length: MAX_AUDITOR_RESULTS + 50 }, (_, i) => ({
      sessionId: `ses-${i}`,
      employeeId: `op-${i}`,
      overallRiskScore: i,
    }));

    stub = installFetchStub({
      mcpResponse: () => ({ success: true, data: sessions }),
      aiResponses: [JSON.stringify({ pipeline: [] }), "summary"],
    });
    const app = createApp(makeConfig());

    const res = await app.request("/api/v1/auditor/query", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ question: "which sessions scored highest?" }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { success: boolean; raw: unknown[] };
    assert.equal(body.success, true);
    assert.equal(
      body.raw.length,
      MAX_AUDITOR_RESULTS,
      "the auditor returned more records than the ceiling allows",
    );
  });
});

describe("guardian ingest batch cap", () => {
  let stub: FetchStub;

  beforeEach(() => {
    resetAIProvider();
    stub = installFetchStub();
  });

  afterEach(() => {
    stub.restore();
    resetAIProvider();
  });

  test("rejects a batch larger than the cap without touching the store", async () => {
    const app = createApp(makeConfig());
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, i) => ({
      eventId: `evt-${i}`,
      sessionId: "ses-batch",
      employeeId: "op-1",
      auditId: "audit-1",
      vectorId: "tv-1",
      eventType: "KEYSTROKE",
      timestamp: new Date().toISOString(),
      payload: { deltaMs: 100 },
      clientMetadata: {
        userAgent: "test",
        ipAddress: "127.0.0.1",
        screenResolution: "1920x1080",
        platform: "web",
        language: "en-US",
      },
    }));

    const res = await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string; maxEvents: number };
    assert.equal(body.code, "BATCH_TOO_LARGE");
    assert.equal(body.maxEvents, MAX_EVENTS_PER_BATCH);
    assert.equal(stub.calls.length, 0, "an over-sized batch reached the persistence layer");
  });
});

describe("identity field caps", () => {
  let stub: FetchStub;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetAIProvider();
    stub = installFetchStub();
    app = createApp(makeConfig());
  });

  afterEach(() => {
    stub.restore();
    resetAIProvider();
  });

  test("rejects an over-long displayName", async () => {
    const res = await app.request("/api/v1/identity/set", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        displayName: "d".repeat(MAX_IDENTITY_FIELD_CHARS + 1),
        employeeId: "op-1",
      }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "INVALID_IDENTITY_FIELD");
  });

  test("rejects a non-string field with 400 rather than throwing", async () => {
    // This used to cast the value and call `.trim()` on it, which threw inside
    // the handler and surfaced as an unhandled 500.
    const res = await app.request("/api/v1/identity/set", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ displayName: 123, employeeId: "op-1" }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string; error: string };
    assert.equal(body.code, "INVALID_IDENTITY_FIELD");
    assert.match(body.error, /displayName/);
  });

  test("accepts a well-formed identity", async () => {
    const res = await app.request("/api/v1/identity/set", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        displayName: "Compliance Operator",
        employeeId: "op-1",
        role: "analyst",
        department: "Trading Desk",
      }),
    });

    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      success: boolean;
      identity: { displayName: string; role?: string };
      sessionToken: string;
    };
    assert.equal(body.success, true);
    assert.equal(body.identity.displayName, "Compliance Operator");
    assert.equal(body.identity.role, "analyst");
    assert.ok(body.sessionToken.length > 0);
  });
});

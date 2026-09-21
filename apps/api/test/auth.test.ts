/**
 * Authentication boundary tests.
 *
 * Covers the mandatory security requirement: sensitive operations must be
 * rejected without a credential and accepted with one, and development mode
 * must be the only unauthenticated path.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/index.js";
import { constantTimeEquals, extractCredential } from "../src/middleware/auth.js";
import {
  TEST_API_KEY,
  anonymousHeaders,
  authorizedHeaders,
  makeConfig,
} from "./helpers.js";

describe("constantTimeEquals", () => {
  test("matches identical strings", () => {
    assert.equal(constantTimeEquals("abc123", "abc123"), true);
  });

  test("rejects differing strings of equal length", () => {
    assert.equal(constantTimeEquals("abc123", "abc124"), false);
  });

  test("rejects differing lengths", () => {
    assert.equal(constantTimeEquals("abc", "abcdef"), false);
  });

  test("never matches an empty expected value", () => {
    assert.equal(constantTimeEquals("", ""), false);
    assert.equal(constantTimeEquals("anything", ""), false);
    assert.equal(constantTimeEquals("", "anything"), false);
  });
});

describe("auth middleware", () => {
  let app: ReturnType<typeof createApp>;

  before(() => {
    app = createApp(makeConfig());
  });

  test("GET /health is public", async () => {
    const res = await app.request("/health", { headers: anonymousHeaders() });
    assert.equal(res.status, 200);
  });

  test("GET /api/v1/sessions without a credential is 401", async () => {
    const res = await app.request("/api/v1/sessions", { headers: anonymousHeaders() });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "UNAUTHENTICATED");
  });

  test("POST /api/v1/guardian/ingest without a credential is 401", async () => {
    const res = await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: anonymousHeaders(),
      body: JSON.stringify({ events: [] }),
    });
    assert.equal(res.status, 401);
  });

  test("DELETE /api/v1/guardian/sessions/:id without a credential is 401", async () => {
    const res = await app.request("/api/v1/guardian/sessions/ses-1", {
      method: "DELETE",
      headers: anonymousHeaders(),
    });
    assert.equal(res.status, 401);
  });

  test("POST /api/v1/guardian/sessions/:id/terminate without a credential is 401", async () => {
    const res = await app.request("/api/v1/guardian/sessions/ses-1/terminate", {
      method: "POST",
      headers: anonymousHeaders(),
    });
    assert.equal(res.status, 401);
  });

  test("POST /api/v1/scenarios without a credential is 401", async () => {
    const res = await app.request("/api/v1/scenarios", {
      method: "POST",
      headers: anonymousHeaders(),
      body: JSON.stringify({ prompt: "x", roleContext: "y" }),
    });
    assert.equal(res.status, 401);
  });

  test("POST /api/v1/auditor/query without a credential is 401", async () => {
    const res = await app.request("/api/v1/auditor/query", {
      method: "POST",
      headers: anonymousHeaders(),
      body: JSON.stringify({ question: "which sessions are risky?" }),
    });
    assert.equal(res.status, 401);
  });

  test("a wrong credential is rejected with the same shape as a missing one", async () => {
    const missing = await app.request("/api/v1/sessions", { headers: anonymousHeaders() });
    const wrong = await app.request("/api/v1/sessions", {
      headers: authorizedHeaders({ Authorization: "Bearer wrong-key-entirely" }),
    });

    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), await missing.json());
  });

  test("X-API-Key is accepted as an alternative to Authorization", async () => {
    const res = await app.request("/api/v1/sessions", {
      headers: { "Content-Type": "application/json", "X-API-Key": TEST_API_KEY },
    });
    assert.notEqual(res.status, 401);
  });

  test("a valid bearer token is accepted", async () => {
    const res = await app.request("/api/v1/sessions", { headers: authorizedHeaders() });
    assert.notEqual(res.status, 401);
  });
});

describe("development mode", () => {
  test("admits unauthenticated requests when explicitly enabled", async () => {
    const app = createApp(makeConfig({ devMode: true }));
    const res = await app.request("/api/v1/sessions", { headers: anonymousHeaders() });
    assert.notEqual(res.status, 401);
  });

  test("is off by default", async () => {
    const app = createApp(makeConfig({ devMode: false }));
    const res = await app.request("/api/v1/sessions", { headers: anonymousHeaders() });
    assert.equal(res.status, 401);
  });
});

describe("extractCredential", () => {
  test("parses a bearer token", () => {
    const ctx = fakeContext({ authorization: "Bearer abc123" });
    assert.equal(extractCredential(ctx), "abc123");
  });

  test("is case-insensitive on the scheme", () => {
    const ctx = fakeContext({ authorization: "bearer abc123" });
    assert.equal(extractCredential(ctx), "abc123");
  });

  test("falls back to X-API-Key", () => {
    const ctx = fakeContext({ "x-api-key": "abc123" });
    assert.equal(extractCredential(ctx), "abc123");
  });

  test("returns an empty string when nothing is presented", () => {
    const ctx = fakeContext({});
    assert.equal(extractCredential(ctx), "");
  });
});

/** Minimal Hono-context stand-in for the pure header-parsing helper. */
function fakeContext(headers: Record<string, string>): never {
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
    },
  } as never;
}

after(() => {
  // Nothing global to tear down; the fetch stub is scoped per test file.
});

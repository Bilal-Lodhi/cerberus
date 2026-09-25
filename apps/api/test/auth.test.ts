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
import {
  constantTimeEquals,
  credentialMatches,
  extractCredential,
} from "../src/middleware/auth.js";
import {
  TEST_API_KEY,
  anonymousHeaders,
  authorizedHeaders,
  makeConfig,
} from "./helpers.js";

const PREVIOUS_API_KEY = "retired-operator-key-0123456789";

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

// ═══════════════════════════════════════════════════════════════════
// Key rotation overlap
// ═══════════════════════════════════════════════════════════════════

describe("credentialMatches", () => {
  test("matches the current key", () => {
    const auth = { apiKey: "current", headerNames: [] };
    assert.equal(credentialMatches("current", auth), true);
  });

  test("does not match a wrong key", () => {
    const auth = { apiKey: "current", headerNames: [] };
    assert.equal(credentialMatches("nope", auth), false);
  });

  test("matches the previous key during an overlap", () => {
    const auth = { apiKey: "current", previousApiKey: "retired", headerNames: [] };
    assert.equal(credentialMatches("retired", auth), true);
  });

  test("still matches the current key during an overlap", () => {
    const auth = { apiKey: "current", previousApiKey: "retired", headerNames: [] };
    assert.equal(credentialMatches("current", auth), true);
  });

  test("matches neither once the previous key is unset", () => {
    // Ending the overlap is what retires the old key; there is no revocation list.
    const auth = { apiKey: "current", headerNames: [] };
    assert.equal(credentialMatches("retired", auth), false);
  });

  test("an empty presentation never matches, even against an empty key", () => {
    assert.equal(credentialMatches("", { apiKey: "current", headerNames: [] }), false);
    assert.equal(credentialMatches("", { apiKey: "", headerNames: [] }), false);
    assert.equal(
      credentialMatches("", { apiKey: "", previousApiKey: "", headerNames: [] }),
      false,
    );
  });

  test("an empty previous key is not a wildcard", () => {
    const auth = { apiKey: "current", previousApiKey: "", headerNames: [] };
    assert.equal(credentialMatches("current", auth), true);
    assert.equal(credentialMatches("anything-else", auth), false);
  });
});

describe("key rotation through the API", () => {
  function rotatingApp() {
    return createApp(
      makeConfig({
        auth: {
          apiKey: TEST_API_KEY,
          previousApiKey: PREVIOUS_API_KEY,
          headerNames: ["authorization", "x-api-key"],
        },
      }),
    );
  }

  test("the current key is accepted", async () => {
    const res = await rotatingApp().request("/api/v1/sessions", {
      headers: authorizedHeaders(),
    });
    assert.notEqual(res.status, 401);
  });

  test("the previous key is accepted during the overlap", async () => {
    const res = await rotatingApp().request("/api/v1/sessions", {
      headers: authorizedHeaders({ Authorization: `Bearer ${PREVIOUS_API_KEY}` }),
    });
    assert.notEqual(res.status, 401);
  });

  test("the previous key works through X-API-Key too", async () => {
    const res = await rotatingApp().request("/api/v1/sessions", {
      headers: { "Content-Type": "application/json", "X-API-Key": PREVIOUS_API_KEY },
    });
    assert.notEqual(res.status, 401);
  });

  test("a key that is neither current nor previous is rejected", async () => {
    const res = await rotatingApp().request("/api/v1/sessions", {
      headers: authorizedHeaders({ Authorization: "Bearer neither-of-them" }),
    });
    assert.equal(res.status, 401);
  });

  test("a missing credential is rejected during an overlap", async () => {
    const res = await rotatingApp().request("/api/v1/sessions", {
      headers: anonymousHeaders(),
    });
    assert.equal(res.status, 401);
  });

  test("the rejection shape is identical to the non-rotating case", async () => {
    // The overlap must not change what a failure looks like, or it becomes a
    // signal about which keys exist.
    const rotating = await rotatingApp().request("/api/v1/sessions", {
      headers: authorizedHeaders({ Authorization: "Bearer wrong" }),
    });
    const plain = await createApp(makeConfig()).request("/api/v1/sessions", {
      headers: authorizedHeaders({ Authorization: "Bearer wrong" }),
    });

    assert.equal(rotating.status, plain.status);
    assert.deepEqual(await rotating.json(), await plain.json());
  });

  test("the retired key stops working once the overlap ends", async () => {
    const ended = createApp(
      makeConfig({
        auth: {
          apiKey: TEST_API_KEY,
          headerNames: ["authorization", "x-api-key"],
        },
      }),
    );

    const res = await ended.request("/api/v1/sessions", {
      headers: authorizedHeaders({ Authorization: `Bearer ${PREVIOUS_API_KEY}` }),
    });
    assert.equal(res.status, 401, "the retired key still works after the overlap");
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

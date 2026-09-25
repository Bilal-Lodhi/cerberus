/**
 * Operator identity registry bounds.
 *
 * The registry is a `Map` in process memory. Before this it grew by one entry
 * for every `POST /api/v1/identity/set` and nothing was ever evicted, while the
 * `GET /me` handler already described an unknown handle as "unknown or expired".
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import {
  IDENTITY_HANDLE_TTL_MS,
  MAX_IDENTITY_HANDLES,
  identityStore,
} from "../src/routes/identity.js";
import { authorizedHeaders, makeConfig } from "./helpers.js";

describe("operator identity registry", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetAIProvider();
    identityStore.clear();
    app = createApp(makeConfig());
  });

  afterEach(() => {
    identityStore.clear();
    resetAIProvider();
  });

  async function register(displayName: string): Promise<string> {
    const res = await app.request("/api/v1/identity/set", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ displayName, employeeId: `op-${displayName}` }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { sessionToken: string };
    return body.sessionToken;
  }

  test("a registered handle resolves", async () => {
    const token = await register("Compliance Operator");

    const res = await app.request("/api/v1/identity/me", {
      headers: authorizedHeaders({ "X-Session-Token": token }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      success: boolean;
      identity: { displayName: string };
    };
    assert.equal(body.success, true);
    assert.equal(body.identity.displayName, "Compliance Operator");
  });

  test("an unknown handle is rejected", async () => {
    const res = await app.request("/api/v1/identity/me", {
      headers: authorizedHeaders({ "X-Session-Token": "not-a-real-handle" }),
    });

    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /Unknown or expired/);
  });

  test("a missing handle header is rejected", async () => {
    const res = await app.request("/api/v1/identity/me", { headers: authorizedHeaders() });
    assert.equal(res.status, 401);
  });

  test("an expired handle is rejected, matching the error message", async () => {
    identityStore.set("stale-handle", {
      identity: { displayName: "Stale Operator", employeeId: "op-stale" },
      issuedAtMs: Date.now() - IDENTITY_HANDLE_TTL_MS - 1,
    });

    const res = await app.request("/api/v1/identity/me", {
      headers: authorizedHeaders({ "X-Session-Token": "stale-handle" }),
    });

    assert.equal(res.status, 401);
    assert.equal(identityStore.has("stale-handle"), false, "the stale handle lingered");
  });

  test("a handle at the boundary is still valid", async () => {
    identityStore.set("fresh-handle", {
      identity: { displayName: "Fresh Operator", employeeId: "op-fresh" },
      issuedAtMs: Date.now(),
    });

    const res = await app.request("/api/v1/identity/me", {
      headers: authorizedHeaders({ "X-Session-Token": "fresh-handle" }),
    });
    assert.equal(res.status, 200);
  });

  test("the registry never exceeds its ceiling", async () => {
    for (let i = 0; i < MAX_IDENTITY_HANDLES + 25; i++) {
      await register(`Operator ${i}`);
    }

    assert.equal(identityStore.size, MAX_IDENTITY_HANDLES);
  });

  test("registering past the ceiling evicts the oldest handle first", async () => {
    const first = await register("Operator First");
    for (let i = 0; i < MAX_IDENTITY_HANDLES - 1; i++) {
      await register(`Operator ${i}`);
    }
    assert.equal(identityStore.size, MAX_IDENTITY_HANDLES);

    // One more registration must push the very first handle out, not a random one.
    await register("Operator Overflow");

    assert.equal(identityStore.has(first), false, "the oldest handle survived eviction");
    assert.equal(identityStore.size, MAX_IDENTITY_HANDLES);

    const res = await app.request("/api/v1/identity/me", {
      headers: authorizedHeaders({ "X-Session-Token": first }),
    });
    assert.equal(res.status, 401);
  });

  test("expired handles are reclaimed before the size ceiling is reached", async () => {
    // Fill the registry with entries that are already expired.
    for (let i = 0; i < MAX_IDENTITY_HANDLES; i++) {
      identityStore.set(`stale-${i}`, {
        identity: { displayName: `Stale ${i}`, employeeId: `op-${i}` },
        issuedAtMs: Date.now() - IDENTITY_HANDLE_TTL_MS - 1,
      });
    }

    const token = await register("Fresh Operator");

    // The expired entries are dropped rather than the fresh one being refused.
    assert.equal(identityStore.size, 1);
    assert.equal(identityStore.has(token), true);
  });
});

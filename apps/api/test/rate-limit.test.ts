/**
 * Rate limiting.
 *
 * The limiter's boundary is asserted with an injected clock, so nothing sleeps and
 * the refill arithmetic is exact rather than approximate. The integration tests
 * drive the real routes with the limiter enabled, because a limiter that is only
 * unit-tested is a limiter nobody knows is wired up.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import {
  RATE_LIMIT_POLICIES,
  categorizeRequest,
  createRateLimiter,
} from "../src/services/rate-limit.js";
import { createManualClock } from "../src/services/session-liveness.js";
import {
  anonymousHeaders,
  authorizedHeaders,
  installFetchStub,
  makeConfig,
  type FetchStub,
} from "./helpers.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

describe("createRateLimiter", () => {
  test("allows a full burst then refuses", () => {
    const limiter = createRateLimiter({ clock: createManualClock(T0) });
    const policy = { limit: 3, windowMs: 60_000 };

    for (let i = 0; i < 3; i++) {
      assert.equal(limiter.check("read", policy).allowed, true, `request ${i + 1}`);
    }
    assert.equal(limiter.check("read", policy).allowed, false);
  });

  test("refuses exactly at the boundary and allows one millisecond later", () => {
    const clock = createManualClock(T0);
    const limiter = createRateLimiter({ clock });
    // 60 requests per minute is one per second.
    const policy = { limit: 60, windowMs: 60_000 };

    for (let i = 0; i < 60; i++) limiter.check("read", policy);
    assert.equal(limiter.check("read", policy).allowed, false);

    clock.advance(999);
    assert.equal(limiter.check("read", policy).allowed, false, "one token per second");

    clock.advance(1);
    assert.equal(limiter.check("read", policy).allowed, true, "exactly one second later");
  });

  test("reports the seconds until the next token", () => {
    const clock = createManualClock(T0);
    const limiter = createRateLimiter({ clock });
    const policy = { limit: 60, windowMs: 60_000 };

    for (let i = 0; i < 60; i++) limiter.check("read", policy);

    const decision = limiter.check("read", policy);
    assert.equal(decision.allowed, false);
    assert.equal(decision.retryAfterSeconds, 1, "a full second of refill is needed");
    assert.equal(decision.remaining, 0);
  });

  test("reports the burst limit so the header is meaningful", () => {
    const limiter = createRateLimiter({ clock: createManualClock(T0) });
    const decision = limiter.check("read", { limit: 7, windowMs: 60_000 });

    assert.equal(decision.limit, 7);
    assert.equal(decision.remaining, 6);
  });

  test("refills over the window rather than all at once", () => {
    const clock = createManualClock(T0);
    const limiter = createRateLimiter({ clock });
    const policy = { limit: 10, windowMs: 10_000 }; // one per second

    for (let i = 0; i < 10; i++) limiter.check("read", policy);
    assert.equal(limiter.check("read", policy).allowed, false);

    // Half the window refills half the burst.
    clock.advance(5_000);
    let allowed = 0;
    for (let i = 0; i < 10; i++) if (limiter.check("read", policy).allowed) allowed++;
    assert.equal(allowed, 5);
  });

  test("never exceeds the burst after a long idle period", () => {
    const clock = createManualClock(T0);
    const limiter = createRateLimiter({ clock });
    const policy = { limit: 3, windowMs: 60_000 };

    clock.advance(24 * 3600 * 1000);
    let allowed = 0;
    for (let i = 0; i < 10; i++) if (limiter.check("read", policy).allowed) allowed++;
    assert.equal(allowed, 3, "idle time must not accumulate an unbounded balance");
  });

  test("a clock that moves backwards does not mint tokens", () => {
    const clock = createManualClock(T0);
    const limiter = createRateLimiter({ clock });
    const policy = { limit: 2, windowMs: 60_000 };

    limiter.check("read", policy);
    limiter.check("read", policy);
    assert.equal(limiter.check("read", policy).allowed, false);

    clock.advance(-60_000);
    assert.equal(
      limiter.check("read", policy).allowed,
      false,
      "a backwards clock granted a token",
    );
  });

  test("buckets are independent per category", () => {
    const limiter = createRateLimiter({ clock: createManualClock(T0) });
    const policy = { limit: 1, windowMs: 60_000 };

    assert.equal(limiter.check("ai", policy).allowed, true);
    assert.equal(limiter.check("ai", policy).allowed, false);
    assert.equal(limiter.check("read", policy).allowed, true, "a shared bucket would refuse");
  });

  test("memory is bounded: one bucket per category, whatever the traffic", () => {
    const limiter = createRateLimiter({ clock: createManualClock(T0) });

    for (let i = 0; i < 5_000; i++) {
      limiter.check("read");
      limiter.check("ingest");
      limiter.check("mutation");
      limiter.check("ai");
    }

    assert.equal(limiter.trackedBuckets, 4);
  });

  test("an unusable policy refuses rather than dividing by zero", () => {
    const limiter = createRateLimiter({ clock: createManualClock(T0) });

    for (const policy of [
      { limit: 0, windowMs: 60_000 },
      { limit: -1, windowMs: 60_000 },
      { limit: 1, windowMs: 0 },
    ]) {
      const decision = limiter.check("read", policy);
      assert.equal(decision.allowed, false, `policy ${JSON.stringify(policy)}`);
      assert.ok(Number.isFinite(decision.retryAfterSeconds));
    }
  });

  test("the documented defaults are the ones used when no override is given", () => {
    const limiter = createRateLimiter({ clock: createManualClock(T0) });
    assert.equal(limiter.check("ai").limit, RATE_LIMIT_POLICIES.ai.limit);
    assert.equal(limiter.check("ingest").limit, RATE_LIMIT_POLICIES.ingest.limit);
    assert.equal(limiter.check("mutation").limit, RATE_LIMIT_POLICIES.mutation.limit);
    assert.equal(limiter.check("read").limit, RATE_LIMIT_POLICIES.read.limit);
  });

  test("the AI ceiling is the tightest of the defaults", () => {
    // It is the one that spends money, so it must not be the loosest.
    const limits = Object.values(RATE_LIMIT_POLICIES).map((p) => p.limit);
    assert.equal(Math.min(...limits), RATE_LIMIT_POLICIES.ai.limit);
  });
});

describe("categorizeRequest", () => {
  test("liveness and readiness are exempt", () => {
    assert.equal(categorizeRequest("GET", "/health"), null);
    assert.equal(categorizeRequest("GET", "/"), null);
    assert.equal(categorizeRequest("GET", "/ready"), null);
  });

  test("AI-backed endpoints are their own category", () => {
    assert.equal(categorizeRequest("POST", "/api/v1/scenarios"), "ai");
    assert.equal(categorizeRequest("POST", "/api/v1/auditor/query"), "ai");
  });

  test("scenario cancellation is a mutation, not an AI call", () => {
    assert.equal(categorizeRequest("POST", "/api/v1/scenarios/cancel"), "mutation");
  });

  test("ingestion has its own category", () => {
    assert.equal(categorizeRequest("POST", "/api/v1/guardian/ingest"), "ingest");
  });

  test("reads are reads", () => {
    assert.equal(categorizeRequest("GET", "/api/v1/sessions"), "read");
    assert.equal(categorizeRequest("GET", "/api/v1/guardian/sessions"), "read");
    assert.equal(categorizeRequest("OPTIONS", "/api/v1/sessions"), "read");
  });

  test("everything else that changes state is a mutation", () => {
    assert.equal(categorizeRequest("POST", "/api/v1/identity/set"), "mutation");
    assert.equal(categorizeRequest("POST", "/api/v1/reference-documents"), "mutation");
    assert.equal(
      categorizeRequest("DELETE", "/api/v1/reference-documents/ref-1"),
      "mutation",
    );
    assert.equal(
      categorizeRequest("POST", "/api/v1/guardian/sessions/ses-1/terminate"),
      "mutation",
    );
  });

  test("the method matters, not just the path", () => {
    // GET /api/v1/scenarios is not a route, but if it were it would be a read.
    assert.equal(categorizeRequest("GET", "/api/v1/scenarios"), "read");
  });
});

describe("rate limiting through the real routes", () => {
  let stub: FetchStub;

  beforeEach(() => {
    resetAIProvider();
    stub = installFetchStub();
  });

  afterEach(() => {
    stub.restore();
    resetAIProvider();
  });

  /** An app whose limiter has tiny buckets, so a boundary is reachable. */
  function tinyLimits(overrides: Partial<Record<string, { limit: number; windowMs: number }>> = {}) {
    const clock = createManualClock(T0);
    const limiter = createRateLimiter({
      clock,
      policies: {
        ai: { limit: 2, windowMs: 60_000 },
        ingest: { limit: 2, windowMs: 60_000 },
        mutation: { limit: 2, windowMs: 60_000 },
        read: { limit: 2, windowMs: 60_000 },
        ...overrides,
      },
    });
    const app = createApp(
      makeConfig({ rateLimit: { enabled: true, aiRequestsPerMinute: 2 } }),
      { clock, rateLimiter: limiter },
    );
    return { app, clock };
  }

  test("a read bucket refuses with 429 and a stable code", async () => {
    const { app } = tinyLimits();

    assert.equal((await app.request("/api/v1/sessions", { headers: authorizedHeaders() })).status, 200);
    assert.equal((await app.request("/api/v1/sessions", { headers: authorizedHeaders() })).status, 200);

    const limited = await app.request("/api/v1/sessions", { headers: authorizedHeaders() });
    assert.equal(limited.status, 429);

    const body = (await limited.json()) as {
      success: boolean;
      code: string;
      category: string;
      retryAfterSeconds: number;
    };
    assert.equal(body.success, false);
    assert.equal(body.code, "RATE_LIMITED");
    assert.equal(body.category, "read");
    assert.ok(body.retryAfterSeconds >= 1);
    assert.equal(limited.headers.get("Retry-After"), String(body.retryAfterSeconds));
  });

  test("the rate-limit headers are present on a successful response", async () => {
    const { app } = tinyLimits();
    const res = await app.request("/api/v1/sessions", { headers: authorizedHeaders() });

    assert.equal(res.headers.get("X-RateLimit-Limit"), "2");
    assert.equal(res.headers.get("X-RateLimit-Remaining"), "1");
  });

  test("the AI bucket is the tightest and reports its own category", async () => {
    const { app } = tinyLimits();

    for (let i = 0; i < 2; i++) {
      const res = await app.request("/api/v1/auditor/query", {
        method: "POST",
        headers: authorizedHeaders(),
        body: JSON.stringify({ question: "which sessions scored highest?" }),
      });
      assert.notEqual(res.status, 429, `request ${i + 1} should have been allowed`);
    }

    const limited = await app.request("/api/v1/auditor/query", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ question: "which sessions scored highest?" }),
    });
    assert.equal(limited.status, 429);
    assert.equal(((await limited.json()) as { category: string }).category, "ai");
  });

  test("the AI limit comes from configuration", async () => {
    // The one limit an operator tunes. Three, not the injected two.
    const clock = createManualClock(T0);
    const app = createApp(
      makeConfig({ rateLimit: { enabled: true, aiRequestsPerMinute: 3 } }),
      { clock },
    );

    for (let i = 0; i < 3; i++) {
      const res = await app.request("/api/v1/auditor/query", {
        method: "POST",
        headers: authorizedHeaders(),
        body: JSON.stringify({ question: "which sessions scored highest?" }),
      });
      assert.notEqual(res.status, 429, `request ${i + 1}`);
    }

    const limited = await app.request("/api/v1/auditor/query", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ question: "which sessions scored highest?" }),
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("X-RateLimit-Limit"), "3");
  });

  test("ingest has its own bucket", async () => {
    const { app } = tinyLimits();

    for (let i = 0; i < 2; i++) {
      const res = await app.request("/api/v1/guardian/ingest", {
        method: "POST",
        headers: authorizedHeaders(),
        body: JSON.stringify({ events: [] }),
      });
      assert.notEqual(res.status, 429);
    }

    const limited = await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events: [] }),
    });
    assert.equal(limited.status, 429);
    assert.equal(((await limited.json()) as { category: string }).category, "ingest");
  });

  test("mutation has its own bucket", async () => {
    const { app } = tinyLimits();

    for (let i = 0; i < 2; i++) {
      const res = await app.request("/api/v1/identity/set", {
        method: "POST",
        headers: authorizedHeaders(),
        body: JSON.stringify({ displayName: "Operator", employeeId: "op-1" }),
      });
      assert.notEqual(res.status, 429);
    }

    const limited = await app.request("/api/v1/identity/set", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ displayName: "Operator", employeeId: "op-1" }),
    });
    assert.equal(limited.status, 429);
    assert.equal(((await limited.json()) as { category: string }).category, "mutation");
  });

  test("health is never rate limited", async () => {
    const { app } = tinyLimits();

    for (let i = 0; i < 20; i++) {
      const res = await app.request("/health");
      assert.equal(res.status, 200, `health request ${i + 1} was limited`);
    }
    assert.equal((await app.request("/")).status, 200);
  });

  test("the limiter runs after authentication", async () => {
    // An unauthenticated caller must not be able to exhaust a bucket and deny
    // service to the operator. It receives 401, not 429, however many times it
    // asks.
    const { app } = tinyLimits();

    for (let i = 0; i < 10; i++) {
      const res = await app.request("/api/v1/sessions", { headers: anonymousHeaders() });
      assert.equal(res.status, 401, `unauthenticated request ${i + 1} was limited`);
    }

    // And the operator's bucket is untouched.
    assert.equal((await app.request("/api/v1/sessions", { headers: authorizedHeaders() })).status, 200);
  });

  test("the bucket refills and the same client is served again", async () => {
    const { app, clock } = tinyLimits();

    await app.request("/api/v1/sessions", { headers: authorizedHeaders() });
    await app.request("/api/v1/sessions", { headers: authorizedHeaders() });
    assert.equal((await app.request("/api/v1/sessions", { headers: authorizedHeaders() })).status, 429);

    // The read bucket is two per minute, so a full window restores the burst.
    clock.advance(60_000);
    assert.equal((await app.request("/api/v1/sessions", { headers: authorizedHeaders() })).status, 200);
  });

  test("disabling the limiter leaves the routes unrestricted", async () => {
    const app = createApp(makeConfig({ rateLimit: { enabled: false, aiRequestsPerMinute: 1 } }));

    for (let i = 0; i < 10; i++) {
      const res = await app.request("/api/v1/sessions", { headers: authorizedHeaders() });
      assert.equal(res.status, 200, `request ${i + 1}`);
    }
  });
});

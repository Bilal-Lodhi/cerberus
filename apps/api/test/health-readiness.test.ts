/**
 * Liveness and readiness.
 *
 * The distinction is the whole point: `/health` must never check a dependency, and
 * `/ready` must. A liveness probe that fails when MongoDB is down causes the
 * orchestrator to restart a healthy process in a loop while the outage continues.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import {
  createReadinessProbe,
  withDeadline,
} from "../src/services/readiness.js";
import { createManualClock } from "../src/services/session-liveness.js";
import {
  FEATURES,
  createReadyRouter,
  healthRouter,
  SERVICE_NAME,
} from "../src/routes/health.js";
import {
  anonymousHeaders,
  installFetchStub,
  makeConfig,
  type FetchStub,
} from "./helpers.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

/** A probe that always reports the given state. */
function fixedProbe(ready: boolean) {
  return async () => ({
    ready,
    checkedAt: "2026-01-01T00:00:00.000Z",
    cached: false,
    dependencies: [
      {
        name: "mcp-persistence",
        state: ready ? ("up" as const) : ("down" as const),
        ...(ready ? {} : { detail: "connection refused" }),
      },
    ],
  });
}

describe("withDeadline", () => {
  test("resolves when the work settles in time", async () => {
    assert.equal(await withDeadline(Promise.resolve("done"), 1_000), "done");
  });

  test("rejects when the work does not settle", async () => {
    // The deadline must actually fire. `AbortSignal.timeout()` schedules an
    // *unref'd* timer, so when the deadline is the only pending work it never
    // fires and the promise stays unresolved — observed as a CI-only failure.
    await assert.rejects(
      () => withDeadline(new Promise(() => {}), 20),
      /timed out after 20ms/,
    );
  });

  test("propagates the work's own rejection", async () => {
    await assert.rejects(
      () => withDeadline(Promise.reject(new Error("upstream refused")), 1_000),
      /upstream refused/,
    );
  });

  test("does not leave a timer holding the event loop open", async () => {
    // If the timer were not cleared, this test file would hang after the last
    // assertion rather than exiting.
    await withDeadline(Promise.resolve("fast"), 60_000);
    assert.ok(true);
  });
});

describe("createReadinessProbe", () => {
  test("reports up when the dependency answers", async () => {
    const clock = createManualClock(T0);
    const probe = createReadinessProbe({
      name: "mcp-persistence",
      clock,
      check: async () => {},
    });

    const report = await probe();
    assert.equal(report.ready, true);
    assert.equal(report.dependencies[0].state, "up");
    assert.equal(report.cached, false);
  });

  test("reports down, with a reason, when the dependency throws", async () => {
    const clock = createManualClock(T0);
    const probe = createReadinessProbe({
      name: "mcp-persistence",
      clock,
      check: async () => {
        throw new Error("connection refused");
      },
    });

    const report = await probe();
    assert.equal(report.ready, false);
    assert.equal(report.dependencies[0].state, "down");
    assert.equal(report.dependencies[0].detail, "connection refused");
  });

  test("never throws, whatever the dependency does", async () => {
    // A probe that throws is a probe that returns 500, and a 500 is not a
    // readiness answer.
    const clock = createManualClock(T0);
    const probe = createReadinessProbe({
      name: "mcp-persistence",
      clock,
      check: async () => {
        throw "a string, not an Error";
      },
    });

    const report = await probe();
    assert.equal(report.ready, false);
    assert.equal(report.dependencies[0].detail, "unknown error");
  });

  test("times a dependency out rather than hanging", async () => {
    const clock = createManualClock(T0);
    const probe = createReadinessProbe({
      name: "mcp-persistence",
      clock,
      timeoutMs: 20,
      check: () => new Promise(() => {}),
    });

    const report = await probe();
    assert.equal(report.ready, false);
    assert.match(String(report.dependencies[0].detail), /timed out after 20ms/);
  });

  test("caches within the window and does not re-check", async () => {
    // A readiness endpoint is polled continuously; each probe must not become a
    // round trip, or being watched closely adds load in proportion to watching.
    const clock = createManualClock(T0);
    let checks = 0;
    const probe = createReadinessProbe({
      name: "mcp-persistence",
      clock,
      cacheMs: 2_000,
      check: async () => {
        checks++;
      },
    });

    await probe();
    clock.advance(1_999);
    const cached = await probe();

    assert.equal(checks, 1);
    assert.equal(cached.cached, true);
  });

  test("re-checks once the window expires", async () => {
    const clock = createManualClock(T0);
    let checks = 0;
    const probe = createReadinessProbe({
      name: "mcp-persistence",
      clock,
      cacheMs: 2_000,
      check: async () => {
        checks++;
      },
    });

    await probe();
    clock.advance(2_000);
    const fresh = await probe();

    assert.equal(checks, 2);
    assert.equal(fresh.cached, false);
  });

  test("a cached report reflects the state at check time, not at read time", async () => {
    const clock = createManualClock(T0);
    let healthy = true;
    const probe = createReadinessProbe({
      name: "mcp-persistence",
      clock,
      cacheMs: 2_000,
      check: async () => {
        if (!healthy) throw new Error("down");
      },
    });

    assert.equal((await probe()).ready, true);

    healthy = false;
    // Inside the cache window the old answer is served, which is the documented
    // trade-off: readiness is eventually consistent within `cacheMs`.
    assert.equal((await probe()).ready, true);

    clock.advance(2_000);
    assert.equal((await probe()).ready, false);
  });

  test("concurrent probes share one in-flight check", async () => {
    const clock = createManualClock(T0);
    let checks = 0;
    let release: (() => void) | undefined;

    const probe = createReadinessProbe({
      name: "mcp-persistence",
      clock,
      check: async () => {
        checks++;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });

    const first = probe();
    const second = probe();
    const third = probe();

    release?.();
    await Promise.all([first, second, third]);

    assert.equal(checks, 1, "a burst of probes multiplied the load");
  });

  test("records how long the check took", async () => {
    const clock = createManualClock(T0);
    const probe = createReadinessProbe({
      name: "mcp-persistence",
      clock,
      check: async () => {
        clock.advance(37);
      },
    });

    const report = await probe();
    assert.equal(report.dependencies[0].latencyMs, 37);
  });
});

describe("the /health and /ready routes", () => {
  test("/health is liveness: it never consults a dependency", async () => {
    // The route must answer 200 even when persistence is down, or a MongoDB
    // outage becomes a restart loop.
    const app = createApp(makeConfig(), { readinessProbe: fixedProbe(false) });

    const res = await app.request("/health", { headers: anonymousHeaders() });
    assert.equal(res.status, 200);

    const body = (await res.json()) as { status: string; service: string };
    assert.equal(body.status, "healthy");
    assert.equal(body.service, SERVICE_NAME);
  });

  test("/health advertises the documented features", async () => {
    const res = await healthRouter.request("/");
    const body = (await res.json()) as { features: Record<string, string> };
    assert.deepEqual(body.features, FEATURES);
  });

  test("/ready is 200 when the dependency is up", async () => {
    const app = createApp(makeConfig(), { readinessProbe: fixedProbe(true) });

    const res = await app.request("/ready", { headers: anonymousHeaders() });
    assert.equal(res.status, 200);

    const body = (await res.json()) as { status: string; ready: boolean };
    assert.equal(body.status, "ready");
    assert.equal(body.ready, true);
  });

  test("/ready is 503 when the dependency is down", async () => {
    // 503 rather than 500: the instance is healthy but cannot serve, which is what
    // a load balancer needs to stop routing here. 500 would mean a mishandled
    // request.
    const app = createApp(makeConfig(), { readinessProbe: fixedProbe(false) });

    const res = await app.request("/ready", { headers: anonymousHeaders() });
    assert.equal(res.status, 503);

    const body = (await res.json()) as {
      status: string;
      ready: boolean;
      dependencies: Array<{ name: string; state: string; detail?: string }>;
    };
    assert.equal(body.status, "not_ready");
    assert.equal(body.ready, false);
    assert.equal(body.dependencies[0].state, "down");
    assert.equal(body.dependencies[0].detail, "connection refused");
  });

  test("/ready is reachable without a credential", async () => {
    // A load balancer probing it does not hold the operator API key.
    const app = createApp(makeConfig(), { readinessProbe: fixedProbe(true) });
    const res = await app.request("/ready", { headers: anonymousHeaders() });
    assert.notEqual(res.status, 401);
  });

  test("/ready names the dependency it checked", async () => {
    const res = await createReadyRouter(fixedProbe(true)).request("/ready");
    const body = (await res.json()) as { dependencies: Array<{ name: string }> };
    assert.equal(body.dependencies[0].name, "mcp-persistence");
  });

  test("the readiness response exposes no configuration values", async () => {
    // It is unauthenticated, so it must carry nothing an anonymous caller should
    // not see: no endpoints, no keys, no database name.
    const app = createApp(makeConfig(), { readinessProbe: fixedProbe(false) });
    const raw = await (await app.request("/ready", { headers: anonymousHeaders() })).text();

    for (const secret of ["MONGODB", "mongodb://", "apiKey", "token", "OPENAI"]) {
      assert.ok(!raw.includes(secret), `the readiness body leaked '${secret}'`);
    }
  });
});

describe("the default readiness probe", () => {
  let stub: FetchStub;

  beforeEach(() => {
    resetAIProvider();
    stub = installFetchStub();
  });

  afterEach(() => {
    stub.restore();
    resetAIProvider();
  });

  test("reports ready when the persistence layer answers", async () => {
    stub.restore();
    stub = installFetchStub({
      mcpResponse: () => ({ connected: true, healthy: true }),
    });

    const app = createApp(makeConfig());
    const res = await app.request("/ready", { headers: anonymousHeaders() });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { dependencies: Array<{ state: string }> };
    assert.equal(body.dependencies[0].state, "up");
  });

  test("reports not ready when the persistence layer is unreachable", async () => {
    stub.restore();
    stub = installFetchStub({
      mcpResponse: () => {
        throw new Error("connection refused");
      },
    });

    const app = createApp(makeConfig());
    const res = await app.request("/ready", { headers: anonymousHeaders() });

    assert.equal(res.status, 503);
    const body = (await res.json()) as { dependencies: Array<{ state: string }> };
    assert.equal(body.dependencies[0].state, "down");
  });

  test("reports not ready when the adapter is up but MongoDB is not", async () => {
    // The adapter answering is not the same as the adapter being able to store
    // anything, which is the question readiness is asking.
    stub.restore();
    stub = installFetchStub({
      mcpResponse: () => ({ connected: false, healthy: false }),
    });

    const app = createApp(makeConfig());
    const res = await app.request("/ready", { headers: anonymousHeaders() });

    assert.equal(res.status, 503);
    const body = (await res.json()) as {
      dependencies: Array<{ detail?: string }>;
    };
    assert.match(String(body.dependencies[0].detail), /not connected to MongoDB/);
  });

  test("/health stays 200 while /ready is 503", async () => {
    // The pair that matters operationally: restart nothing, route nowhere.
    stub.restore();
    stub = installFetchStub({
      mcpResponse: () => {
        throw new Error("connection refused");
      },
    });

    const app = createApp(makeConfig());
    assert.equal((await app.request("/health", { headers: anonymousHeaders() })).status, 200);
    assert.equal((await app.request("/ready", { headers: anonymousHeaders() })).status, 503);
  });
});

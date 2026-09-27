/**
 * Cerberus read-path baseline, against a **real MongoDB**.
 *
 *   npm run bench:read-path                          full run
 *   npm run bench:read-path -- --quick               fewer iterations, for a smoke check
 *   npm run bench:read-path -- --json out.json       also write the raw results
 *
 * Requires `CERBERUS_BENCH_MONGODB_URI`. It **fails closed** when that is unset rather than
 * falling back to a stub — see the guard below.
 *
 * ── Why this script exists alongside `run-bench.mjs` ──────────────────
 *
 * `run-bench.mjs` drives the compiled API in process with the persistence adapter replaced by
 * an in-process double. That is the right instrument for "what does Cerberus's own code cost",
 * and it is why a regression can be attributed to this repository rather than to a container's
 * warm-up.
 *
 * It cannot answer the question this cycle is about. A "durable read" there is a function call
 * plus a JSON round trip, so the measured 3.49 ms live-detail p50 is the route's own work
 * *around* a read that costs nothing. The real question — is the durable read expensive? —
 * needs a real server on the other end of a real driver.
 *
 * ── What is real here, and what is not ────────────────────────────────
 *
 * REAL: the MongoDB server, the MongoDB driver, the connection pool, the queries, the
 * documents, the migrations and the indexes, the MCP **tool registry**
 * (`createToolRegistry`) and its argument validation, the compiled API routes and the whole
 * reconciliation path.
 *
 * NOT REAL: the HTTP server and its parsing (the app is driven through `app.request()`), TLS,
 * and the HTTP hop to the MCP adapter (the tool registry is called in process, through the
 * same `fetch` seam `run-bench.mjs` uses). So the MongoDB round trip is included and the two
 * HTTP hops are not. Every figure here is therefore a **floor** for a real deployment, exactly
 * as `run-bench.mjs`'s figures are a floor for this one.
 *
 * ── Query counting ────────────────────────────────────────────────────
 *
 * Every case reports `mcp/req`: how many calls the route made to the persistence layer per
 * request. That number, not the duration, is what a cache would change — so it is measured
 * rather than inferred, and it is the primary evidence for the KEEP/REVERT decision in
 * `docs/development/read-path-performance.md`.
 */

import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";

/**
 * The application logs per request — one `[guardian]` line and one `[mcp]` line per tool call.
 * At a few thousand requests that buries the results table.
 *
 * Silencing `console` is not enough: the logger writes to the stream directly, and the
 * store-unavailable cases legitimately log at `error`, which the default sink sends to
 * `stderr`. So the logger's sink is replaced with one that **counts** rather than prints —
 * counting is strictly better than discarding, because the per-case level tally is evidence
 * that a case produced the failure it claims to produce.
 *
 * `console.error` is left alone: a genuine harness error should surface.
 */
const emit = console.log.bind(console);

const logLevelCounts = new Map();

// ═══════════════════════════════════════════════════════════════════
// Guard — fail closed, before anything is measured
// ═══════════════════════════════════════════════════════════════════

const MONGODB_URI = (process.env["CERBERUS_BENCH_MONGODB_URI"] ?? "").trim();

if (!MONGODB_URI) {
  emit("");
  emit("  CERBERUS_BENCH_MONGODB_URI is not set, so there is no real MongoDB to measure.");
  emit("");
  emit("  This benchmark does NOT fall back to a stub. A read-path figure produced against an");
  emit("  in-process double is not a read-path figure — that is the whole reason this script");
  emit("  exists next to run-bench.mjs, and a silent fallback would make the number it printed");
  emit("  indistinguishable from a real one. `npm run bench` is the stubbed benchmark.");
  emit("");
  emit("  Start one and set the variable, for example:");
  emit("");
  emit("    docker run --rm -d -p 27170:27017 --name cerberus-bench-mongo mongo:7");
  emit("    $env:CERBERUS_BENCH_MONGODB_URI = 'mongodb://127.0.0.1:27170'");
  emit("    npm run bench:read-path");
  emit("");
  process.exit(1);
}

console.log = () => {};
console.warn = () => {};

const QUICK = process.argv.includes("--quick");
const jsonIndex = process.argv.indexOf("--json");
const jsonPath = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : null;

/** How many sessions the list case has to reconcile. */
const SESSION_COUNT = positiveInt(process.env["CERBERUS_BENCH_SESSIONS"], 20);
/** How many events each of those sessions holds. */
const EVENTS_PER_SESSION = positiveInt(process.env["CERBERUS_BENCH_EVENTS"], 200);
/** Samples per case. */
const BASE_SAMPLES = positiveInt(process.env["CERBERUS_BENCH_SAMPLES"], 300);

function positiveInt(raw, fallback) {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function iterations(base) {
  return QUICK ? Math.max(20, Math.round(base / 10)) : base;
}

// Resolved against this file, not the working directory, so the benchmark can be run from
// anywhere. Both are the **compiled** output, so the numbers describe what ships.
const apiEntry = new URL("../../apps/api/dist/index.js", import.meta.url);
const storeEntry = new URL("../../packages/mcp-mongodb/dist/mongo-client.js", import.meta.url);
const toolsEntry = new URL("../../packages/mcp-mongodb/dist/tools.js", import.meta.url);

const { createApp } = await import(apiEntry.href);
const { MongoStore } = await import(storeEntry.href);
const { createToolRegistry, ToolArgumentError, ReferenceCorpusLimitToolError } = await import(
  toolsEntry.href
);
const loggerEntry = new URL("../../apps/api/dist/observability/logger.js", import.meta.url);
const { configureLogging } = await import(loggerEntry.href);
const { BENCH_API_KEY: API_KEY, benchConfig } = await import("./bench-config.mjs");
const { MongoClient } = await import("mongodb");

// Installed **before** any app is built, and `createApp` leaves the sink alone — it sets only
// the level and the format. See `apps/api/src/observability/logger.ts`.
configureLogging({
  sink: (_line, record) => {
    logLevelCounts.set(record.level, (logLevelCounts.get(record.level) ?? 0) + 1);
  },
});

const HEADERS = { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` };

// ═══════════════════════════════════════════════════════════════════
// Harness
// ═══════════════════════════════════════════════════════════════════

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

/**
 * Runs `work` `count` times and returns latency statistics in milliseconds.
 *
 * Warms up first: the first iterations pay for JIT compilation and inline caches, and
 * including them measures the runtime rather than the code. The warmup is also what lets the
 * driver's connection pool reach steady state, which matters more here than in the stubbed
 * benchmark — a cold pool would show up as a tail that never recurs in a running deployment.
 *
 * `work` returns `{ calls, status }`: the number of persistence calls the request made, and
 * the HTTP status it answered with. Both are aggregated, because a latency figure for a case
 * that silently started answering `503` would be worse than no figure.
 */
async function measure(label, count, work) {
  const warmup = Math.max(5, Math.round(count / 10));
  for (let i = 0; i < warmup; i++) await work(i);

  const samples = new Float64Array(count);
  let calls = 0;
  const statuses = new Map();

  const startedAt = performance.now();
  for (let i = 0; i < count; i++) {
    const before = performance.now();
    const outcome = (await work(i)) ?? {};
    samples[i] = performance.now() - before;
    calls += outcome.calls ?? 0;
    statuses.set(outcome.status, (statuses.get(outcome.status) ?? 0) + 1);
  }
  const totalMs = performance.now() - startedAt;

  const sorted = Array.from(samples).sort((a, b) => a - b);

  return {
    label,
    iterations: count,
    warmup,
    totalMs,
    throughputPerSecond: (count / totalMs) * 1000,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1],
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    persistenceCalls: calls,
    persistenceCallsPerRequest: count > 0 ? calls / count : 0,
    statuses: Object.fromEntries(
      [...statuses.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ),
  };
}

/**
 * Measures throughput with `concurrency` requests genuinely in flight.
 *
 * The sequential cases above answer "what does one request cost". This answers the different
 * question the cache decision actually turns on: **how many of these requests per second can
 * one process serve?** A read that is cheap per request but saturates a shared resource at
 * eight concurrent callers is a read worth caching; one that scales flat is not.
 *
 * A fixed pool of workers pulls from a shared index, so the load is steady rather than bursty.
 *
 * ── Why the persistence count is taken around the batch, not per request ──
 *
 * `mcpCallCount` is one global counter, and `hit()` attributes a request's calls by differencing
 * it. That is correct while requests are sequential and **wrong** the moment two overlap: each
 * request's delta then includes whatever its neighbours did in the same window, and the sum is
 * inflated by roughly the concurrency factor. An earlier revision of this function did exactly
 * that and reported 32 calls per request at concurrency 32 for a route that makes one. The
 * counter is therefore read once around the whole batch, which is exact at any concurrency: the
 * batch issued `total` requests, so `delta / total` is the true per-request figure.
 */
async function measureConcurrent(label, total, concurrency, work) {
  const samples = new Float64Array(total);
  let next = 0;

  const callsBefore = mcpCallCount;
  const startedAt = performance.now();
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= total) return;
      const before = performance.now();
      await work(index);
      samples[index] = performance.now() - before;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const totalMs = performance.now() - startedAt;
  const calls = mcpCallCount - callsBefore;

  const sorted = Array.from(samples).sort((a, b) => a - b);

  return {
    label,
    concurrency,
    iterations: total,
    totalMs,
    throughputPerSecond: (total / totalMs) * 1000,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    persistenceCalls: calls,
    persistenceCallsPerRequest: total > 0 ? calls / total : 0,
  };
}

// ═══════════════════════════════════════════════════════════════════
// The real persistence layer, behind the same fetch seam the API uses
// ═══════════════════════════════════════════════════════════════════

let mcpCallCount = 0;

/**
 * Wraps a real, connected `MongoStore` in a `fetch` responder.
 *
 * This mirrors `apps/api/test/support/real-store-responder.ts`, including its error mapping:
 * a route that handles the real HTTP adapter's 404/400/409/500 must see the same statuses
 * here, or the benchmark would be measuring a route's behaviour against a seam the adapter
 * does not have. It is duplicated rather than imported because that file is TypeScript in a
 * test tree, and this is a plain `.mjs` script.
 */
function installRealStoreStub(store) {
  const original = globalThis.fetch;
  const registry = createToolRegistry(store);
  const seenTools = new Map();

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (url.includes("/chat/completions")) {
      // The AI provider is the one thing that stays stubbed: this benchmark never spends
      // money, and no read-path case depends on a model's latency. The score is below
      // AUTO_LOCK_THRESHOLD, so no auto-lock and no notification run.
      return Response.json({
        id: "chatcmpl-bench",
        object: "chat.completion",
        created: 0,
        model: "bench",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                riskAssessmentId: "11111111-1111-4111-8111-111111111111",
                overallRiskScore: 40,
                dimensionScores: { dataExfiltration: 40, policyViolation: 20 },
                flags: [],
                exfiltrationReport: null,
                behavioralAnomalies: [],
                generatedAt: new Date().toISOString(),
              }),
            },
            finish_reason: "stop",
          },
        ],
      });
    }

    const marker = "/tools/";
    const at = url.indexOf(marker);
    if (at < 0) {
      // A request this harness does not model must fail loudly rather than be answered with a
      // plausible success: a silently swallowed call is a case that measured nothing.
      throw new Error(`bench harness received an unexpected request: ${url}`);
    }

    const tool = url.slice(at + marker.length);
    mcpCallCount += 1;
    seenTools.set(tool, (seenTools.get(tool) ?? 0) + 1);

    const handler = registry[tool];
    if (!handler) {
      // The real adapter answers 404 rather than falling through to a plausible success.
      return Response.json({ success: false, error: `Unknown tool: ${tool}` }, { status: 404 });
    }

    try {
      const result = await handler(body);
      return Response.json({ ...result, correlationId: randomUUID() });
    } catch (error) {
      const isArgumentError = error instanceof ToolArgumentError;
      const isLimitError = error instanceof ReferenceCorpusLimitToolError;
      return Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Internal MCP tool error",
          ...(isLimitError ? { code: error.code, limit: error.limit, count: error.count } : {}),
        },
        { status: isArgumentError ? 400 : isLimitError ? 409 : 500 },
      );
    }
  };

  return {
    seenTools,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════

/**
 * A keystroke with a human-plausible interval.
 *
 * `deltaMs` above `MIN_HUMAN_KEYSTROKE_MS` so `hasAnomalousKeystrokes` stays false, and a
 * varying value so each event's fingerprint differs and every event is genuinely new. A
 * KEYSTROKE never sets the workspace, so `shouldAnalyze` is false and no analysis runs — this
 * benchmark measures reads, not the paid path.
 */
function keystroke(sessionId, eventId, deltaMs) {
  return {
    eventId,
    sessionId,
    employeeId: "op-bench",
    auditId: "audit-bench",
    vectorId: "tv-1",
    eventType: "KEYSTROKE",
    timestamp: new Date().toISOString(),
    payload: { deltaMs },
    clientMetadata: {
      userAgent: "read-path-bench",
      ipAddress: "127.0.0.1",
      screenResolution: "1920x1080",
      platform: "web",
      language: "en-US",
    },
  };
}

function sessionIdFor(index) {
  return `bench-read-${index}`;
}

// ═══════════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════════

const databaseName = `cerberus_bench_read_${randomUUID().replace(/-/g, "")}`;
const store = new MongoStore({ uri: MONGODB_URI, databaseName });

emit("");
emit("Cerberus read-path baseline — real MongoDB");
emit("─".repeat(104));

let results = [];
const concurrencyResults = [];
const run = async (row) => {
  results.push(row);
  report(row);
};

function report(row) {
  const pad = (value, width) => String(value).padEnd(width);
  const num = (value, width) => String(value).padStart(width);
  const statuses = Object.entries(row.statuses ?? {})
    .map(([status, count]) => `${status}×${count}`)
    .join(" ");
  emit(
    `  ${pad(row.label, 44)} ${num(row.iterations, 6)} ${num(row.throughputPerSecond.toFixed(0), 8)} ` +
      `${num(row.p50Ms.toFixed(2), 8)} ${num(row.p95Ms.toFixed(2), 8)} ${num(row.p99Ms.toFixed(2), 8)} ` +
      `${num(row.persistenceCallsPerRequest.toFixed(2), 8)}  ${statuses}`,
  );
}

/** One request through the compiled app, reporting its persistence calls and status. */
async function hit(app, path, options = {}) {
  const before = mcpCallCount;
  const response = await app.request(path, { headers: HEADERS, ...options });
  // The body is always consumed, so a case cannot measure a route that answered a body
  // nobody read: response building is part of what is being timed.
  await response.text();
  return { calls: mcpCallCount - before, status: response.status };
}

let storeConnected = false;
let stub = null;

try {
  await store.connect();
  storeConnected = true;

  // ── Environment ──────────────────────────────────────────────────
  const client = new MongoClient(MONGODB_URI);
  let buildInfo = {};
  try {
    await client.connect();
    buildInfo = await client.db("admin").command({ buildInfo: 1 });
  } finally {
    await client.close();
  }

  const cpuList = cpus();
  const commitSha = (() => {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  })();

  const environment = {
    os: `${platform()} ${release()} ${arch()}`,
    cpu: cpuList[0]?.model ?? "unknown",
    cpuCount: cpuList.length,
    totalMemoryBytes: totalmem(),
    node: process.version,
    mongodb: buildInfo.version ?? "unknown",
    mongodbTopology: topologyOf(MONGODB_URI),
    mongodbLocation: locationOf(MONGODB_URI),
    dataset: {
      sessions: SESSION_COUNT,
      eventsPerSession: EVENTS_PER_SESSION,
      eventDocuments: SESSION_COUNT * EVENTS_PER_SESSION,
    },
    commitSha,
    // Stated as a pair of facts rather than one word, because "end to end" would be false and
    // "unit" would be too.
    includesHttpServerStack: false,
    includesMcpHttpHop: false,
    includesMongodbRoundTrip: true,
    includesModelLatency: false,
    quick: QUICK,
    ranAt: new Date().toISOString(),
  };

  emit(
    `  ${environment.node}   ${environment.os}   ${environment.cpuCount} cpu   ` +
      `${environment.cpu}`,
  );
  emit(
    `  mongodb ${environment.mongodb}   ${environment.mongodbTopology}   ` +
      `${environment.mongodbLocation}   commit ${commitSha.slice(0, 12)}`,
  );
  emit(
    `  dataset ${SESSION_COUNT} sessions × ${EVENTS_PER_SESSION} events ` +
      `(${SESSION_COUNT * EVENTS_PER_SESSION} event documents)   ${QUICK ? "quick" : "full"} run`,
  );
  emit("─".repeat(104));
  emit(
    `  ${"case".padEnd(44)} ${"n".padStart(6)} ${"req/s".padStart(8)} ` +
      `${"p50 ms".padStart(8)} ${"p95 ms".padStart(8)} ${"p99 ms".padStart(8)} ` +
      `${"mcp/req".padStart(8)}  statuses`,
  );

  stub = installRealStoreStub(store);

  // ── Seed the dataset ─────────────────────────────────────────────
  //
  // Through the real route, so the documents are written by the real code path and the
  // process under measurement holds the sessions it would hold in a running deployment.
  const warmApp = createApp(benchConfig());

  for (let index = 0; index < SESSION_COUNT; index++) {
    const sessionId = sessionIdFor(index);
    const events = Array.from({ length: EVENTS_PER_SESSION }, (_unused, offset) =>
      keystroke(sessionId, `seed-${index}-${offset}`, 120 + (offset % 400)),
    );
    const response = await warmApp.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ events }),
    });
    if (response.status !== 200) {
      throw new Error(
        `seeding ${sessionId} failed (${response.status}): ${await response.text()}`,
      );
    }
  }

  const primarySessionId = sessionIdFor(0);

  // ── Cases ────────────────────────────────────────────────────────

  await run(
    await measure(
      "live detail — this process holds the session",
      iterations(BASE_SAMPLES),
      () => hit(warmApp, `/api/v1/guardian/sessions/${primarySessionId}`),
    ),
  );

  // A fresh process with the same documents: the restart case. Nothing is lazily loaded, so
  // the first request is the case rather than a warm-up for it — the warmup inside `measure`
  // therefore also measures a cold process, which is the honest shape.
  const restartedApp = createApp(benchConfig());
  await run(
    await measure(
      "live detail — after restart (memory empty)",
      iterations(BASE_SAMPLES),
      () => hit(restartedApp, `/api/v1/guardian/sessions/${primarySessionId}`),
    ),
  );

  await run(
    await measure(
      `live list — ${SESSION_COUNT} sessions`,
      iterations(QUICK ? 40 : 150),
      () => hit(warmApp, "/api/v1/guardian/sessions"),
    ),
  );

  await run(
    await measure(
      "review detail — durable evidence",
      iterations(QUICK ? 40 : 150),
      () => hit(warmApp, `/api/v1/sessions/${primarySessionId}`),
    ),
  );

  await run(
    await measure(
      "live detail — missing session (404)",
      iterations(BASE_SAMPLES),
      () => hit(warmApp, "/api/v1/guardian/sessions/bench-read-does-not-exist"),
    ),
  );

  // ── The terminated case ──────────────────────────────────────────
  //
  // A separate session, terminated once, then read repeatedly. The read must report
  // `terminated` from durable truth, not from a cache that still holds `active`.
  const terminatedSessionId = sessionIdFor(SESSION_COUNT - 1);
  const terminateResponse = await warmApp.request(
    `/api/v1/guardian/sessions/${terminatedSessionId}/terminate`,
    { method: "POST", headers: HEADERS },
  );
  if (terminateResponse.status !== 200) {
    throw new Error(
      `terminating ${terminatedSessionId} failed (${terminateResponse.status}): ` +
        `${await terminateResponse.text()}`,
    );
  }

  await run(
    await measure(
      "live detail — terminated session",
      iterations(BASE_SAMPLES),
      () => hit(warmApp, `/api/v1/guardian/sessions/${terminatedSessionId}`),
    ),
  );

  // ── Concurrency ──────────────────────────────────────────────────
  emit("");
  emit("  concurrency — how many of these one process serves");
  emit(
    `    ${"case".padEnd(30)} ${"c".padStart(3)} ${"n".padStart(6)} ${"req/s".padStart(9)} ` +
      `${"p50 ms".padStart(8)} ${"p95 ms".padStart(8)} ${"p99 ms".padStart(8)} ${"mcp/req".padStart(8)}`,
  );

  for (const concurrency of QUICK ? [1, 8] : [1, 8, 32]) {
    const total = QUICK ? 60 : 400;
    const row = await measureConcurrent(
      "live detail",
      total,
      concurrency,
      () => hit(warmApp, `/api/v1/guardian/sessions/${primarySessionId}`),
    );
    concurrencyResults.push(row);
    emit(
      `    ${"live detail".padEnd(30)} ${String(concurrency).padStart(3)} ` +
        `${String(total).padStart(6)} ${row.throughputPerSecond.toFixed(0).padStart(9)} ` +
        `${row.p50Ms.toFixed(2).padStart(8)} ${row.p95Ms.toFixed(2).padStart(8)} ` +
        `${row.p99Ms.toFixed(2).padStart(8)} ${row.persistenceCallsPerRequest.toFixed(2).padStart(8)}`,
    );
  }

  for (const concurrency of QUICK ? [1, 8] : [1, 8, 32]) {
    const total = QUICK ? 60 : 400;
    const row = await measureConcurrent(
      "live list",
      total,
      concurrency,
      () => hit(warmApp, "/api/v1/guardian/sessions"),
    );
    concurrencyResults.push(row);
    emit(
      `    ${"live list".padEnd(30)} ${String(concurrency).padStart(3)} ` +
        `${String(total).padStart(6)} ${row.throughputPerSecond.toFixed(0).padStart(9)} ` +
        `${row.p50Ms.toFixed(2).padStart(8)} ${row.p95Ms.toFixed(2).padStart(8)} ` +
        `${row.p99Ms.toFixed(2).padStart(8)} ${row.persistenceCallsPerRequest.toFixed(2).padStart(8)}`,
    );
  }

  // ── Scaling: does a read cost depend on how much history the store holds? ──
  //
  // The cases above run against 20 sessions, which is not enough to see a query that is
  // unbounded in the number of **historical** sessions. `MongoStore.listSessions` issues
  // `find({})` — every session document ever created, including the terminated and expired
  // ones the reconciler then drops — while `getSession` is a lookup on the unique
  // `sessionId` index. So one of these two is expected to be flat and the other is not, and
  // the difference is the whole read-path scaling question.
  //
  // The extra sessions are written **directly through the store**, not through the ingest
  // route: they are history this process never held, which is exactly the durable-only case
  // the list's batched query exists to cover. 80 % are terminated, because a real deployment
  // accumulates far more finished sessions than live ones and those are the documents the
  // query pays for and the response discards.
  emit("");
  emit("  scaling — read cost against the size of the durable store");
  emit(
    `    ${"case".padEnd(30)} ${"sessions".padStart(9)} ${"live".padStart(6)} ${"n".padStart(5)} ` +
      `${"req/s".padStart(8)} ${"p50 ms".padStart(8)} ${"p95 ms".padStart(8)} ${"p99 ms".padStart(8)}`,
  );

  const scalingRows = [];
  let historical = 0;
  let previousTotal = SESSION_COUNT;
  const totalStages = QUICK ? [0, 500] : [0, 500, 5000];

  for (const target of totalStages) {
    const startedSeeding = performance.now();
    while (historical < target) {
      const index = historical;
      const now = new Date().toISOString();
      await store.createSession({
        sessionId: `bench-hist-${index}`,
        employeeId: `op-hist-${index % 50}`,
        auditId: "audit-bench",
        matrixId: "audit-bench",
        targetSystem: "bench",
        status: index % 5 === 0 ? "active" : "terminated",
        eventCount: index % 97,
        pasteCount: 0,
        tabSwitchCount: 0,
        focusLossCount: 0,
        copyAttemptCount: 0,
        peakRiskScore: index % 101,
        deployedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      historical += 1;
    }
    const seedingMs = performance.now() - startedSeeding;

    const storedSessions = SESSION_COUNT + historical;
    const listRow = await measure(
      "live list",
      QUICK ? 20 : 60,
      () => hit(warmApp, "/api/v1/guardian/sessions"),
    );
    const detailRow = await measure(
      "live detail",
      QUICK ? 20 : 60,
      () => hit(warmApp, `/api/v1/guardian/sessions/${primarySessionId}`),
    );

    scalingRows.push({
      storedSessions,
      seededInThisStage: storedSessions - previousTotal,
      seedingMs,
      // The sessions the reconciler considers live: the 20 ingested ones plus the one in
      // five seeded as `active`. The rest are read and dropped, which is the cost being
      // measured.
      expectedLiveRows: SESSION_COUNT + Math.ceil(historical / 5),
      liveList: listRow,
      liveDetail: detailRow,
    });
    previousTotal = storedSessions;

    for (const row of [listRow, detailRow]) {
      emit(
        `    ${row.label.padEnd(30)} ${String(storedSessions).padStart(9)} ` +
          `${String(SESSION_COUNT + Math.ceil(historical / 5)).padStart(6)} ` +
          `${String(row.iterations).padStart(5)} ${row.throughputPerSecond.toFixed(0).padStart(8)} ` +
          `${row.p50Ms.toFixed(2).padStart(8)} ${row.p95Ms.toFixed(2).padStart(8)} ` +
          `${row.p99Ms.toFixed(2).padStart(8)}`,
      );
    }
  }

  // ── Store unavailable ────────────────────────────────────────────
  //
  // The store is genuinely disconnected, so the failure travels the real driver and the real
  // tool registry rather than being simulated by a stub that throws. `MongoStore.dbOrThrow`
  // is what raises it, and the responder maps it to a `500` exactly as the adapter does.
  emit("");
  emit("  store unavailable — the real driver, disconnected mid-run");
  emit(
    `    ${"case".padEnd(44)} ${"n".padStart(6)} ${"p50 ms".padStart(8)} ` +
      `${"p95 ms".padStart(8)} ${"p99 ms".padStart(8)} ${"mcp/req".padStart(8)}  statuses`,
  );

  await store.disconnect();
  storeConnected = false;

  const unavailableRows = [];

  const heldRow = await measure(
    "store down — this process holds the session",
    iterations(QUICK ? 20 : 100),
    () => hit(warmApp, `/api/v1/guardian/sessions/${primarySessionId}`),
  );
  unavailableRows.push(heldRow);

  const unheldRow = await measure(
    "store down — nothing holds the session (503)",
    iterations(QUICK ? 20 : 100),
    () => hit(restartedApp, "/api/v1/guardian/sessions/bench-read-unknown"),
  );
  unavailableRows.push(unheldRow);

  const listRow = await measure(
    "store down — live list (unreconciled)",
    iterations(QUICK ? 20 : 100),
    () => hit(warmApp, "/api/v1/guardian/sessions"),
  );
  unavailableRows.push(listRow);

  for (const row of unavailableRows) {
    const statuses = Object.entries(row.statuses ?? {})
      .map(([status, count]) => `${status}×${count}`)
      .join(" ");
    emit(
      `    ${row.label.padEnd(44)} ${String(row.iterations).padStart(6)} ` +
        `${row.p50Ms.toFixed(2).padStart(8)} ${row.p95Ms.toFixed(2).padStart(8)} ` +
        `${row.p99Ms.toFixed(2).padStart(8)} ${row.persistenceCallsPerRequest.toFixed(2).padStart(8)}  ${statuses}`,
    );
  }

  await store.connect();
  storeConnected = true;

  // ── Summary ──────────────────────────────────────────────────────
  emit("");
  emit("─".repeat(104));
  emit(
    `  persistence calls per request: ` +
      results
        .filter((row) => row.persistenceCallsPerRequest > 0)
        .map((row) => `${row.label.split(" ")[0]} ${row.persistenceCallsPerRequest.toFixed(2)}`)
        .join(", "),
  );
  emit(
    `  tools exercised: ${[...stub.seenTools.keys()].sort().join(", ")}`,
  );
  emit(
    `  application log lines: ` +
      ([...logLevelCounts.entries()].sort().map(([level, count]) => `${level} ${count}`).join(", ") ||
        "none") +
      " (sink replaced; counted, not printed)",
  );
  emit("─".repeat(104));

  if (jsonPath) {
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          environment,
          results,
          concurrency: concurrencyResults,
          scaling: scalingRows,
          unavailable: unavailableRows,
          toolsExercised: Object.fromEntries(
            [...stub.seenTools.entries()].sort((a, b) => a[0].localeCompare(b[0])),
          ),
          logLevelCounts: Object.fromEntries(
            [...logLevelCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
          ),
        },
        null,
        2,
      ),
    );
    emit(`  raw results written to ${jsonPath}`);
  }
} finally {
  stub?.restore();
  if (!storeConnected) {
    try {
      await store.connect();
      storeConnected = true;
    } catch {
      // Nothing further can be done; the cleanup below is best-effort by design.
    }
  }
  try {
    await store.disconnect();
  } catch {
    // Best-effort.
  }

  const cleanup = new MongoClient(MONGODB_URI);
  try {
    await cleanup.connect();
    await cleanup.db(databaseName).dropDatabase();
  } catch {
    // Best-effort: a disposable database that could not be dropped is not a benchmark failure,
    // and throwing here would mask the result that was just produced.
  } finally {
    await cleanup.close().catch(() => {});
  }
}

/** A one-line description of the MongoDB topology, read from the URI. */
function topologyOf(uri) {
  if (/replicaSet=/i.test(uri)) return "replica-set";
  if (/mongodb\+srv:/i.test(uri)) return "srv (Atlas-style)";
  return "standalone (single mongod)";
}

/** Where the server is, which is the part of a latency figure that does not transfer. */
function locationOf(uri) {
  const host = /@?([^/@:]+)(?::\d+)?(?:\/|$)/.exec(uri.replace(/^mongodb(\+srv)?:\/\//, ""))?.[1];
  if (!host) return "unknown";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "loopback";
  if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return `private network (${host})`;
  return `remote (${host})`;
}

/**
 * Cerberus local performance baseline.
 *
 *   npm run bench                     full run
 *   npm run bench -- --quick          fewer iterations, for a smoke check
 *   npm run bench -- --json out.json  also write the raw results
 *
 * ── What this measures, and what it does not ──────────────────────────
 *
 * It drives the **compiled API in process**, via `app.request()`, with the
 * persistence layer and the AI provider replaced by in-process stubs. So the
 * numbers are Cerberus's own cost — routing, validation, dedup, session state,
 * response building — and nothing else.
 *
 * That is deliberate: it makes the baseline reproducible on any machine with no
 * MongoDB, no network and no paid inference, so a regression is attributable to
 * this code rather than to a container's warm-up or a provider's mood.
 *
 * What it therefore does NOT measure: TCP and TLS, HTTP parsing in a real server,
 * MongoDB round trips, or model latency. A number here is a floor, not an
 * end-to-end latency. `scripts/stress-telemetry.ps1` exercises a running instance
 * over HTTP and is the tool for that question.
 *
 * ── Why percentiles and not just a mean ───────────────────────────────
 *
 * Latency distributions for request handling are right-skewed: a mean hides the
 * tail, and the tail is what an operator experiences. Every latency figure here is
 * reported as p50 / p95 / p99 with the sample count.
 */

import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { cpus } from "node:os";

const QUICK = process.argv.includes("--quick");
const jsonIndex = process.argv.indexOf("--json");
const jsonPath = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : null;

/**
 * The API logs per request — `[guardian] ... POST /ingest` and one `[mcp]` line per
 * tool call. At a few thousand requests that buries the results table, so the
 * application's logging is silenced for the duration while the benchmark's own
 * output goes through the captured original.
 *
 * `console.error` is deliberately left alone: a genuine error should still surface
 * rather than be swallowed by the harness.
 */
const emit = console.log.bind(console);
console.log = () => {};
console.warn = () => {};

// Resolved against this file, not the working directory, so the benchmark can be
// run from anywhere.
const apiEntry = new URL("../../apps/api/dist/index.js", import.meta.url);
const { createApp } = await import(apiEntry.href);

// ═══════════════════════════════════════════════════════════════════
// Harness
// ═══════════════════════════════════════════════════════════════════

/** Samples collected per case. */
function iterations(base) {
  return QUICK ? Math.max(20, Math.round(base / 10)) : base;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

/**
 * Runs `work` `count` times and returns latency statistics in milliseconds.
 *
 * Warms up first: the first iterations pay for JIT compilation and inline caches,
 * and including them measures the runtime rather than the code.
 */
async function measure(label, count, work) {
  const warmup = Math.max(5, Math.round(count / 10));
  for (let i = 0; i < warmup; i++) await work(i);

  const samples = new Float64Array(count);
  const startedAt = performance.now();

  for (let i = 0; i < count; i++) {
    const before = performance.now();
    await work(i);
    samples[i] = performance.now() - before;
  }

  const totalMs = performance.now() - startedAt;
  const sorted = Array.from(samples).sort((a, b) => a - b);

  return {
    label,
    iterations: count,
    totalMs,
    throughputPerSecond: (count / totalMs) * 1000,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1],
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

function report(row) {
  const pad = (value, width) => String(value).padEnd(width);
  const num = (value, width) => String(value).padStart(width);
  emit(
    `  ${pad(row.label, 38)} ${num(row.iterations, 7)} ${num(row.throughputPerSecond.toFixed(0), 10)} ` +
      `${num(row.p50Ms.toFixed(2), 8)} ${num(row.p95Ms.toFixed(2), 8)} ${num(row.p99Ms.toFixed(2), 8)} ${num(row.maxMs.toFixed(2), 9)}`,
  );
}

// ═══════════════════════════════════════════════════════════════════
// Stubs — no network, no MongoDB, no paid inference
// ═══════════════════════════════════════════════════════════════════

const API_KEY = "bench-key";

/** A stateful MCP stand-in, matching the real store's observable contract. */
function installMcpStub() {
  const sessions = new Map();
  const events = new Map();
  const storedEventKeys = new Set();
  const original = globalThis.fetch;

  const riskPayload = (score) => ({
    riskAssessmentId: "11111111-1111-4111-8111-111111111111",
    overallRiskScore: score,
    dimensionScores: { dataExfiltration: score },
    flags: [],
    exfiltrationReport: null,
    behavioralAnomalies: [],
    generatedAt: new Date().toISOString(),
  });

  globalThis.fetch = async (url, init) => {
    const target = typeof url === "string" ? url : url.url;

    // The AI provider.
    if (target.includes("/chat/completions")) {
      return new Response(
        JSON.stringify({
          id: "cmpl-bench",
          object: "chat.completion",
          created: 0,
          model: "bench",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: JSON.stringify(riskPayload(40)) },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // The MCP adapter.
    const tool = target.split("/tools/")[1];
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    switch (tool) {
      case "create_session": {
        const id = String(body.sessionId);
        if (!sessions.has(id)) sessions.set(id, { ...body, createdAt: new Date().toISOString() });
        return Response.json({ success: true, mongoDocumentId: `doc-${id}` });
      }
      case "get_session_review": {
        const id = String(body.sessionId);
        // The real store caps this at 500 (`MongoStore.getSessionEvents`,
        // `limit ?? 500`). Returning the whole array here made the *stub* the
        // bottleneck: it re-serialised a growing array on every ingest, which showed
        // up as ingest cost growing with session size and was mistaken for an API
        // defect. A double that does not match the real store's bounds measures the
        // double.
        const all = events.get(id) ?? [];
        return Response.json({
          success: true,
          session: sessions.get(id) ?? null,
          events: all.slice(-500),
          riskAssessments: [],
        });
      }
      case "ingest_micro_events": {
        const batch = body.events ?? [];
        const acceptedEventIds = [];
        const duplicateEventIds = [];
        for (const event of batch) {
          const key = `${event.sessionId}::${event.eventId}`;
          if (storedEventKeys.has(key)) {
            duplicateEventIds.push(event.eventId);
            continue;
          }
          storedEventKeys.add(key);
          acceptedEventIds.push(event.eventId);
          const list = events.get(event.sessionId) ?? [];
          list.push(event);
          events.set(event.sessionId, list);
        }
        return Response.json({
          success: true,
          processedCount: batch.length,
          acceptedEventIds,
          duplicateEventIds,
        });
      }
      case "update_session_counts": {
        const id = String(body.sessionId);
        sessions.set(id, { ...(sessions.get(id) ?? {}), ...(body.counts ?? {}) });
        return Response.json({ success: true });
      }
      case "store_risk_assessment":
        return Response.json({ success: true, mongoDocumentId: "risk-doc" });
      case "set_session_status":
        return Response.json({ success: true, updated: true });
      case "list_sessions":
        return Response.json({ success: true, data: [...sessions.values()] });
      case "list_reference_documents":
        return Response.json({ success: true, data: [] });
      case "health_check":
        return Response.json({ connected: true, healthy: true });
      default:
        return Response.json({ success: true });
    }
  };

  return { restore: () => { globalThis.fetch = original; } };
}

function benchConfig() {
  return {
    port: 0,
    devMode: false,
    openai: { apiKey: "bench", model: "bench", maxOutputTokens: 1024, requestTimeoutMs: 5000 },
    mcp: { serverEndpoint: "http://127.0.0.1:1", apiKey: "bench", timeoutMs: 5000 },
    auth: { apiKey: API_KEY, headerNames: ["authorization", "x-api-key"] },
    cors: { allowedOrigins: [] },
    security: {
      sessionTTLSeconds: 7200,
      maxRequestBodyBytes: 8 * 1024 * 1024,
      maxPasteEventsPerSession: 5,
      minHumanKeystrokeMs: 80,
      dataLeakageSimilarityThreshold: 0.75,
    },
    // Off, so this measures the application rather than the limiter. The limiter
    // has its own tests; a throughput figure with it on would measure bucket
    // arithmetic.
    rateLimit: { enabled: false, aiRequestsPerMinute: 10 },
    // ── The two fields below are why this benchmark was broken ──────────
    //
    // `createApp` reads `config.log.level` unconditionally, so a config literal without a
    // `log` object threw `Cannot read properties of undefined` before a single case ran.
    // That was true from `v0.4.0` onward — the operability cycle added structured logging to
    // `AppConfig` and this literal was not updated — so `npm run bench`, the command the
    // performance baseline documents as reproducible, crashed on every revision it named.
    //
    // `error` rather than `info`, because the intent stated at the top of this file is to
    // silence the application's per-request logging for the duration: one `http.request` line
    // per sample buries the results table. `console.log` being silenced does not stop the
    // logger, which writes to the stream directly — so the level is the control.
    //
    // `apps/api/test/bench-config.test.ts` now asserts this literal covers every key
    // `makeConfig()` produces, so the next field added to `AppConfig` fails a test instead of
    // silently breaking the benchmark.
    log: { level: "error", format: "json" },
    // Read by the paid routes' idempotency handling. Present so this literal matches the
    // config shape the application expects; a `v0.4.0` build ignores it.
    idempotency: { ttlSeconds: 86_400 },
  };
}

const HEADERS = { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` };

function microEvent(sessionId, eventId, eventType, payload, deltaMs) {
  return {
    eventId,
    sessionId,
    employeeId: "op-bench",
    auditId: "audit-bench",
    vectorId: "tv-1",
    eventType,
    timestamp: new Date().toISOString(),
    payload: payload ?? { deltaMs },
    clientMetadata: {
      userAgent: "bench",
      ipAddress: "127.0.0.1",
      screenResolution: "1920x1080",
      platform: "web",
      language: "en-US",
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// Cases
// ═══════════════════════════════════════════════════════════════════

const mcp = installMcpStub();
const app = createApp(benchConfig());

const results = [];
const run = async (row) => { results.push(row); report(row); };

emit("");
emit("Cerberus local performance baseline");
emit("─".repeat(96));
emit(
  `  node ${process.version}   ${process.platform}/${process.arch}   ` +
    `${cpus().length} cpu   ${QUICK ? "quick" : "full"} run`,
);
emit("─".repeat(96));
emit(
  `  ${"case".padEnd(38)} ${"n".padStart(7)} ${"req/s".padStart(10)} ` +
    `${"p50 ms".padStart(8)} ${"p95 ms".padStart(8)} ${"p99 ms".padStart(8)} ${"max ms".padStart(9)}`,
);

// ── 1. Unauthenticated rejection: the cheapest possible path ──
await run(
  await measure("GET /api/v1/sessions (401)", iterations(2000), async () => {
    await app.request("/api/v1/sessions", { headers: { "Content-Type": "application/json" } });
  }),
);

// ── 2. List sessions ──
await run(
  await measure("GET /api/v1/sessions", iterations(1000), async () => {
    await app.request("/api/v1/sessions", { headers: HEADERS });
  }),
);

// ── 2b. List sessions with history behind them ──
//
// The case above lists whatever the earlier runs happened to leave, which is why it was
// fast even when the route was amplified. This one seeds 20 sessions each holding 200
// events first, so the list has real history to read past.
//
// **What this measures changed.** The route used to issue one `get_session_review` per
// session asking for the default — up to 500 micro-events plus every risk assessment — so
// the work grew with each session's *history* rather than with the number of sessions.
// It now asks for `eventsLimit: 0, assessmentsLimit: 1`.
//
// The document counts are asserted deterministically in
// `apps/api/test/review-list-bounds.test.ts` (20 sessions × 500 events carry 10 000 event
// documents before, 0 after), because a duration is machine-dependent and this script's own
// double has twice produced a false finding in this repository. What this case adds is the
// latency shape: it should be flat in history, not proportional to it.
const LIST_HISTORY_SESSIONS = 20;
const LIST_HISTORY_EVENTS = 200;

for (let session = 0; session < LIST_HISTORY_SESSIONS; session++) {
  const sessionId = `bench-list-${session}`;
  for (let sent = 0; sent < LIST_HISTORY_EVENTS; sent += 100) {
    const chunk = Math.min(100, LIST_HISTORY_EVENTS - sent);
    await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        events: Array.from({ length: chunk }, (_unused, index) =>
          microEvent(sessionId, `lh-${session}-${sent + index}`, "KEYSTROKE", null, index + 1),
        ),
      }),
    });
  }
}

await run(
  await measure(
    `GET /api/v1/sessions (${LIST_HISTORY_SESSIONS}×${LIST_HISTORY_EVENTS} history)`,
    iterations(300),
    async () => {
      await app.request("/api/v1/sessions", { headers: HEADERS });
    },
  ),
);

// ── 3. Telemetry ingest, one event per request, no analysis ──
//
// One event per request is what the console actually does, so it is the shape that
// matters for ingest cost. `deltaMs` varies so the dedup fingerprint differs and
// each event is genuinely new.
let ingestSeq = 0;
await run(
  await measure("POST /guardian/ingest (1 KEYSTROKE)", iterations(1000), async () => {
    ingestSeq++;
    await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        events: [microEvent("bench-ingest", `e-${ingestSeq}`, "KEYSTROKE", null, (ingestSeq % 500) + 1)],
      }),
    });
  }),
);

// ── 4. Telemetry ingest, batched ──
let batchSeq = 0;
await run(
  await measure("POST /guardian/ingest (50 events)", iterations(300), async () => {
    batchSeq++;
    const events = Array.from({ length: 50 }, (_unused, index) =>
      microEvent("bench-batch", `b-${batchSeq}-${index}`, "KEYSTROKE", null, index + 1),
    );
    await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ events }),
    });
  }),
);

// ── 5. A replayed batch: the dedup path ──
const replayBatch = Array.from({ length: 50 }, (_unused, index) =>
  microEvent("bench-replay", `r-${index}`, "KEYSTROKE", null, index + 1),
);
await app.request("/api/v1/guardian/ingest", {
  method: "POST",
  headers: HEADERS,
  body: JSON.stringify({ events: replayBatch }),
});
await run(
  await measure("POST /guardian/ingest (50 replayed)", iterations(300), async () => {
    await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ events: replayBatch }),
    });
  }),
);

// ── 6. Ingest that triggers analysis, with the provider stubbed ──
//
// A large paste on an empty session forces a fresh analysis. The score is stubbed
// at 40, below AUTO_LOCK_THRESHOLD, so no auto-lock and no notification.
let analyzeSeq = 0;
await run(
  await measure("POST /guardian/ingest (analysis)", iterations(300), async () => {
    analyzeSeq++;
    await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        events: [
          microEvent(
            `bench-analyze-${analyzeSeq}`,
            `a-${analyzeSeq}`,
            "PASTE",
            { newText: "x".repeat(400), changeLength: 400 },
          ),
        ],
      }),
    });
  }),
);

// ── 7. Session review ──
await run(
  await measure("GET /api/v1/sessions/:id", iterations(500), async () => {
    await app.request("/api/v1/sessions/bench-ingest", { headers: HEADERS });
  }),
);

// ── 7b. The reconciled live surfaces ──
//
// ── Why these two cases exist ────────────────────────────────────────
//
// The `v0.5.0` cycle made the live list and the live detail reconcile against durable truth on
// every request: the list issues one batched durable query per request, and the detail reads
// the session document. That is real work added to two hot paths, and until these cases
// existed nothing in this file measured it — the nine original cases cover the *review*
// surfaces and ingestion, not the live ones.
//
// They are measured with the same harness, the same stub and the same dataset as everything
// else, and they run unchanged against a `v0.4.0` build, which is what makes the before/after
// comparison in `docs/development/performance-baseline.md` a comparison rather than two
// unrelated numbers.
await run(
  await measure("GET /guardian/sessions (live list)", iterations(1000), async () => {
    await app.request("/api/v1/guardian/sessions", { headers: HEADERS });
  }),
);

await run(
  await measure("GET /guardian/sessions/:id (live detail)", iterations(1000), async () => {
    await app.request("/api/v1/guardian/sessions/bench-ingest", { headers: HEADERS });
  }),
);

// ── 8. Oversized-body rejection: the body limit, before buffering ──
await run(
  await measure("POST /guardian/ingest (oversized 413)", iterations(300), async () => {
    await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: { ...HEADERS, "Content-Length": String(9 * 1024 * 1024) },
      body: "{}",
    });
  }),
);

// ── 9. Health and readiness ──
await run(
  await measure("GET /health", iterations(2000), async () => {
    await app.request("/health");
  }),
);

// ── 10. Ingest cost as a function of how much the session already holds ──
//
// The single-session ingest case above degrades as the run proceeds, which suggests
// per-request cost depends on session size. This measures that directly instead of
// leaving it as an inference.
//
// It is the most actionable number here. If cost per event grows with the number of
// events already in the session, a long-running session gets steadily more
// expensive, and the *shape* matters more than the absolute figure.
emit("");
emit("  ingest cost vs session size (same request, different session)");
emit(
  `    ${"events already held".padEnd(20)} ${"n".padStart(6)} ${"req/s".padStart(9)} ` +
    `${"p50 ms".padStart(8)} ${"p95 ms".padStart(8)} ${"p99 ms".padStart(8)}`,
);

const scalingSizes = QUICK ? [0, 100, 1000] : [0, 100, 500, 1000, 2500, 5000];
const scaling = [];

for (const size of scalingSizes) {
  const sessionId = `bench-scale-${size}`;
  for (let sent = 0; sent < size; sent += 500) {
    const chunk = Math.min(500, size - sent);
    const seedBatch = Array.from({ length: chunk }, (_unused, index) =>
      microEvent(sessionId, `seed-${sent + index}`, "KEYSTROKE", null, index + 1),
    );
    await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ events: seedBatch }),
    });
  }

  let seq = 0;
  const row = await measure(`ingest into a ${size}-event session`, iterations(200), async () => {
    seq++;
    await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        events: [microEvent(sessionId, `probe-${seq}`, "KEYSTROKE", null, (seq % 500) + 1)],
      }),
    });
  });

  scaling.push({ eventsAlreadyHeld: size, ...row });
  emit(
    `    ${String(size).padEnd(20)} ${String(row.iterations).padStart(6)} ` +
      `${row.throughputPerSecond.toFixed(0).padStart(9)} ${row.p50Ms.toFixed(2).padStart(8)} ` +
      `${row.p95Ms.toFixed(2).padStart(8)} ${row.p99Ms.toFixed(2).padStart(8)}`,
  );
}

/**
 * A stub that accepts telemetry and retains nothing.
 *
 * Used for the memory case only. With the ordinary stub the MCP double's own event
 * log lives in the same heap as the API, so a heap delta measures both and attributes
 * the double's growth to the application — the same class of mistake as the event-cap
 * fidelity bug above. A store that keeps nothing isolates what Cerberus itself holds.
 */
function installSinkStub() {
  const original = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    const target = typeof url === "string" ? url : url.url;
    if (target.includes("/chat/completions")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const tool = target.split("/tools/")[1];
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (tool === "ingest_micro_events") {
      const batch = body.events ?? [];
      return Response.json({
        success: true,
        processedCount: batch.length,
        acceptedEventIds: batch.map((event) => event.eventId),
        duplicateEventIds: [],
      });
    }
    if (tool === "get_session_review") {
      return Response.json({ success: true, session: null, events: [], riskAssessments: [] });
    }
    return Response.json({ success: true });
  };

  return { restore: () => { globalThis.fetch = original; } };
}

// ── 11. Memory under sustained ingest ──
//
// Not a leak test — a leak needs hours. It answers "does a sustained burst grow the
// heap without bound?", which is the question a baseline can honestly answer.
//
// A SINK stub is used, so the heap delta is what Cerberus holds rather than what the
// MCP double holds alongside it. Enough events are pushed to exceed the in-memory
// window (`MAX_IN_MEMORY_EVENTS`, 1 000 with slack to 2 000); a smaller count would
// measure the window filling rather than the window holding.
const sink = installSinkStub();
const memoryApp = createApp(benchConfig());
const sustainedIterations = QUICK ? 500 : 5000;

if (global.gc) global.gc();
const heapBefore = process.memoryUsage().heapUsed;

for (let i = 0; i < sustainedIterations; i++) {
  await memoryApp.request("/api/v1/guardian/ingest", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      events: [microEvent("bench-memory", `m-${i}`, "KEYSTROKE", null, (i % 500) + 1)],
    }),
  });
}
sink.restore();
if (global.gc) global.gc();
const heapAfter = process.memoryUsage().heapUsed;
const heapDeltaMb = (heapAfter - heapBefore) / (1024 * 1024);
const bytesPerEvent = (heapAfter - heapBefore) / sustainedIterations;

emit("");
emit("  memory");
emit(
  `    ${sustainedIterations} further events into one session: ` +
    `heap ${(heapBefore / 1048576).toFixed(1)} MiB -> ${(heapAfter / 1048576).toFixed(1)} MiB ` +
    `(${heapDeltaMb >= 0 ? "+" : ""}${heapDeltaMb.toFixed(1)} MiB, ` +
    `${bytesPerEvent.toFixed(0)} B/event)`,
);

// ── Summary ──
const env = {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cpus: cpus().length,
  cpuModel: cpus()[0]?.model ?? "unknown",
  quick: QUICK,
  ranAt: new Date().toISOString(),
  note:
    "In-process via app.request() with the MCP adapter and AI provider stubbed. " +
    "Excludes TCP, TLS, HTTP server parsing, MongoDB and model latency.",
};

emit("");
emit("─".repeat(96));
emit(
  `  slowest p99: ${results.reduce((worst, row) => (row.p99Ms > worst.p99Ms ? row : worst)).label}`,
);
emit(`  environment: node ${env.node}, ${env.platform}, ${env.cpus} cpu, ${env.cpuModel}`);
emit("─".repeat(96));

if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify({ env, results, memory: {
    iterations: sustainedIterations,
    heapBeforeBytes: heapBefore,
    heapAfterBytes: heapAfter,
    bytesPerEvent,
  } }, null, 2));
  emit(`  raw results written to ${jsonPath}`);
}

mcp.restore();

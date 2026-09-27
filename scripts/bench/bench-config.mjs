/**
 * The `AppConfig` literal every benchmark runs against.
 *
 * ── Why this is a module and not a function inside one script ─────────
 *
 * A benchmark must not depend on an operator's environment, so it builds its own config
 * literal rather than calling `loadConfig()`. That is the right call, and it has a failure
 * mode that was live for four releases:
 *
 *   `createApp` reads `config.log.level` unconditionally. The operability cycle added
 *   structured logging to `AppConfig` and the benchmark's literal was not updated, so
 *   `npm run bench` — the command `docs/development/performance-baseline.md` documents as the
 *   reproducible way to produce the baseline — threw `Cannot read properties of undefined`
 *   before a single case ran. It had been broken from `v0.4.0` onward and nothing noticed,
 *   because no test ran it and no gate named it.
 *
 * A benchmark that does not run is worse than no benchmark: the document goes on describing a
 * baseline nobody can reproduce, and the numbers in it stop being comparable with anything.
 *
 * There are now two benchmark scripts — `run-bench.mjs` (stubbed persistence) and
 * `run-read-path-bench.mjs` (real MongoDB) — and the drift above is exactly what a second
 * copy of this literal would reintroduce. So the literal lives here, once, and
 * `apps/api/test/bench-config.test.ts` asserts it against `makeConfig()`'s shape **and**
 * asserts that every benchmark script imports it rather than declaring its own.
 */

/** The operator key the benchmarks authenticate with. Not a secret: nothing real accepts it. */
export const BENCH_API_KEY = "bench-key";

export function benchConfig() {
  return {
    port: 0,
    devMode: false,
    openai: {
      apiKey: "bench",
      model: "bench",
      maxOutputTokens: 1024,
      requestTimeoutMs: 5000,
    },
    mcp: { serverEndpoint: "http://127.0.0.1:1", apiKey: "bench", timeoutMs: 5000 },
    auth: { apiKey: BENCH_API_KEY, headerNames: ["authorization", "x-api-key"] },
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
    // `error` rather than `info`, because the intent is to silence the application's
    // per-request logging for the duration: one `http.request` line per sample buries the
    // results table. `console.log` being silenced does not stop the logger, which writes to
    // the stream directly — so the level is the control.
    log: { level: "error", format: "json" },
    // Read by the paid routes' idempotency handling. Present so this literal matches the
    // config shape the application expects; a `v0.4.0` build ignores it.
    idempotency: { ttlSeconds: 86_400 },
  };
}

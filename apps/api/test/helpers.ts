/**
 * Shared test fixtures.
 *
 * Tests never call a paid AI API and never require a live MongoDB. The MCP
 * persistence layer and the OpenAI endpoint are both served by an in-process
 * `fetch` stub, so the real provider, the real parsers and the real route
 * handlers all execute.
 */

import type { AppConfig } from "../src/config.js";
import { DEFAULT_IDEMPOTENCY_TTL_SECONDS } from "../src/services/idempotency-limits.js";

export const TEST_API_KEY = "test-operator-key-0123456789abcdef";
export const TEST_MCP_TOKEN = "test-mcp-token-0123456789abcdef";

/** Builds a fully-populated config without touching the environment. */
export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    port: 0,
    devMode: false,
    openai: {
      apiKey: "test-openai-key",
      model: "test-model",
      maxOutputTokens: 1024,
      // No temperature: mirrors the production default, where the parameter is
      // omitted unless OPENAI_TEMPERATURE is explicitly set.
      requestTimeoutMs: 5_000,
    },
    mcp: {
      serverEndpoint: "http://mcp.test",
      apiKey: TEST_MCP_TOKEN,
      timeoutMs: 2_000,
    },
    auth: {
      apiKey: TEST_API_KEY,
      headerNames: ["authorization", "x-api-key"],
    },
    cors: { allowedOrigins: ["http://console.test"] },
    security: {
      sessionTTLSeconds: 7200,
      maxRequestBodyBytes: 8 * 1024 * 1024,
      maxPasteEventsPerSession: 5,
      minHumanKeystrokeMs: 80,
      dataLeakageSimilarityThreshold: 0.75,
    },
    // Rate limiting is DISABLED in the fixture and enabled explicitly by the tests
    // that exercise it. Several suites drive hundreds of requests through the real
    // routes in a loop (identity registration, session TTL sweeps), so leaving the
    // limiter on would make those tests measure the limiter instead of the
    // behaviour they are about. rate-limit.test.ts enables it and asserts every
    // category through the same real routes.
    rateLimit: { enabled: false, aiRequestsPerMinute: 10 },
    // The production default. A test that needs a different retention window sets it
    // explicitly, because a shortened window is how an "expired record" case is written
    // without waiting a day.
    idempotency: { ttlSeconds: DEFAULT_IDEMPOTENCY_TTL_SECONDS },
    // Logging defaults match the production defaults. Tests that assert on log
    // output install a capture sink and raise the level with
    // `configureLogging({ sink, level: "debug" })` *after* building the app, because
    // `createApp` sets only the level and the format from config and leaves the sink
    // alone. See `apps/api/src/observability/logger.ts`.
    log: { level: "info", format: "pretty" },
  };

  return { ...base, ...overrides };
}

/**
 * Config with a specific session TTL, for `SESSION_TTL_SECONDS` expiry tests.
 *
 * Spelled out rather than relying on a deep merge, because `makeConfig`
 * replaces `security` wholesale and a partial object would silently drop the
 * other thresholds.
 */
export function makeConfigWithTtl(
  sessionTTLSeconds: number,
  overrides: Partial<AppConfig> = {},
): AppConfig {
  const base = makeConfig(overrides);
  return {
    ...base,
    security: { ...base.security, sessionTTLSeconds },
  };
}

/**
 * Config with a specific request body cap, for payload-limit tests.
 *
 * Same reasoning as {@link makeConfigWithTtl}: a small cap is set explicitly
 * rather than by building a partial `security` object.
 */
export function makeConfigWithBodyLimit(
  maxRequestBodyBytes: number,
  overrides: Partial<AppConfig> = {},
): AppConfig {
  const base = makeConfig(overrides);
  return {
    ...base,
    security: { ...base.security, maxRequestBodyBytes },
  };
}

// ═══════════════════════════════════════════════════════════════════
// fetch stub
// ═══════════════════════════════════════════════════════════════════

export interface FetchStub {
  /** Every request the code under test made, in order. */
  calls: Array<{ url: string; method: string; body: unknown }>;
  /** Tool names invoked against the MCP adapter, in order. */
  mcpTools: string[];
  restore(): void;
}

/**
 * Installs a `fetch` stub that answers:
 *   - `http://mcp.test/tools/*`  → the supplied MCP tool result
 *   - `https://api.openai.com/*` → a canned chat completion
 *   - anything else              → 404
 *
 * `mcpResponse` may return either a plain object, which is wrapped in an HTTP 200
 * as before, or a full `Response`, which is used as-is. The second form is what
 * lets a test reach the MCP adapter's real status codes — 400 for an invalid
 * argument, 404 for an unknown tool, 500 for a tool failure — through a route.
 * While every stub answered 200 unconditionally, `callMcpTool`'s non-2xx branch
 * was unreachable from any route test.
 *
 * Throwing from `mcpResponse` still models a transport failure: the rejected
 * promise is caught by `callMcpTool` and surfaces as `{ok: false}` with no status.
 *
 * ── Replacing a stub mid-test ─────────────────────────────────────────
 *
 * The OpenAI SDK captures `fetch` when its client is constructed, and
 * `getAIProvider()` memoises that client in a module-level singleton. So a test that
 * swaps this stub **after** a paid path has already run will keep talking to the
 * *old* stub's `fetch`, and a changed `aiResponse` will appear to be ignored.
 *
 * Call `resetAIProvider()` after `stub.restore()` and before installing the
 * replacement, whenever the test has already driven a paid path. This is a real
 * source of a confusing failure, so it is stated here rather than left to be
 * rediscovered.
 */
export function installFetchStub(options: {
  mcpResponse?: (
    tool: string,
    body: Record<string, unknown>,
  ) => unknown | Response | Promise<unknown | Response>;
  aiResponse?: string;
  /** Sequential AI replies; the last entry repeats once exhausted. */
  aiResponses?: string[];
} = {}): FetchStub {
  const original = globalThis.fetch;
  const calls: FetchStub["calls"] = [];
  const mcpTools: string[] = [];
  let aiCallIndex = 0;

  const mcpResponse =
    options.mcpResponse ??
    (() => ({ success: true, mongoDocumentId: "stub-doc-id" }));

  const defaultAiResponse =
    options.aiResponse ??
    JSON.stringify({
      riskAssessmentId: "11111111-1111-4111-8111-111111111111",
      sessionId: "",
      employeeId: "",
      auditId: "",
      overallRiskScore: 82,
      dimensionScores: {
        dataExfiltration: 80,
        unauthorizedAccess: 10,
        policyViolation: 40,
        amlRedFlag: 5,
        insiderTrading: 0,
        soxNonCompliance: 0,
      },
      flags: [
        {
          flagType: "SUSPICIOUS_PASTE",
          severity: "high",
          sourceEventId: "evt-1",
          description: "Large paste of external content",
          confidence: 0.9,
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
      exfiltrationReport: null,
      behavioralAnomalies: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
    });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    let parsedBody: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }

    calls.push({ url, method, body: parsedBody });

    if (url.startsWith("http://mcp.test/tools/")) {
      const tool = url.slice("http://mcp.test/tools/".length);
      mcpTools.push(tool);
      const body = (parsedBody ?? {}) as Record<string, unknown>;
      const result = await mcpResponse(tool, body);
      // A responder that models the adapter returns a Response with its own
      // status; a plain object keeps the historical 200 behaviour.
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("api.openai.com")) {
      let content = defaultAiResponse;
      if (options.aiResponses && options.aiResponses.length > 0) {
        const index = Math.min(aiCallIndex, options.aiResponses.length - 1);
        content = options.aiResponses[index];
      }
      aiCallIndex++;

      return new Response(
        JSON.stringify({
          id: "chatcmpl-stub",
          object: "chat.completion",
          created: 0,
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ success: false, error: "unexpected url" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return {
    calls,
    mcpTools,
    restore() {
      globalThis.fetch = original;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// Request helpers
// ═══════════════════════════════════════════════════════════════════

export function authorizedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${TEST_API_KEY}`,
    ...extra,
  };
}

export function anonymousHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

/** A single PASTE micro-event, the canonical telemetry fixture. */
export function pasteEvent(
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    eventId: `evt-${Math.random().toString(16).slice(2, 10)}`,
    sessionId,
    employeeId: "op-trader-001",
    auditId: "audit-2026-q1",
    vectorId: "tv-exfil-001",
    eventType: "PASTE",
    timestamp: new Date().toISOString(),
    payload: { newText: "x".repeat(200), changeLength: 200 },
    clientMetadata: {
      userAgent: "test-agent",
      ipAddress: "127.0.0.1",
      screenResolution: "1920x1080",
      platform: "web",
      language: "en-US",
    },
    ...overrides,
  };
}

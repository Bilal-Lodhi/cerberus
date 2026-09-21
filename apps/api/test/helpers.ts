/**
 * Shared test fixtures.
 *
 * Tests never call a paid AI API and never require a live MongoDB. The MCP
 * persistence layer and the OpenAI endpoint are both served by an in-process
 * `fetch` stub, so the real provider, the real parsers and the real route
 * handlers all execute.
 */

import type { AppConfig } from "../src/config.js";

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
      temperature: 0,
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
      maxPasteEventsPerSession: 5,
      minHumanKeystrokeMs: 80,
      dataLeakageSimilarityThreshold: 0.75,
    },
  };

  return { ...base, ...overrides };
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
 */
export function installFetchStub(options: {
  mcpResponse?: (tool: string, body: Record<string, unknown>) => unknown;
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
      return new Response(JSON.stringify(mcpResponse(tool, body)), {
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

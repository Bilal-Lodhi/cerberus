/**
 * Environment configuration for the Cerberus AI Hono API.
 * Uses dotenv for local development; Cloud Run injects env vars in production.
 *
 * ═══════════════════════════════════════════════════════════════════
 * OPENAI API — Primary Backend (GPT-5.6 via OpenAI SDK)
 * ═══════════════════════════════════════════════════════════════════
 *
 * All AI inference calls go through the OpenAI Node.js SDK.
 * Authentication is via OPENAI_API_KEY environment variable.
 *
 * API key: https://platform.openai.com/api-keys
 */

import "dotenv/config";

// ═══════════════════════════════════════════════════════════════════
// Config Types
// ═══════════════════════════════════════════════════════════════════

export interface AppConfig {
  port: number;
  openai: OpenAIConfig;
  mcp: MCPConfig;
  security: SecurityConfig;
}

export interface OpenAIConfig {
  /** OpenAI API key (required). */
  apiKey: string;
  /** Model name (e.g. "gpt-5.6"). */
  model: string;
  /** Maximum output tokens per response. */
  maxOutputTokens: number;
  /** Temperature (0-2). Lower = more deterministic. */
  temperature: number;
  /** Per-attempt timeout in ms (default 90_000 = 90s). */
  requestTimeoutMs: number;
}

export interface MCPConfig {
  /** MCP server URL (MongoDB track). */
  serverEndpoint: string;
  apiKey: string;
  timeoutMs: number;
}

export interface SecurityConfig {
  /** Session expiry in seconds. */
  sessionTTLSeconds: number;
  /** Max allowed paste events before auto-flagging. */
  maxPasteEventsPerSession: number;
  /** Min keystroke interval considered human (ms). */
  minHumanKeystrokeMs: number;
  /** Semantic similarity threshold for plagiarism. */
  plagiarismThreshold: number;
}

// ═══════════════════════════════════════════════════════════════════
// Config Loader
// ═══════════════════════════════════════════════════════════════════

export function loadConfig(): AppConfig {
  const port = parseInt(process.env["PORT"] ?? "8080", 10);

  const apiKey = process.env["OPENAI_API_KEY"] ?? "";

  if (!apiKey) {
    console.error(
      "[config] FATAL: OPENAI_API_KEY is not set. " +
        "Set OPENAI_API_KEY to your OpenAI API key."
    );
    process.exitCode = 1;
  } else {
    const masked = apiKey.length > 8
      ? `${apiKey.substring(0, 8)}...`
      : "(too short)";
    console.log(
      `[config] OpenAI API → key=${masked} model="${process.env["OPENAI_MODEL_NAME"] ?? "gpt-5.6"}"`
    );
  }

  const openai: OpenAIConfig = {
    apiKey,
    model: process.env["OPENAI_MODEL_NAME"] ?? "gpt-5.6",
    maxOutputTokens: parseInt(
      process.env["OPENAI_MAX_OUTPUT_TOKENS"] ?? "65536",
      10
    ),
    temperature: parseFloat(process.env["OPENAI_TEMPERATURE"] ?? "0.2"),
    requestTimeoutMs: parseInt(
      process.env["OPENAI_REQUEST_TIMEOUT_MS"] ?? "90000",
      10
    ),
  };

  const mcp: MCPConfig = {
    serverEndpoint:
      process.env["MCP_SERVER_ENDPOINT"] ?? "http://localhost:3001",
    apiKey: process.env["MCP_API_KEY"] ?? "",
    timeoutMs: parseInt(process.env["MCP_TIMEOUT_MS"] ?? "10000", 10),
  };

  const security: SecurityConfig = {
    sessionTTLSeconds: parseInt(
      process.env["SESSION_TTL_SECONDS"] ?? "7200",
      10
    ),
    maxPasteEventsPerSession: parseInt(
      process.env["MAX_PASTE_EVENTS"] ?? "5",
      10
    ),
    minHumanKeystrokeMs: parseInt(
      process.env["MIN_HUMAN_KEYSTROKE_MS"] ?? "80",
      10
    ),
    plagiarismThreshold: parseFloat(
      process.env["PLAGIARISM_THRESHOLD"] ?? "0.75"
    ),
  };

  return { port, openai, mcp, security };
}
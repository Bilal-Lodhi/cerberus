/**
 * Environment configuration for the Cerberus API.
 *
 * Configuration is read once at startup. Mandatory secrets are validated
 * here so the process fails fast and loudly instead of booting into an
 * unauthenticated or half-configured state.
 *
 * AI provider: OpenAI only. All inference goes through the OpenAI Node SDK
 * using OPENAI_API_KEY. See docs/configuration.md.
 */

import "dotenv/config";

// ═══════════════════════════════════════════════════════════════════
// Config Types
// ═══════════════════════════════════════════════════════════════════

export interface AppConfig {
  port: number;
  /** true when CERBERUS_DEV_MODE is explicitly enabled. */
  devMode: boolean;
  openai: OpenAIConfig;
  mcp: MCPConfig;
  auth: AuthConfig;
  cors: CorsConfig;
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
  /** Optional API base URL override (proxies / self-hosted gateways). */
  baseUrl?: string;
}

export interface MCPConfig {
  /** MCP HTTP adapter URL (the MongoDB persistence sidecar). */
  serverEndpoint: string;
  /** Shared secret the API presents to the MCP adapter. */
  apiKey: string;
  timeoutMs: number;
}

export interface AuthConfig {
  /** Operator API key. Empty only when devMode is true. */
  apiKey: string;
  /** Header names accepted for the credential, in priority order. */
  headerNames: string[];
}

export interface CorsConfig {
  /** Explicit allow-list. Empty array means "no cross-origin access". */
  allowedOrigins: string[];
}

export interface SecurityConfig {
  /** Session expiry in seconds. */
  sessionTTLSeconds: number;
  /** Max allowed paste events before auto-flagging. */
  maxPasteEventsPerSession: number;
  /** Min keystroke interval considered human (ms). */
  minHumanKeystrokeMs: number;
  /** Data-leakage similarity threshold for exfiltration matching (0-1). */
  dataLeakageSimilarityThreshold: number;
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function readEnv(name: string): string {
  return (process.env[name] ?? "").trim();
}

function readInt(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readFloat(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBool(name: string): boolean {
  const raw = readEnv(name).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Development defaults for cross-origin access. Only applied when
 * CERBERUS_DEV_MODE is explicitly enabled.
 */
const DEV_DEFAULT_CORS_ORIGINS = [
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

// ═══════════════════════════════════════════════════════════════════
// Config Loader
// ═══════════════════════════════════════════════════════════════════

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(): AppConfig {
  const devMode = readBool("CERBERUS_DEV_MODE");

  const openaiApiKey = readEnv("OPENAI_API_KEY");
  const apiKey = readEnv("CERBERUS_API_KEY");
  const mcpApiKey = readEnv("CERBERUS_MCP_TOKEN");
  const configuredCorsOrigins = splitList(readEnv("CERBERUS_CORS_ORIGINS"));

  // ── Fail closed: mandatory secrets outside explicit development mode ──
  const missing: string[] = [];
  if (!openaiApiKey) missing.push("OPENAI_API_KEY");
  if (!apiKey && !devMode) missing.push("CERBERUS_API_KEY");
  if (!mcpApiKey && !devMode) missing.push("CERBERUS_MCP_TOKEN");

  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        "Copy .env.example to .env and set them, or set CERBERUS_DEV_MODE=true " +
        "for local development only.",
    );
  }

  // ── Refuse to start in dev mode under NODE_ENV=production ──
  if (devMode && (process.env["NODE_ENV"] ?? "").toLowerCase() === "production") {
    throw new ConfigError(
      "CERBERUS_DEV_MODE=true is refused while NODE_ENV=production. " +
        "Development mode disables authentication and must never be enabled in production.",
    );
  }

  const openai: OpenAIConfig = {
    apiKey: openaiApiKey,
    model: readEnv("OPENAI_MODEL_NAME") || "gpt-5.6",
    maxOutputTokens: readInt("OPENAI_MAX_OUTPUT_TOKENS", 65536),
    temperature: readFloat("OPENAI_TEMPERATURE", 0.2),
    requestTimeoutMs: readInt("OPENAI_REQUEST_TIMEOUT_MS", 90000),
    baseUrl: readEnv("OPENAI_BASE_URL") || undefined,
  };

  const mcp: MCPConfig = {
    serverEndpoint: readEnv("MCP_SERVER_ENDPOINT") || "http://localhost:3001",
    apiKey: mcpApiKey,
    timeoutMs: readInt("MCP_TIMEOUT_MS", 10000),
  };

  const auth: AuthConfig = {
    apiKey,
    headerNames: ["authorization", "x-api-key"],
  };

  const cors: CorsConfig = {
    allowedOrigins:
      configuredCorsOrigins.length > 0
        ? configuredCorsOrigins
        : devMode
          ? DEV_DEFAULT_CORS_ORIGINS
          : [],
  };

  const security: SecurityConfig = {
    sessionTTLSeconds: readInt("SESSION_TTL_SECONDS", 7200),
    maxPasteEventsPerSession: readInt("MAX_PASTE_EVENTS", 5),
    minHumanKeystrokeMs: readInt("MIN_HUMAN_KEYSTROKE_MS", 80),
    dataLeakageSimilarityThreshold: readFloat(
      "DATA_LEAKAGE_SIMILARITY_THRESHOLD",
      0.75,
    ),
  };

  // ── Startup banner: never prints secret material ──
  console.log(
    `[config] mode=${devMode ? "development" : "production"} ` +
      `port=${readInt("PORT", 8080)} ` +
      `model="${openai.model}" ` +
      `openaiKey=${openaiApiKey ? "set" : "unset"} ` +
      `apiKey=${apiKey ? "set" : "unset"} ` +
      `mcpToken=${mcpApiKey ? "set" : "unset"} ` +
      `corsOrigins=${cors.allowedOrigins.length}`,
  );

  if (devMode) {
    console.warn(
      "[config] CERBERUS_DEV_MODE is enabled — authentication is DISABLED. " +
        "Never use this outside a local development machine.",
    );
  }

  return {
    port: readInt("PORT", 8080),
    devMode,
    openai,
    mcp,
    auth,
    cors,
    security,
  };
}

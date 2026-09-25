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

/**
 * Default maximum accepted request body size, in bytes (8 MiB).
 *
 * Deliberately the same ceiling the MCP adapter applies to its own request
 * bodies, so a body the API admits cannot be rejected downstream for size. It is
 * a request-buffering bound, not a telemetry-retention policy: nothing is
 * truncated, an oversized request is refused outright.
 */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

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
  /**
   * Optional sampling temperature (0-2).
   *
   * Only present when `OPENAI_TEMPERATURE` is explicitly set. Several current
   * models — including the default `gpt-5.6` — reject any temperature other
   * than their own default, so an unset value means "omit the parameter and let
   * the model decide" rather than "send a repository-chosen default".
   */
  temperature?: number;
  /** Per-attempt timeout in ms (default 180_000 = 180s). */
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
  /**
   * Maximum accepted request body size, in bytes.
   *
   * Enforced by the `body-limit` middleware in `index.ts` before the body is
   * buffered, so an oversized request is refused rather than read into memory.
   */
  maxRequestBodyBytes: number;
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
 */const DEV_DEFAULT_CORS_ORIGINS = [
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

/**
 * Reads a strictly positive whole number.
 *
 * Unlike {@link readInt}, an explicitly set but unusable value is a startup
 * failure rather than a silent fallback. `SESSION_TTL_SECONDS` bounds how long
 * an operator may be monitored and `CERBERUS_MAX_BODY_BYTES` bounds how much a
 * single request may buffer; quietly substituting a default the operator did not
 * choose — or silently reading `"1.5"` as `1` — would make either of those a
 * decision made by a typo.
 *
 * An unset variable still takes the default, so the documented default path is
 * unchanged.
 */
function readPositiveInt(name: string, fallback: number, unit: string): number {
  const raw = readEnv(name);
  if (!raw) return fallback;

  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(
      `${name} must be a whole number ${unit} (got "${raw}"). ` +
        `Leave it unset to use the default of ${fallback}.`,
    );
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigError(
      `${name} must be a positive integer ${unit} (got "${raw}"). ` +
        `Leave it unset to use the default of ${fallback}.`,
    );
  }
  return parsed;
}

/**
 * Reads a ratio in the closed range 0..1.
 *
 * Fails closed on an unusable value for the same reason as
 * {@link readPositiveInt}: `DATA_LEAKAGE_SIMILARITY_THRESHOLD` above 1 can never
 * be reached by a similarity score, so it would silently switch the exfiltration
 * matcher off while appearing to be configured.
 */
function readRatio(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new ConfigError(
      `${name} must be a number between 0 and 1 (got "${raw}"). ` +
        `Leave it unset to use the default of ${fallback}.`,
    );
  }
  return parsed;
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

  const rawTemperature = readEnv("OPENAI_TEMPERATURE");

  const openai: OpenAIConfig = {
    apiKey: openaiApiKey,
    model: readEnv("OPENAI_MODEL_NAME") || "gpt-5.6",
    maxOutputTokens: readInt("OPENAI_MAX_OUTPUT_TOKENS", 65536),
    // Omitted unless the operator opts in: the default model rejects any
    // temperature other than its own default.
    ...(rawTemperature ? { temperature: readFloat("OPENAI_TEMPERATURE", 1) } : {}),
    requestTimeoutMs: readInt("OPENAI_REQUEST_TIMEOUT_MS", 180000),
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
    // Enforced by apps/api/src/services/session-liveness.ts on every read.
    sessionTTLSeconds: readPositiveInt("SESSION_TTL_SECONDS", 7200, "of seconds"),
    // Enforced by the body-limit middleware in index.ts before buffering.
    maxRequestBodyBytes: readPositiveInt(
      "CERBERUS_MAX_BODY_BYTES",
      DEFAULT_MAX_BODY_BYTES,
      "of bytes",
    ),
    maxPasteEventsPerSession: readInt("MAX_PASTE_EVENTS", 5),
    minHumanKeystrokeMs: readInt("MIN_HUMAN_KEYSTROKE_MS", 80),
    // Gated by apps/api/src/services/text-similarity.ts.
    dataLeakageSimilarityThreshold: readRatio(
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
      `corsOrigins=${cors.allowedOrigins.length} ` +
      `sessionTtl=${security.sessionTTLSeconds}s ` +
      `maxBody=${security.maxRequestBodyBytes}B`,
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

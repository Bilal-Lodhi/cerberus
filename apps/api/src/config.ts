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

import {
  isLogFormat,
  isLogLevel,
  LOG_FORMATS,
  LOG_LEVELS,
  type LogFormat,
  type LogLevel,
} from "./observability/logger.js";

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
  rateLimit: RateLimitConfig;
  log: LogConfig;
}

/**
 * Structured-logging configuration.
 *
 * See `docs/development/operability-model.md` §5.1. Both values are validated at
 * startup and an unusable one is a `ConfigError` rather than a silent fallback: a
 * typo in a logging control must not quietly change what is recorded.
 */
export interface LogConfig {
  /** Minimum level emitted. */
  level: LogLevel;
  /** `pretty` for a terminal, `json` for a log shipper. */
  format: LogFormat;
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
  /**
   * The key being retired, accepted during a rotation overlap.
   *
   * Set `CERBERUS_API_KEY` to the new key and this to the old one, restart, move
   * every client across, then unset this and restart again. There is no key
   * identity, no revocation list and no rotation tooling — this is the minimum
   * that makes a rotation possible without a hard cutover.
   */
  previousApiKey?: string;
  /** Header names accepted for the credential, in priority order. */
  headerNames: string[];
}

export interface CorsConfig {
  /** Explicit allow-list. Empty array means "no cross-origin access". */
  allowedOrigins: string[];
}

export interface RateLimitConfig {
  /** Whether the in-process limiter runs. Default true. */
  enabled: boolean;
  /**
   * Requests per minute allowed on AI-backed endpoints.
   *
   * The one limit worth tuning: every request to those endpoints spends money. The
   * other categories are documented backstops rather than knobs.
   */
  aiRequestsPerMinute: number;
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

/**
 * Reads a boolean with an explicit default.
 *
 * Unlike {@link readBool}, an unrecognised value is a startup failure rather than
 * a silent `false`. This reads controls whose default is **on**, and silently
 * treating `CERBERUS_RATE_LIMIT_ENABLED=maybe` as "disabled" would let a typo turn
 * a control off.
 */
function readBoolStrict(name: string, fallback: boolean): boolean {
  const raw = readEnv(name).toLowerCase();
  if (!raw) return fallback;

  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;

  throw new ConfigError(
    `${name} must be a boolean (true/false, 1/0, yes/no, on/off). Got "${raw}". ` +
      `Leave it unset to use the default of ${fallback}.`,
  );
}

/**
 * Reads one value from a fixed set, case-insensitively.
 *
 * An explicitly set but unrecognised value is a startup failure rather than a silent
 * fallback, for the same reason as {@link readPositiveInt}: a typo in
 * `CERBERUS_LOG_FORMAT` must not quietly change the shape of every log line a
 * deployment emits.
 */
function readEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = readEnv(name).toLowerCase();
  if (!raw) return fallback;

  if ((allowed as readonly string[]).includes(raw)) return raw as T;

  throw new ConfigError(
    `${name} must be one of ${allowed.join(", ")} (got "${raw}"). ` +
      `Leave it unset to use the default of ${fallback}.`,
  );
}

export function loadConfig(): AppConfig {
  const devMode = readBool("CERBERUS_DEV_MODE");

  const openaiApiKey = readEnv("OPENAI_API_KEY");
  const apiKey = readEnv("CERBERUS_API_KEY");
  const previousApiKey = readEnv("CERBERUS_API_KEY_PREVIOUS");
  const mcpApiKey = readEnv("CERBERUS_MCP_TOKEN");
  const configuredCorsOrigins = splitList(readEnv("CERBERUS_CORS_ORIGINS"));

  // ── The rotation overlap is an overlap, never a replacement ──
  //
  // Accepting a "previous" key with no current key would leave a deployment
  // authenticating against the credential it is trying to retire.
  if (previousApiKey && !apiKey) {
    throw new ConfigError(
      "CERBERUS_API_KEY_PREVIOUS is set but CERBERUS_API_KEY is not. The previous key is an " +
        "overlap for a rotation, not a replacement: set the current key as well, or unset both.",
    );
  }

  if (previousApiKey && previousApiKey === apiKey) {
    console.warn(
      "[config] CERBERUS_API_KEY_PREVIOUS equals CERBERUS_API_KEY — the overlap is a no-op. " +
        "Unset the previous key once every client has moved to the current one.",
    );
  }

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
    ...(previousApiKey ? { previousApiKey } : {}),
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

  const rateLimit: RateLimitConfig = {
    enabled: readBoolStrict("CERBERUS_RATE_LIMIT_ENABLED", true),
    aiRequestsPerMinute: readPositiveInt(
      "CERBERUS_AI_REQUESTS_PER_MINUTE",
      10,
      "of requests",
    ),
  };

  const log: LogConfig = {
    level: readEnum("CERBERUS_LOG_LEVEL", LOG_LEVELS, "info"),
    format: readEnum("CERBERUS_LOG_FORMAT", LOG_FORMATS, "pretty"),
  };

  // ── Startup banner: never prints secret material ──
  console.log(
    `[config] mode=${devMode ? "development" : "production"} ` +
      `port=${readInt("PORT", 8080)} ` +
      `model="${openai.model}" ` +
      `openaiKey=${openaiApiKey ? "set" : "unset"} ` +
      `apiKey=${apiKey ? "set" : "unset"} ` +
      `previousApiKey=${previousApiKey ? "set" : "unset"} ` +
      `mcpToken=${mcpApiKey ? "set" : "unset"} ` +
      `corsOrigins=${cors.allowedOrigins.length} ` +
      `sessionTtl=${security.sessionTTLSeconds}s ` +
      `maxBody=${security.maxRequestBodyBytes}B ` +
      `rateLimit=${rateLimit.enabled ? `on (ai=${rateLimit.aiRequestsPerMinute}/min)` : "off"} ` +
      `log=${log.level}/${log.format}`,
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
    rateLimit,
    log,
  };
}

/**
 * Re-exported so a caller can validate a logging value without importing the logger
 * module, and so the accepted sets have one definition.
 */
export { isLogFormat, isLogLevel };

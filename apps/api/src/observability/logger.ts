/**
 * The Cerberus structured logger.
 *
 * ── What it is ────────────────────────────────────────────────────────
 *
 * A dependency-free, synchronous logger with two output formats and four levels. It
 * exists because the API previously logged unstructured text through `console.*`
 * with no request identifier, so a line could not be joined to the request that
 * produced it, and no line at all was produced outside development mode.
 *
 * The design is stated in `docs/development/operability-model.md` §5. The rules that
 * matter, and why:
 *
 * 1. **One line per request**, emitted after the response exists, carrying the
 *    status, the latency, the matched route template and the stable error code.
 * 2. **Redaction before serialisation, never after.** A secret that reaches the
 *    formatter has already been disclosed; see `redaction.ts`.
 * 3. **Bounded by construction.** No queue, no buffer, no growing registry. The
 *    logger writes and returns, so there is nothing that can leak memory in
 *    proportion to traffic, and a large value cannot be emitted because
 *    `redactValue` caps depth, breadth and length.
 * 4. **The ambient request id is attached automatically**, so a service module logs
 *    against the request without being handed anything. See `request-context.ts`.
 *
 * ── What it deliberately is not ───────────────────────────────────────
 *
 * Not an SDK, not a shipper, not OpenTelemetry. An external logging vendor would add
 * a transitive dependency tree, its own redaction semantics and a network egress
 * path, to a self-hosted single-tenant service that produces one line per request.
 * Retention, shipping and access control belong to the deployer, and
 * `docs/security/threat-model.md` §9.6 states that structured logs are not a
 * compliance claim.
 */

import { currentRequestContext } from "./request-context.js";
import {
  describeError,
  isContentKey,
  isSensitiveKey,
  REDACTED,
  REDACTED_CONTENT,
  redactValue,
} from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "pretty" | "json";

/** Every accepted level, in increasing severity. */
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Every accepted format. */
export const LOG_FORMATS: readonly LogFormat[] = ["pretty", "json"];

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** True when `value` is one of the accepted levels. */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/** True when `value` is one of the accepted formats. */
export function isLogFormat(value: unknown): value is LogFormat {
  return typeof value === "string" && (LOG_FORMATS as readonly string[]).includes(value);
}

/**
 * One log record.
 *
 * `event` is a stable, dotted name (`http.request`, `mcp.call`, `session.transition`)
 * so a log can be filtered without matching on prose. Everything else is a field.
 */
export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  event: string;
  requestId?: string;
  [field: string]: unknown;
}

/**
 * Where a formatted line goes.
 *
 * Receives both the rendered line and the structured record, so a test can assert
 * either the emitted text or the fields, and a deployer can route without parsing.
 */
export type LogSink = (line: string, record: LogRecord) => void;

interface LoggingState {
  level: LogLevel;
  format: LogFormat;
  sink: LogSink;
}

/**
 * The default sink: `stdout` for debug and info, `stderr` for warn and error.
 *
 * The split is what lets a deployer keep error lines while discarding request noise,
 * and it is why the level is not encoded in the stream for a single-stream consumer —
 * `json` format carries it as a field.
 */
const defaultSink: LogSink = (line, record) => {
  if (record.level === "error" || record.level === "warn") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
};

const DEFAULT_LEVEL: LogLevel = "info";
const DEFAULT_FORMAT: LogFormat = "pretty";

let state: LoggingState = {
  level: DEFAULT_LEVEL,
  format: DEFAULT_FORMAT,
  sink: defaultSink,
};

/**
 * Applies logging configuration.
 *
 * Partial by design: `createApp` sets the level and the format from configuration and
 * **leaves the sink alone**, so a test that installed a capture sink before building
 * the app keeps it. A test that wants the level as well passes it here.
 */
export function configureLogging(options: {
  level?: LogLevel;
  format?: LogFormat;
  sink?: LogSink;
}): void {
  if (options.level !== undefined) state.level = options.level;
  if (options.format !== undefined) state.format = options.format;
  if (options.sink !== undefined) state.sink = options.sink;
}

/** Restores the documented defaults, including the default sink. For tests. */
export function resetLogging(): void {
  state = { level: DEFAULT_LEVEL, format: DEFAULT_FORMAT, sink: defaultSink };
}

/** The active level and format. */
export function currentLoggingConfig(): { level: LogLevel; format: LogFormat } {
  return { level: state.level, format: state.format };
}

/** True when a line at `level` would be emitted. */
export function isLevelEnabled(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[state.level];
}

/** Fields a caller may attach to a log line. */
export type LogFields = Record<string, unknown>;

/** The order the well-known request fields are rendered in. */
const PREFERRED_FIELD_ORDER = [
  "method",
  "route",
  "status",
  "latencyMs",
  "errorCode",
  "dependency",
  "providerAttempts",
  "sessionId",
  "channel",
  "classification",
  "retryAfterSeconds",
  "category",
  "rejected",
] as const;

/**
 * Redacts one field, classifying its **key** as well as its value.
 *
 * The key classification matters at the top level, not only inside a nested object:
 * `logger.info("x", { currentCode: "…" })` hands the workspace to the logger as a
 * direct field, and a redactor that only walks values would emit it verbatim. That
 * gap was found by this module's own test suite, which is the reason the check lives
 * in one place rather than at each call site.
 */
function redactField(key: string, value: unknown): unknown {
  if (isSensitiveKey(key)) return REDACTED;
  if (isContentKey(key)) return REDACTED_CONTENT;
  return redactValue(value);
}

/**
 * Builds the redacted record.
 *
 * The request id is placed immediately after `event` so it is the first thing a
 * human reads, and an explicit `requestId` in the fields wins over the ambient one —
 * which is what lets a script or a readiness probe log under its own fixed label.
 */
function buildRecord(level: LogLevel, event: string, fields: LogFields): LogRecord {
  const record: LogRecord = {
    timestamp: new Date().toISOString(),
    level,
    event,
  };

  const context = currentRequestContext();
  const explicitRequestId = fields["requestId"];
  if (typeof explicitRequestId === "string" && explicitRequestId.length > 0) {
    record.requestId = explicitRequestId;
  } else if (context) {
    record.requestId = context.requestId;
  }

  for (const key of PREFERRED_FIELD_ORDER) {
    if (key in fields) {
      record[key] = redactField(key, fields[key]);
    }
  }

  for (const [key, value] of Object.entries(fields)) {
    if (key === "requestId") continue;
    if ((PREFERRED_FIELD_ORDER as readonly string[]).includes(key)) continue;
    if (key === "timestamp" || key === "level" || key === "event") continue;
    record[key] = redactField(key, value);
  }

  return record;
}

/** Renders a value compactly for the `pretty` format. */
function renderPrettyValue(value: unknown): string {
  if (typeof value === "string") {
    return /\s/.test(value) ? JSON.stringify(value) : value;
  }
  if (value === null || value === undefined) return String(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** `2026-01-01T00:00:00.000Z INFO  http.request requestId=… status=200` */
function formatPretty(record: LogRecord): string {
  const parts: string[] = [
    `[${record.timestamp}]`,
    record.level.toUpperCase().padEnd(5),
    record.event,
  ];

  for (const [key, value] of Object.entries(record)) {
    if (key === "timestamp" || key === "level" || key === "event") continue;
    parts.push(`${key}=${renderPrettyValue(value)}`);
  }

  return parts.join(" ");
}

/** One JSON object per line, which is what a log shipper consumes. */
function formatJson(record: LogRecord): string {
  return JSON.stringify(record);
}

function emit(level: LogLevel, event: string, fields: LogFields): void {
  // Checked before the record is built, so a disabled level costs one comparison
  // rather than a redaction walk.
  if (!isLevelEnabled(level)) return;

  const record = buildRecord(level, event, fields);
  const line = state.format === "json" ? formatJson(record) : formatPretty(record);
  state.sink(line, record);
}

/**
 * The logger.
 *
 * Every method takes a stable `event` name and an optional field bag. Errors are
 * passed under `error` and are converted with `describeError`, never serialised
 * wholesale.
 */
export const logger = {
  debug(event: string, fields: LogFields = {}): void {
    emit("debug", event, fields);
  },
  info(event: string, fields: LogFields = {}): void {
    emit("info", event, fields);
  },
  warn(event: string, fields: LogFields = {}): void {
    emit("warn", event, fields);
  },
  error(event: string, fields: LogFields = {}): void {
    emit("error", event, fields);
  },
  /**
   * Logs an error with its `name` and a scrubbed `message`.
   *
   * A thin convenience so no call site is tempted to pass the raw exception object.
   */
  failure(event: string, error: unknown, fields: LogFields = {}): void {
    emit("error", event, { ...fields, error: describeError(error) });
  },
};

export type Logger = typeof logger;

/** Stable event names, so a log can be filtered without matching on prose. */
export const LOG_EVENTS = {
  /** The one line per HTTP request. */
  HTTP_REQUEST: "http.request",
  /** An exception that reached the top-level handler. */
  HTTP_UNHANDLED: "http.request.unhandled",
  /** A rejected request, before any route ran. */
  HTTP_REJECTED: "http.request.rejected",
  /** One MCP persistence call. */
  MCP_CALL: "mcp.call",
  /** An MCP call that did not answer. */
  MCP_FAILURE: "mcp.failure",
  /** A session lifecycle transition. */
  SESSION_TRANSITION: "session.transition",
  /** A session lifecycle action that was refused. */
  SESSION_TRANSITION_REFUSED: "session.transition.refused",
  /**
   * A document held a status the store cannot hold, and a transition replaced it.
   *
   * A data-integrity signal worth knowing about, because a stored field was rewritten.
   */
  SESSION_TRANSITION_REPAIRED: "session.transition.repaired",
  /** A best-effort outbound notification. */
  NOTIFICATION: "notification.outbound",
  /** A provider attempt inside the retry loop. */
  PROVIDER_ATTEMPT: "provider.attempt",
  /** A paid provider call that completed. */
  PROVIDER_CALL: "provider.call",
  /** A paid provider call that failed. */
  PROVIDER_FAILURE: "provider.failure",
  /** Process startup, configuration and fatal errors. */
  STARTUP: "process.startup",
  STARTUP_FAILURE: "process.startup.failure",
  /** A rate-limit rejection. */
  RATE_LIMITED: "rate_limit.rejected",

  // ── Guardian: ingest and analysis ──────────────────────────────
  /** Events in a batch the store reported as already present. */
  GUARDIAN_INGEST_DUPLICATES: "guardian.ingest.duplicates",
  /** The workspace was unchanged, so the cached payload was reused. */
  GUARDIAN_INGEST_CODE_UNCHANGED: "guardian.ingest.code_unchanged",
  /** An ingest request that failed after validation. */
  GUARDIAN_INGEST_FAILURE: "guardian.ingest.failure",
  /** A paid risk analysis completed. Score and flag count only, never the prompt. */
  GUARDIAN_ANALYSIS_COMPLETE: "guardian.analysis.complete",
  /** A paid risk analysis failed. Non-fatal: the telemetry is already durable. */
  GUARDIAN_ANALYSIS_FAILURE: "guardian.analysis.failure",
  /** Local exfiltration-similarity matches above the configured threshold. */
  GUARDIAN_SIMILARITY_MATCHES: "guardian.similarity.matches",
  /** The assessment write failed, so the status change and notification were skipped. */
  GUARDIAN_ASSESSMENT_NOT_PERSISTED: "guardian.assessment.not_persisted",
  /** A live session was hydrated from its durable document. */
  GUARDIAN_SESSION_HYDRATED: "guardian.session.hydrated",
  /** Creating the durable session document failed. Non-fatal. */
  GUARDIAN_SESSION_CREATE_FAILED: "guardian.session.create_failed",
  /** The reference corpus could not be read, so similarity matching was skipped. */
  GUARDIAN_CORPUS_UNAVAILABLE: "guardian.corpus.unavailable",
  /**
   * A session detail was answered from somewhere other than in-memory session state —
   * the durable document, or the live registry.
   */
  GUARDIAN_DETAIL_FALLBACK: "guardian.detail.fallback",

  // ── Guardian: lifecycle ────────────────────────────────────────
  /** A session was deployed. */
  GUARDIAN_DEPLOY_COMPLETE: "guardian.deploy.complete",
  /** Deploying a session failed. */
  GUARDIAN_DEPLOY_FAILURE: "guardian.deploy.failure",
  /** Terminal workspace content was, or was not, preserved on terminate. */
  GUARDIAN_TERMINAL_CONTENT: "guardian.terminal_content",
  /** A session and every document derived from it were deleted. */
  GUARDIAN_DELETE_COMPLETE: "guardian.delete.complete",
  /** A session delete did not reach the store. Nothing was changed. */
  GUARDIAN_DELETE_FAILURE: "guardian.delete.failure",
  /** A session delete ran and only part of it succeeded. Retrying is safe. */
  GUARDIAN_DELETE_PARTIAL: "guardian.delete.partial",

  // ── Scenario authoring (paid) ──────────────────────────────────
  /** The deterministic pre-filter's verdict. */
  SCENARIOS_PREFILTER: "scenarios.prefilter",
  /** The semantic classifier's verdict, or its unavailability. */
  SCENARIOS_CLASSIFIER: "scenarios.classifier",
  /** The scenario matrix was authored but not persisted. Non-fatal. */
  SCENARIOS_PERSIST_FAILURE: "scenarios.persist_failure",
  /** A scenario matrix was authored. Vector count only, never the prompt. */
  SCENARIOS_COMPLETE: "scenarios.complete",
  /** Scenario generation failed. */
  SCENARIOS_FAILURE: "scenarios.failure",

  // ── Auditor (paid) ─────────────────────────────────────────────
  /** An audit query failed. */
  AUDITOR_FAILURE: "auditor.query.failure",

  // ── Reference corpus ───────────────────────────────────────────
  /** The corpus is at its ceiling, so a new document was refused. */
  REFERENCE_CORPUS_FULL: "reference.corpus.full",
  /** The corpus store did not answer. */
  REFERENCE_STORE_FAILURE: "reference.store.failure",
  /** A reference document was stored or updated. */
  REFERENCE_STORED: "reference.stored",
  /** A reference document was deleted. */
  REFERENCE_DELETED: "reference.deleted",

  // ── Identity ───────────────────────────────────────────────────
  /** An operator display identity was registered. The values are never logged. */
  IDENTITY_REGISTERED: "identity.registered",
} as const;

export type LogEventName = (typeof LOG_EVENTS)[keyof typeof LOG_EVENTS];

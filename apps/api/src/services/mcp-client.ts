/**
 * MCP HTTP client used by the Cerberus API.
 *
 * This is the single place the API talks to the MongoDB persistence sidecar.
 * It centralises three things that were previously duplicated per route:
 *   1. the canonical tool-name set (asserted against the MCP server by tests)
 *   2. hard per-call timeouts so a slow database never stalls ingestion
 *   3. the shared-secret credential the MCP adapter requires
 *
 * ── Correlation ───────────────────────────────────────────────────────
 *
 * The request id is read from the ambient request context rather than minted here or
 * required from every caller. `options.requestId` still overrides it, which is what
 * lets a readiness probe or a script log under a fixed, non-request label. See
 * `../observability/request-context.ts`.
 *
 * ── What is never logged ──────────────────────────────────────────────
 *
 * The tool name, the status, the latency and a sanitised failure classification. Not
 * the request body: a `store_risk_assessment` body carries the whole assessment, and
 * an `ingest_micro_events` body carries the telemetry. Failure messages are scrubbed,
 * because a driver error can quote a credentialed connection string.
 */

import type { AppConfig } from "../config.js";
import { LOG_EVENTS, logger } from "../observability/logger.js";
import { currentRequestId } from "../observability/request-context.js";
import { redactString } from "../observability/redaction.js";
import { MCP_TOOL_NAMES, type McpToolName } from "./mcp-tool-names.js";

export { MCP_TOOL_NAMES, type McpToolName };

/** Default per-call timeout when the caller does not override it. */
const DEFAULT_TIMEOUT_MS = 5_000;

export interface McpCallResult<T> {
  ok: boolean;
  data: T | null;
  status: number | null;
  error?: string;
  /**
   * The adapter's own `code`, when it returned one.
   *
   * The adapter answers a refused operation with `{success: false, code, error}`, and a
   * route needs that `code` to return the same stable value to its caller rather than
   * flattening every adapter failure into a 503. Before this, a non-2xx response was
   * drained and reduced to `"HTTP 409"`, so a specific refusal — the reference corpus
   * being full, for instance — was indistinguishable from the store being unreachable.
   *
   * Best-effort: a body that does not parse, or carries no `code`, leaves this
   * undefined and the caller falls back to the status.
   */
  code?: string;
}

/**
 * Invokes an MCP tool over HTTP.
 *
 * Always resolves — never throws. A timeout, connection refusal, non-2xx
 * status or unparseable body all surface as `{ ok: false }` so callers can
 * degrade gracefully instead of failing the whole request.
 */
export async function callMcpTool<T = unknown>(
  config: AppConfig,
  tool: McpToolName,
  body: unknown,
  options: { requestId?: string; timeoutMs?: number } = {},
): Promise<McpCallResult<T>> {
  const requestId = options.requestId ?? currentRequestId();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    logger.warn(LOG_EVENTS.MCP_FAILURE, {
      requestId,
      tool,
      classification: "timeout",
      timeoutMs,
      dependency: "mcp",
    });
    controller.abort();
  }, timeoutMs);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.mcp.apiKey) {
    headers["Authorization"] = `Bearer ${config.mcp.apiKey}`;
  }

  try {
    const startedAt = Date.now();
    const res = await fetch(`${config.mcp.serverEndpoint}/tools/${tool}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startedAt;

    if (!res.ok) {
      // Read the body rather than draining it blindly: the adapter's `code` is what
      // lets a route return a specific refusal instead of a generic unavailability.
      // Reading it also drains the response, so the connection can still be reused.
      const raw = await res.text().catch(() => "");
      let code: string | undefined;
      try {
        const parsed = JSON.parse(raw) as { code?: unknown };
        if (typeof parsed?.code === "string" && parsed.code.length > 0) {
          code = parsed.code;
        }
      } catch {
        // A body that is not JSON leaves `code` undefined, which is the documented
        // best-effort behaviour.
      }

      logger.warn(LOG_EVENTS.MCP_FAILURE, {
        requestId,
        tool,
        dependency: "mcp",
        classification: "non-2xx",
        status: res.status,
        latencyMs,
        ...(code ? { errorCode: code } : {}),
      });

      return {
        ok: false,
        data: null,
        status: res.status,
        error: code ? `HTTP ${res.status} (${code})` : `HTTP ${res.status}`,
        ...(code ? { code } : {}),
      };
    }

    logger.debug(LOG_EVENTS.MCP_CALL, {
      requestId,
      tool,
      dependency: "mcp",
      status: res.status,
      latencyMs,
    });

    const data = (await res.json()) as T;
    return { ok: true, data, status: res.status };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    const message = timedOut
      ? `timed out after ${timeoutMs}ms`
      : error instanceof Error
        ? redactString(error.message)
        : "unknown transport failure";

    logger.error(LOG_EVENTS.MCP_FAILURE, {
      requestId,
      tool,
      dependency: "mcp",
      classification: timedOut ? "timeout" : "transport",
      error: message,
    });

    return { ok: false, data: null, status: null, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}

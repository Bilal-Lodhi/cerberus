/**
 * MCP HTTP client used by the Cerberus API.
 *
 * This is the single place the API talks to the MongoDB persistence sidecar.
 * It centralises three things that were previously duplicated per route:
 *   1. the canonical tool-name set (asserted against the MCP server by tests)
 *   2. hard per-call timeouts so a slow database never stalls ingestion
 *   3. the shared-secret credential the MCP adapter requires
 */

import type { AppConfig } from "../config.js";
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
  const requestId = options.requestId ?? "-";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn(`[mcp] [${requestId}] ${tool} aborted after ${timeoutMs}ms`);
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

    console.log(
      `[mcp] [${requestId}] ${tool} → HTTP ${res.status} in ${Date.now() - startedAt}ms`,
    );

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

      return {
        ok: false,
        data: null,
        status: res.status,
        error: code ? `HTTP ${res.status} (${code})` : `HTTP ${res.status}`,
        ...(code ? { code } : {}),
      };
    }

    const data = (await res.json()) as T;
    return { ok: true, data, status: res.status };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);

    if (error instanceof Error && error.name === "AbortError") {
      console.error(`[mcp] [${requestId}] ${tool} TIMED OUT after ${timeoutMs}ms`);
    } else {
      console.error(`[mcp] [${requestId}] ${tool} failed: ${message}`);
    }

    return { ok: false, data: null, status: null, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}

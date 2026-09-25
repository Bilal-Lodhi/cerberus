/**
 * MCP server HTTP adapter.
 *
 * The stdio MCP server (server.ts) is used for local agent-to-tool
 * communication. This adapter exposes the same tool registry over HTTP so the
 * Cerberus API can address the persistence layer as a sidecar.
 *
 * Security posture:
 *   - Binds to localhost by default (MCP_BIND_HOST).
 *   - Requires a shared-secret bearer token (CERBERUS_MCP_TOKEN) unless
 *     CERBERUS_DEV_MODE=true is explicitly set.
 *   - Emits no CORS headers at all unless CERBERUS_MCP_CORS_ORIGINS is set;
 *     this is a server-to-server interface, not a browser-facing one.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { MongoStore } from "./mongo-client.js";
import { DEFAULT_MAX_BODY_BYTES, parseBody } from "./body.js";
import {
  ToolArgumentError,
  createToolRegistry,
  type ToolHandler,
} from "./tools.js";
import { MCP_SERVER_VERSION, MCP_TOOL_NAMES } from "./tool-names.js";

// ─── Configuration ───────────────────────────────────────────────────

const PORT = Number.parseInt(process.env["MCP_PORT"] ?? "3001", 10);
const BIND_HOST = process.env["MCP_BIND_HOST"] ?? "127.0.0.1";
const DEV_MODE =
  (process.env["CERBERUS_DEV_MODE"] ?? "").toLowerCase() === "true";
const MCP_TOKEN = (process.env["CERBERUS_MCP_TOKEN"] ?? "").trim();
/**
 * The MCP token being retired, accepted during a rotation overlap.
 *
 * Same model as the API's `CERBERUS_API_KEY_PREVIOUS`: set the new token, keep the
 * old one here, move the API across, then unset this and restart. It exists so the
 * sidecar and the API can be rotated without a moment where one accepts a token
 * the other has already stopped sending.
 */
const MCP_TOKEN_PREVIOUS = (process.env["CERBERUS_MCP_TOKEN_PREVIOUS"] ?? "").trim();
const CORS_ORIGINS = (process.env["CERBERUS_MCP_CORS_ORIGINS"] ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

/**
 * Maximum accepted request body size, in bytes.
 *
 * Reads the same variable the API does so the two ceilings cannot drift apart:
 * a body the API admits must not be rejected here for size. The API validates
 * this value fail-closed at startup, so an unusable value here can only come from
 * running the adapter standalone; the default applies and the effective value is
 * logged below.
 */
const MAX_BODY_BYTES = ((): number => {
  const raw = (process.env["CERBERUS_MAX_BODY_BYTES"] ?? "").trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_MAX_BODY_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BODY_BYTES;
})();

if (!DEV_MODE && MCP_TOKEN.length === 0) {
  console.error(
    "[MCP-HTTP] FATAL: CERBERUS_MCP_TOKEN is not set. " +
      "Set it, or set CERBERUS_DEV_MODE=true for local development only.",
  );
  process.exit(1);
}

const store = new MongoStore();
const tools: Record<string, ToolHandler> = createToolRegistry(store);

// ─── Auth ────────────────────────────────────────────────────────────

function constantTimeEquals(supplied: string, expected: string): boolean {
  if (supplied.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(a, b);
}

function isAuthorized(req: IncomingMessage): boolean {
  if (DEV_MODE) return true;
  const header = req.headers["authorization"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return false;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  const presented = match?.[1]?.trim() ?? "";

  // Both comparisons always run, so the response time does not reveal which token
  // matched. Neither token is ever logged or echoed.
  const matchesCurrent = constantTimeEquals(presented, MCP_TOKEN);
  const matchesPrevious =
    MCP_TOKEN_PREVIOUS.length > 0
      ? constantTimeEquals(presented, MCP_TOKEN_PREVIOUS)
      : false;

  return matchesCurrent || matchesPrevious;
}

// ─── HTTP helpers ────────────────────────────────────────────────────

function corsHeaders(req: IncomingMessage): Record<string, string> {
  if (CORS_ORIGINS.length === 0) return {};
  const origin = req.headers["origin"];
  const raw = Array.isArray(origin) ? origin[0] : origin;
  if (!raw || !CORS_ORIGINS.includes(raw)) return {};
  return {
    "Access-Control-Allow-Origin": raw,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  };
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    ...corsHeaders(req),
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

// ─── Request handling ────────────────────────────────────────────────

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${BIND_HOST}:${PORT}`);
  const path = url.pathname;

  // Both probes are unauthenticated so orchestrators and load balancers can reach
  // them without holding the shared token. Neither exposes configuration values.
  //
  //   GET /health   liveness.  Always 200 while the adapter answers HTTP. Checks
  //                            nothing, so a MongoDB outage cannot cause a restart
  //                            loop.
  //   GET /ready    readiness. 200 when MongoDB answers a ping, 503 when it does
  //                            not, so a load balancer stops routing here.
  if (req.method === "GET" && path === "/health") {
    sendJson(req, res, 200, {
      status: "healthy",
      service: "cerberus-mcp-mongodb",
      version: MCP_SERVER_VERSION,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (req.method === "GET" && path === "/ready") {
    const startedAt = Date.now();
    let ready = false;
    let detail: string | undefined;

    try {
      const result = (await tools[MCP_TOOL_NAMES.HEALTH_CHECK]?.({})) as
        | { connected?: boolean; healthy?: boolean }
        | undefined;
      ready = result?.connected !== false && result?.healthy !== false;
      if (!ready) detail = "MongoDB is not reachable";
    } catch (error) {
      detail = error instanceof Error ? error.message : "unknown error";
    }

    sendJson(req, res, ready ? 200 : 503, {
      status: ready ? "ready" : "not_ready",
      ready,
      service: "cerberus-mcp-mongodb",
      version: MCP_SERVER_VERSION,
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      ...(detail ? { detail } : {}),
    });
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(req, res, 401, {
      success: false,
      error: "Authentication required.",
      code: "UNAUTHENTICATED",
    });
    return;
  }

  if (req.method === "POST" && path.startsWith("/tools/")) {
    const toolName = path.slice("/tools/".length);
    const handler = tools[toolName];

    if (!handler) {
      sendJson(req, res, 404, {
        success: false,
        error: `Unknown tool: ${toolName}`,
        availableTools: Object.keys(tools),
      });
      return;
    }

    try {
      const parsed = await parseBody(req, MAX_BODY_BYTES);
      if (!parsed.ok) {
        sendJson(
          req,
          res,
          parsed.status,
          { success: false, error: parsed.message, code: parsed.code },
          // An oversized body was not drained, so the connection cannot be
          // reused. Saying so closes it rather than leaving the client waiting.
          parsed.status === 413 ? { Connection: "close" } : {},
        );
        return;
      }

      const result = await handler(parsed.body);
      sendJson(req, res, 200, {
        ...(result as Record<string, unknown>),
        correlationId: randomUUID(),
      });
    } catch (error) {
      const isArgumentError = error instanceof ToolArgumentError;
      const message =
        error instanceof Error ? error.message : "Internal MCP tool error";
      sendJson(req, res, isArgumentError ? 400 : 500, {
        success: false,
        error: message,
      });
    }
    return;
  }

  if (req.method === "GET" && path === "/tools") {
    sendJson(req, res, 200, { success: true, tools: Object.keys(tools) });
    return;
  }

  sendJson(req, res, 404, {
    success: false,
    error: `Not found: ${req.method} ${path}`,
    endpoints: {
      "GET /health": "MongoDB health check",
      "GET /tools": "List available MCP tools",
      "POST /tools/:toolName": "Invoke an MCP tool",
    },
  });
}

// ─── Bootstrap ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  await store.connect();
  console.error("[MCP-HTTP] MongoDB connection established");

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error("[MCP-HTTP] Unhandled request error:", error);
      if (!res.headersSent) {
        sendJson(req, res, 500, { success: false, error: "Internal error" });
      } else {
        res.end();
      }
    });
  });

  server.listen(PORT, BIND_HOST, () => {
    console.error(
      `[MCP-HTTP] listening on ${BIND_HOST}:${PORT} ` +
        `(auth=${DEV_MODE ? "DISABLED (dev mode)" : "bearer token"}, ` +
        `previousToken=${MCP_TOKEN_PREVIOUS ? "accepted" : "none"}, ` +
        `maxBody=${MAX_BODY_BYTES}B)`,
    );
    console.error(`[MCP-HTTP] tools: ${Object.keys(tools).join(", ")}`);
    if (process.send) process.send({ ready: true, port: PORT });
  });

  const shutdown = async () => {
    console.error("[MCP-HTTP] shutting down...");
    server.close();
    await store.disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[MCP-HTTP] Fatal startup error:", err);
  process.exit(1);
});

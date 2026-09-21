/**
 * MCP Server HTTP Adapter — Cloud Run Sidecar Transport
 *
 * The existing MCP server (server.ts) uses StdioServerTransport for
 * local agent-to-tool communication. This adapter wraps the same
 * MongoStore and tool definitions behind a lightweight HTTP server
 * so the Hono API can address the MCP tools over localhost:3001
 * inside the same Cloud Run container.
 *
 * Zero business logic duplication — all database operations flow
 * through the existing MongoStore class.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MongoStore } from "./mongo-client.js";

// ─── Configuration ───────────────────────────────────────────────────

const PORT = parseInt(process.env["MCP_PORT"] ?? "3001", 10);
const store = new MongoStore();

// ─── Tool Router ─────────────────────────────────────────────────────

type ToolHandler = (body: Record<string, unknown>) => Promise<unknown>;

const tools: Record<string, ToolHandler> = {
  store_test_suite: async (body) => {
    const suite = body["suite"];
    if (!suite) throw new Error("Missing required parameter: suite");
    const docId = await store.storeTestSuite(suite as Record<string, unknown>);
    return { success: true, mongoDocumentId: docId };
  },

  get_test_suite: async (body) => {
    const suiteId = body["suiteId"] as string;
    if (!suiteId) throw new Error("Missing required parameter: suiteId");
    const suite = await store.getTestSuite(suiteId);
    return { success: true, data: suite };
  },

  create_session: async (body) => {
    const docId = await store.createSession(body);
    return { success: true, mongoDocumentId: docId };
  },

  update_session_code: async (body) => {
    const sessionId = body["sessionId"] as string;
    const code = body["code"] as string;
    if (!sessionId) throw new Error("Missing required parameter: sessionId");
    await store.updateSession(sessionId, { submittedCode: code });
    return { success: true };
  },

  delete_session: async (body) => {
    const sessionId = body["sessionId"] as string;
    if (!sessionId) throw new Error("Missing required parameter: sessionId");
    const deleted = await store.deleteSession(sessionId);
    return { success: true, deleted };
  },

  append_micro_event: async (body) => {
    const event = body["event"];
    if (!event) throw new Error("Missing required parameter: event");
    const count = await store.ingestMicroEvents([event as Record<string, unknown>]);
    return { success: true, processedCount: count };
  },

  ingest_micro_events: async (body) => {
    const events = body["events"] as Record<string, unknown>[];
    if (!events || !Array.isArray(events))
      throw new Error("Missing required parameter: events (array)");
    const count = await store.ingestMicroEvents(events);
    return { success: true, processedCount: count };
  },

  store_suspicion_report: async (body) => {
    const report = body["report"];
    if (!report) throw new Error("Missing required parameter: report");
    const docId = await store.storeSuspicionReport(
      report as Record<string, unknown>
    );
    return { success: true, mongoDocumentId: docId };
  },

  update_session_counts: async (body) => {
    const sessionId = body["sessionId"] as string;
    const counts = body["counts"] as Record<string, unknown>;
    if (!sessionId) throw new Error("Missing required parameter: sessionId");
    if (!counts || typeof counts !== "object")
      throw new Error("Missing required parameter: counts");
    await store.updateSessionCounts(sessionId, {
      eventCount: (counts.eventCount as number) ?? 0,
      pasteCount: counts.pasteCount as number | undefined,
      tabSwitchCount: counts.tabSwitchCount as number | undefined,
      copyAttemptCount: counts.copyAttemptCount as number | undefined,
      peakRiskScore: counts.peakRiskScore as number | undefined,
      status: counts.status as string | undefined,
    });
    return { success: true };
  },

  set_session_status: async (body) => {
    const sessionId = body["sessionId"] as string;
    const status = body["status"] as string;
    if (!sessionId) throw new Error("Missing required parameter: sessionId");
    if (!status || !["active", "locked", "terminated"].includes(status))
      throw new Error("Invalid status. Must be: active, locked, or terminated");
    await store.setSessionStatus(sessionId, status);
    return { success: true, status };
  },

  get_session_review: async (body) => {
    const sessionId = body["sessionId"] as string;
    if (!sessionId) throw new Error("Missing required parameter: sessionId");
    const [session, events, reports] = await Promise.all([
      store.getSession(sessionId),
      store.getSessionEvents(sessionId),
      store.getSuspicionReports(sessionId),
    ]);
    return {
      success: true,
      session,
      events,
      suspicionReports: reports,
    };
  },

  get_candidate_report: async (body) => {
    const candidateId = body["candidateId"] as string;
    if (!candidateId) throw new Error("Missing required parameter: candidateId");
    const reports = await store.getCandidateReport(candidateId);
    return { success: true, reports };
  },

  list_sessions: async () => {
    const sessions = await store.listSessions();
    return { success: true, data: sessions };
  },

  health_check: async () => {
    const isHealthy = await store.ping();
    return {
      connected: store.isConnected(),
      healthy: isHealthy,
      timestamp: new Date().toISOString(),
    };
  },
};

// ─── HTTP Server ─────────────────────────────────────────────────────

async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload));
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // CORS preflight
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  // Health endpoint
  if (req.method === "GET" && path === "/health") {
    const result = await tools["health_check"]?.({});
    sendJson(res, 200, result);
    return;
  }

  // POST /tools/:toolName
  if (req.method === "POST" && path.startsWith("/tools/")) {
    const toolName = path.replace("/tools/", "");
    const handler = tools[toolName];

    if (!handler) {
      sendJson(res, 404, {
        success: false,
        error: `Unknown tool: ${toolName}`,
        availableTools: Object.keys(tools),
      });
      return;
    }

    try {
      const body = await parseBody(req);
      const result = await handler(body);
      sendJson(res, 200, { ...(result as Record<string, unknown>), correlationId: crypto.randomUUID() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal MCP tool error";
      sendJson(res, 500, { success: false, error: message });
    }
    return;
  }

  // List available tools
  if (req.method === "GET" && path === "/tools") {
    sendJson(res, 200, {
      success: true,
      tools: Object.keys(tools),
    });
    return;
  }

  // Fallback
  sendJson(res, 404, {
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
  console.error(`[MCP-HTTP] MongoDB Atlas connection established`);

  const server = createServer(handleRequest);

  server.listen(PORT, () => {
    console.error(`[MCP-HTTP] Gorilla MCP HTTP Adapter listening on port ${PORT}`);
    console.error(`[MCP-HTTP] Available tools: ${Object.keys(tools).join(", ")}`);

    // Signal ready to parent process
    if (process.send) {
      process.send({ ready: true, port: PORT });
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.error("[MCP-HTTP] Shutting down...");
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
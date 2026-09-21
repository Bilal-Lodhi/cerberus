/**
 * Gorilla MCP Server — MongoDB Atlas Track
 * Model Context Protocol compliant server for the Gorilla Agent Ecosystem.
 *
 * Exposes the following tools to agent workflows:
 *   - store_test_suite       — Persist a generated assessment suite
 *   - get_test_suite         — Retrieve a suite by ID
 *   - create_session         — Initialize an assessment session
 *   - ingest_micro_events    — Batch ingest behavioral micro-events
 *   - store_suspicion_report — Persist an intent guardian suspicion payload
 *   - get_session_review     — Full session review with timeline & flags
 *   - get_candidate_report   — Aggregate candidate history
 *   - health_check           — Database connectivity verification
 *
 * Resources:
 *   - mongo://test-suites/{suiteId}       — JSON view of a test suite
 *   - mongo://sessions/{sessionId}/review  — Analytical review resource
 *
 * Usage:
 *   npx @modelcontextprotocol/inspector node dist/server.js
 *   (or configure in Claude Desktop / Agent Builder as an MCP source)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type CallToolRequest,
  type ListToolsRequest,
  type ListResourcesRequest,
  type ReadResourceRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { MongoStore, type MongoConfig } from "./mongo-client.js";

// ─── Server Initialization ─────────────────────────────────────────

const mongoConfig: Partial<MongoConfig> = {
  uri: process.env["MONGODB_URI"] ?? "mongodb://localhost:27017",
  databaseName: process.env["MONGODB_DATABASE"] ?? "gorilla_agents",
};

const store = new MongoStore(mongoConfig);

const server = new Server(
  {
    name: "gorilla-mcp-mongodb",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      logging: {},
    },
  }
);

// ─── Connect to MongoDB on startup ─────────────────────────────────

await store.connect();
console.error("[MCP] MongoDB Atlas connection established");

// ─── Tool Definitions ──────────────────────────────────────────────

const TOOLS = {
  STORE_TEST_SUITE: {
    name: "store_test_suite",
    description:
      "Persist a complete GeneratedTestSuite to MongoDB Atlas. Used by the Orchestrator Agent after Gemini generates an assessment suite.",
    inputSchema: {
      type: "object",
      properties: {
        suite: {
          type: "object",
          description: "The GeneratedTestSuite JSON from Gemini",
        },
      },
      required: ["suite"],
    },
  },

  GET_TEST_SUITE: {
    name: "get_test_suite",
    description: "Retrieve a persisted assessment suite by its suiteId.",
    inputSchema: {
      type: "object",
      properties: {
        suiteId: { type: "string", description: "UUIDv4 suite identifier" },
      },
      required: ["suiteId"],
    },
  },

  CREATE_SESSION: {
    name: "create_session",
    description: "Initialize a new candidate assessment session in MongoDB.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        candidateId: { type: "string" },
        assessmentId: { type: "string" },
        problemId: { type: "string" },
      },
      required: ["sessionId", "candidateId", "assessmentId"],
    },
  },

  DELETE_SESSION: {
    name: "delete_session",
    description: "Permanently delete a session and all its associated micro-events and suspicion reports from MongoDB.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The session ID to delete" },
      },
      required: ["sessionId"],
    },
  },

  INGEST_MICRO_EVENTS: {
    name: "ingest_micro_events",
    description:
      "Batch ingest behavioral micro-events (keystrokes, paste triggers, tab switches, etc.) from the assessment frontend.",
    inputSchema: {
      type: "object",
      properties: {
        events: {
          type: "array",
          items: { type: "object" },
          description: "Array of MicroEvent objects",
        },
      },
      required: ["events"],
    },
  },

  STORE_SUSPICION_REPORT: {
    name: "store_suspicion_report",
    description:
      "Persist an Intent Guardian suspicion payload. Called after Gemini completes its cheating/plagiarism analysis.",
    inputSchema: {
      type: "object",
      properties: {
        report: { type: "object" },
      },
      required: ["report"],
    },
  },

  GET_SESSION_REVIEW: {
    name: "get_session_review",
    description:
      "Fetch the complete analytical review data for a session including all events, suspicion flags, and the submitted code.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },

  GET_CANDIDATE_REPORT: {
    name: "get_candidate_report",
    description: "Aggregate all suspicion reports for a specific candidate across all sessions.",
    inputSchema: {
      type: "object",
      properties: {
        candidateId: { type: "string" },
      },
      required: ["candidateId"],
    },
  },

  HEALTH_CHECK: {
    name: "health_check",
    description: "Verify MongoDB connectivity and return collection stats.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
};

// ─── Tool Handler ──────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async (_request: ListToolsRequest) => {
  return {
    tools: Object.values(TOOLS).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "store_test_suite": {
        const suiteObj = args as Record<string, unknown>;
        const suite = suiteObj["suite"];
        if (!suite) throw new Error("Missing required parameter: suite");
        const docId = await store.storeTestSuite(suite as Record<string, unknown>);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, mongoDocumentId: docId, correlationId: crypto.randomUUID() }) }],
        };
      }

      case "get_test_suite": {
        const suiteObj = args as Record<string, unknown>;
        const suiteId = suiteObj["suiteId"] as string;
        if (!suiteId) throw new Error("Missing required parameter: suiteId");
        const suite = await store.getTestSuite(suiteId);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, data: suite, correlationId: crypto.randomUUID() }) }],
        };
      }

      case "create_session": {
        const sessionObj = args as Record<string, unknown>;
        const docId = await store.createSession(sessionObj);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, mongoDocumentId: docId, correlationId: crypto.randomUUID() }) }],
        };
      }

      case "delete_session": {
        const deleteObj = args as Record<string, unknown>;
        const sessionId = deleteObj["sessionId"] as string;
        if (!sessionId) throw new Error("Missing required parameter: sessionId");
        const deleted = await store.deleteSession(sessionId);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, deleted, correlationId: crypto.randomUUID() }) }],
        };
      }

      case "ingest_micro_events": {
        const eventsObj = args as Record<string, unknown>;
        const events = eventsObj["events"] as Record<string, unknown>[];
        if (!events) throw new Error("Missing required parameter: events");
        const count = await store.ingestMicroEvents(events);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, processedCount: count, correlationId: crypto.randomUUID() }) }],
        };
      }

      case "store_suspicion_report": {
        const reportObj = args as Record<string, unknown>;
        const report = reportObj["report"];
        if (!report) throw new Error("Missing required parameter: report");
        const docId = await store.storeSuspicionReport(report as Record<string, unknown>);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, mongoDocumentId: docId, correlationId: crypto.randomUUID() }) }],
        };
      }

      case "get_session_review": {
        const sessionObj = args as Record<string, unknown>;
        const sessionId = sessionObj["sessionId"] as string;
        if (!sessionId) throw new Error("Missing required parameter: sessionId");
        const [session, events, reports] = await Promise.all([
          store.getSession(sessionId),
          store.getSessionEvents(sessionId),
          store.getSuspicionReports(sessionId),
        ]);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, session, events, suspicionReports: reports, correlationId: crypto.randomUUID() }) }],
        };
      }

      case "get_candidate_report": {
        const candidateObj = args as Record<string, unknown>;
        const candidateId = candidateObj["candidateId"] as string;
        if (!candidateId) throw new Error("Missing required parameter: candidateId");
        const reports = await store.getCandidateReport(candidateId);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, reports, correlationId: crypto.randomUUID() }) }],
        };
      }

      case "health_check": {
        const isHealthy = await store.ping();
        return {
          content: [{ type: "text", text: JSON.stringify({ success: isHealthy, connected: store.isConnected(), timestamp: new Date().toISOString(), correlationId: crypto.randomUUID() }) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown MCP tool error";
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: message }) }],
      isError: true,
    };
  }
});

// ─── Resource Definitions ──────────────────────────────────────────

const RESOURCES = [
  {
    uri: "mongo://health",
    name: "MongoDB Health Status",
    description: "Current MongoDB Atlas connectivity status",
    mimeType: "application/json",
  },
];

server.setRequestHandler(ListResourcesRequestSchema, async (_request: ListResourcesRequest) => {
  return { resources: RESOURCES };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request: ReadResourceRequest) => {
  const { uri } = request.params;

  if (uri === "mongo://health") {
    const isHealthy = await store.ping();
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({
            connected: store.isConnected(),
            healthy: isHealthy,
            timestamp: new Date().toISOString(),
          }),
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// ─── Transport ─────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

console.error("[MCP] Gorilla MongoDB MCP Server running via stdio");

// ─── Graceful Shutdown ─────────────────────────────────────────────

process.on("SIGINT", async () => {
  console.error("[MCP] Shutting down...");
  await store.disconnect();
  await server.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await store.disconnect();
  await server.close();
  process.exit(0);
});
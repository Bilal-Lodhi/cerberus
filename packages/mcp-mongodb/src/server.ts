/**
 * Cerberus MCP server — stdio transport.
 *
 * Exposes the Cerberus MongoDB persistence layer as Model Context Protocol
 * tools and resources for MCP-capable agent hosts.
 *
 * Usage:
 *   npx @modelcontextprotocol/inspector node dist/server.js
 *
 * The HTTP sidecar (http-adapter.ts) exposes the identical tool registry and
 * is what the Cerberus API talks to.
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
import { randomUUID } from "node:crypto";

import { MongoStore, type MongoConfig } from "./mongo-client.js";
import { createToolRegistry, TOOL_DEFINITIONS } from "./tools.js";
import {
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_TOOL_NAMES,
} from "./tool-names.js";

// ─── Store ─────────────────────────────────────────────────────────

const mongoConfig: Partial<MongoConfig> = {
  uri: process.env["MONGODB_URI"] ?? "mongodb://localhost:27017",
  databaseName: process.env["MONGODB_DATABASE"],
};

const store = new MongoStore(mongoConfig);
const toolHandlers = createToolRegistry(store);

// ─── Server ────────────────────────────────────────────────────────

const server = new Server(
  { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
  { capabilities: { tools: {}, resources: {}, logging: {} } },
);

await store.connect();
console.error("[MCP] MongoDB connection established");

server.setRequestHandler(ListToolsRequestSchema, async (_request: ListToolsRequest) => ({
  tools: Object.values(TOOL_DEFINITIONS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const { name, arguments: args } = request.params;

  try {
    const handler = toolHandlers[name as keyof typeof toolHandlers];
    if (!handler) throw new Error(`Unknown tool: ${name}`);

    const result = await handler((args ?? {}) as Record<string, unknown>);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...(result as object), correlationId: randomUUID() }),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown MCP tool error";
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: message }) }],
      isError: true,
    };
  }
});

// ─── Resources ─────────────────────────────────────────────────────

const RESOURCES = [
  {
    uri: "mongo://health",
    name: "MongoDB Health Status",
    description: "Current MongoDB connectivity status",
    mimeType: "application/json",
  },
];

server.setRequestHandler(ListResourcesRequestSchema, async (_request: ListResourcesRequest) => ({
  resources: RESOURCES,
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request: ReadResourceRequest) => {
  const { uri } = request.params;

  if (uri === "mongo://health") {
    const healthy = await store.ping();
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({
            connected: store.isConnected(),
            healthy,
            collections: store.collectionNames,
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
console.error(`[MCP] ${MCP_SERVER_NAME} running via stdio`);

// ─── Graceful shutdown ─────────────────────────────────────────────

const shutdown = async () => {
  console.error("[MCP] shutting down...");
  await store.disconnect();
  await server.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { MCP_TOOL_NAMES };

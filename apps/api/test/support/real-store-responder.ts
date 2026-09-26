/**
 * A responder backed by a **real `MongoStore`**, for integration tests.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 *
 * The unit suite drives the real routes against an in-process double, and the contract
 * suite verifies that double against a real store. Neither one exercises the *whole* path
 * at once: real route → real tool registry → real MongoDB driver → real documents.
 *
 * This closes that gap without a network hop. It reuses the **real**
 * `createToolRegistry()`, backed by a real `MongoStore` on a disposable database, and
 * presents it through the same `fetch`-stub seam the unit tests use. So an integration test
 * is written exactly like a unit test — `app.request(...)` — and every layer below the HTTP
 * boundary is production code.
 *
 * The error mapping mirrors `http-adapter.ts` deliberately: a route that handles the
 * adapter's 404/400/409/500 must see the same statuses here, or the integration test would
 * be asserting behaviour the real adapter does not have.
 */

import { randomUUID } from "node:crypto";

import type { MongoStore } from "../../../../packages/mcp-mongodb/src/mongo-client.js";
import {
  ReferenceCorpusLimitToolError,
  ToolArgumentError,
  createToolRegistry,
  type ToolHandler,
} from "../../../../packages/mcp-mongodb/src/tools.js";

export type RealStoreResponder = (
  tool: string,
  body: Record<string, unknown>,
) => Promise<Response>;

/**
 * Wraps a connected `MongoStore` in a responder suitable for `installFetchStub`.
 *
 * The store must already be connected. Each call is a real database round trip.
 */
export function realStoreResponder(store: MongoStore): RealStoreResponder {
  const registry = createToolRegistry(store);

  return async (tool, body) => {
    const handler = registry[tool as keyof typeof registry] as ToolHandler | undefined;

    if (!handler) {
      // The real adapter answers 404 rather than falling through to a plausible success.
      return Response.json(
        {
          success: false,
          error: `Unknown tool: ${tool}`,
          availableTools: Object.keys(registry),
        },
        { status: 404 },
      );
    }

    try {
      const result = await handler(body);
      return Response.json({
        ...(result as Record<string, unknown>),
        correlationId: randomUUID(),
      });
    } catch (error) {
      const isArgumentError = error instanceof ToolArgumentError;
      const isLimitError = error instanceof ReferenceCorpusLimitToolError;
      return Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Internal MCP tool error",
          ...(isLimitError
            ? { code: error.code, limit: error.limit, count: error.count }
            : {}),
        },
        { status: isArgumentError ? 400 : isLimitError ? 409 : 500 },
      );
    }
  };
}

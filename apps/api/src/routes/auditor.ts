/**
 * Route: POST /api/v1/auditor/query
 *
 * Natural-language querying over the persisted session records. The model
 * translates the operator's question into a MongoDB aggregation pipeline,
 * which is then applied in-process against records fetched through the MCP
 * persistence layer.
 *
 * The pipeline is NEVER forwarded to MongoDB verbatim: only a small, explicit
 * subset of stages ($match, $sort, $limit) is interpreted, so a model cannot
 * induce an arbitrary database operation.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { getAIProvider } from "../ai/provider.js";
import { callMcpTool, MCP_TOOL_NAMES } from "../services/mcp-client.js";

interface SessionRecord {
  [key: string]: unknown;
  sessionId?: string;
  employeeId?: string;
  overallRiskScore?: number;
}

export function createAuditorRouter(config: AppConfig): Hono {
  const auditorRouter = new Hono();

  async function listSessions(requestId: string): Promise<SessionRecord[]> {
    const result = await callMcpTool<{ data?: unknown }>(
      config,
      MCP_TOOL_NAMES.LIST_SESSIONS,
      {},
      { requestId, timeoutMs: 5_000 },
    );
    if (!result.ok) return [];
    return Array.isArray(result.data?.data)
      ? (result.data?.data as SessionRecord[])
      : [];
  }

  auditorRouter.post("/query", async (c) => {
    const requestId = randomUUID();

    let body: { question?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    if (typeof body.question !== "string" || !body.question.trim()) {
      return c.json(
        { success: false, error: "Field 'question' must be a non-empty string" },
        400,
      );
    }

    try {
      const provider = getAIProvider(config);
      const pipeline = await provider.toMongoPipeline(body.question);
      const records = applySafePipeline(await listSessions(requestId), pipeline);
      const summary = await provider.summarizeSessionRecords(body.question, records);

      return c.json({ success: true, summary, raw: records });
    } catch (error) {
      console.error(
        `[auditor] [${requestId}] query failed:`,
        error instanceof Error ? error.message : String(error),
      );
      return c.json(
        {
          success: false,
          error: "Auditor query failed.",
          code: "AUDITOR_QUERY_FAILED",
          correlationId: requestId,
        },
        500,
      );
    }
  });

  return auditorRouter;
}

/**
 * Applies a whitelisted subset of aggregation stages in-process.
 * Unknown stages are ignored rather than executed.
 */
export function applySafePipeline(
  records: SessionRecord[],
  pipeline: unknown,
): SessionRecord[] {
  if (!Array.isArray(pipeline)) return records;

  let result = [...records];

  for (const stage of pipeline) {
    if (!stage || typeof stage !== "object") continue;

    const match = (stage as { $match?: Record<string, unknown> }).$match;
    if (match && typeof match === "object") {
      result = result.filter((record) =>
        Object.entries(match).every(([key, value]) => {
          const actual = record[key];
          if (value && typeof value === "object") {
            const operators = value as Record<string, unknown>;
            return Object.entries(operators).every(([operator, expected]) => {
              switch (operator) {
                case "$gt":
                  return typeof actual === "number" && actual > Number(expected);
                case "$gte":
                  return typeof actual === "number" && actual >= Number(expected);
                case "$lt":
                  return typeof actual === "number" && actual < Number(expected);
                case "$lte":
                  return typeof actual === "number" && actual <= Number(expected);
                case "$ne":
                  return actual !== expected;
                default:
                  return actual === expected;
              }
            });
          }
          return actual === value;
        }),
      );
    }

    const sort = (stage as { $sort?: Record<string, number> }).$sort;
    if (sort) {
      const [field, direction] = Object.entries(sort)[0] ?? [];
      if (field) {
        // MongoDB convention: -1 is descending, 1 is ascending.
        const sign = Number(direction) < 0 ? -1 : 1;
        result.sort((a, b) => (Number(a[field] ?? 0) - Number(b[field] ?? 0)) * sign);
      }
    }

    const limit = (stage as { $limit?: number }).$limit;
    if (typeof limit === "number" && limit >= 0) {
      result = result.slice(0, limit);
    }
  }

  return result;
}

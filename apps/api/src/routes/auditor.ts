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
import { LOG_EVENTS, logger } from "../observability/logger.js";
import { currentRequestId } from "../observability/request-context.js";
import { getAIProvider } from "../ai/provider.js";
import { callMcpTool, MCP_TOOL_NAMES } from "../services/mcp-client.js";

interface SessionRecord {
  [key: string]: unknown;
  sessionId?: string;
  employeeId?: string;
  overallRiskScore?: number;
}

/**
 * Maximum accepted length of the natural-language audit question, in
 * characters.
 *
 * The question is sent to a paid provider twice (once to build the pipeline,
 * once to summarise the results), so it is bounded before any inference is
 * spent. The global body limit bounds the request as a whole.
 */
export const MAX_QUESTION_CHARS = 2_000;

/**
 * Hard ceiling on the number of records the auditor will hand to the model or
 * return to the caller, whatever the model's pipeline asks for.
 *
 * The model's `$limit` is a suggestion, not a control: `applySafePipeline`
 * ignores unknown stages but a pipeline with no `$limit` at all would otherwise
 * pass every session through. This cap is applied after the pipeline runs.
 */
export const MAX_AUDITOR_RESULTS = 200;

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
    const requestId = currentRequestId();

    let body: { question?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { success: false, error: "Invalid JSON body", correlationId: requestId },
        400,
      );
    }

    if (typeof body.question !== "string" || !body.question.trim()) {
      return c.json(
        {
          success: false,
          error: "Field 'question' must be a non-empty string",
          correlationId: requestId,
        },
        400,
      );
    }

    if (body.question.length > MAX_QUESTION_CHARS) {
      return c.json(
        {
          success: false,
          error: `Field 'question' must be at most ${MAX_QUESTION_CHARS} characters (got ${body.question.length}).`,
          code: "QUESTION_TOO_LONG",
          maxChars: MAX_QUESTION_CHARS,
          correlationId: requestId,
        },
        400,
      );
    }

    try {
      const provider = getAIProvider(config);
      const pipeline = await provider.toMongoPipeline(body.question);
      const matched = applySafePipeline(await listSessions(requestId), pipeline);
      // The model's own `$limit` is a suggestion; this ceiling is the control,
      // so a pipeline without one cannot pass every session to the model.
      const records = matched.slice(0, MAX_AUDITOR_RESULTS);
      const summary = await provider.summarizeSessionRecords(body.question, records);

      return c.json({ success: true, summary, raw: records });
    } catch (error) {
      logger.failure(LOG_EVENTS.AUDITOR_FAILURE, error, { dependency: "provider" });
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

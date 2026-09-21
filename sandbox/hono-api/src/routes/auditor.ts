import { Hono } from "hono";
import { generateJsonResponse, generateTextResponse, initializeClient } from "../agents/openai-client.js";
import { loadConfig } from "../config.js";
import * as crypto from "node:crypto";

const auditorRouter = new Hono();
const config = loadConfig();
const MCP_BASE = process.env["MCP_URL"] ?? config.mcp.serverEndpoint;
const MCP_TIMEOUT_MS = 5_000;

interface SessionRecord {
  [key: string]: unknown;
  sessionId?: string;
  employeeId?: string;
  overallRiskScore?: number;
}

async function mcpListSessions(requestId: string): Promise<SessionRecord[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
  try {
    const response = await fetch(`${MCP_BASE}/tools/list_sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: unknown };
    return Array.isArray(body.data) ? body.data as SessionRecord[] : [];
  } catch (error) {
    console.error(`[Auditor MCP] [${requestId}] list_sessions failed:`, error);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function applySafePipeline(records: SessionRecord[], pipeline: unknown): SessionRecord[] {
  if (!Array.isArray(pipeline)) return records;
  let result = [...records];
  for (const stage of pipeline) {
    if (!stage || typeof stage !== "object") continue;
    const match = (stage as { $match?: Record<string, unknown> }).$match;
    if (match && typeof match === "object") {
      result = result.filter((record) => Object.entries(match).every(([key, value]) => {
        const actual = record[key];
        if (value && typeof value === "object") {
          const operators = value as Record<string, unknown>;
          return Object.entries(operators).every(([operator, expected]) =>
            operator === "$gt" ? typeof actual === "number" && actual > Number(expected) :
            operator === "$gte" ? typeof actual === "number" && actual >= Number(expected) :
            operator === "$lt" ? typeof actual === "number" && actual < Number(expected) :
            operator === "$lte" ? typeof actual === "number" && actual <= Number(expected) : actual === expected
          );
        }
        return actual === value;
      }));
    }
    const sort = (stage as { $sort?: Record<string, number> }).$sort;
    if (sort) {
      const [field, direction] = Object.entries(sort)[0] ?? [];
      if (field) result.sort((a, b) => (Number(b[field] ?? 0) - Number(a[field] ?? 0)) * Number(direction));
    }
    const limit = (stage as { $limit?: number }).$limit;
    if (typeof limit === "number") result = result.slice(0, limit);
  }
  return result;
}

auditorRouter.post("/query", async (c) => {
  const requestId = crypto.randomUUID();
  let body: { question?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ success: false, error: "Invalid JSON body" }, 400); }
  if (typeof body.question !== "string" || !body.question.trim()) {
    return c.json({ success: false, error: "Field 'question' must be a non-empty string" }, 400);
  }
  try {
    initializeClient(config);
    const pipelineResponse = await generateJsonResponse(
      "You are a MongoDB expert. Convert the question into a MongoDB aggregation pipeline. Return JSON with a pipeline array of stages for the sessions collection.",
      body.question,
      config,
      { temperature: 0, maxTokens: 2000 }
    );
    const parsed = JSON.parse(pipelineResponse) as { pipeline?: unknown };
    const results = applySafePipeline(await mcpListSessions(requestId), parsed.pipeline);
    const summary = await generateTextResponse(
      "Summarize these session records in plain English, highlighting the most important risks, employees, and actions taken. Max 3 paragraphs.",
      JSON.stringify({ question: body.question, results }),
      config,
      { temperature: 0.2, maxTokens: 1200 }
    );
    return c.json({ success: true, summary, raw: results });
  } catch (error) {
    console.error(`[Auditor Route] [${requestId}] query failed:`, error);
    return c.json({ success: false, error: "Auditor query failed", correlationId: requestId }, 500);
  }
});

export default auditorRouter;

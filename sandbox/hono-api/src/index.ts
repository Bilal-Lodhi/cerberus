/**
 * Cerberus FinSec — Hono API Entry Point
 * OpenAI Build Week 2026 — Agentic Coding Track
 *
 * This serverless-first Hono application runs on Google Cloud Run and
 * exposes three core agent capabilities:
 *
 *   1. POST /api/v1/generate         — Autonomous Test Suite Generator
 *   2. POST /api/v1/guardian/ingest  — Real-Time Intent & Plagiarism Guardian
 *   3. GET  /api/v1/sessions/:id/review — Interactive Analytical Review Log
 *
 * Architecture:
 *   Hono (routing) → GeminiClient (OpenAI SDK → GPT-5.6)
 *                  → MCP Server (MongoDB Atlas persistence layer)
 *
 * Authentication: OPENAI_API_KEY environment variable.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";

import { healthRouter } from "./routes/health.js";
import { generateRouter } from "./routes/generate.js";
import { guardianRouter } from "./routes/guardian.js";
import { reviewRouter } from "./routes/review.js";
import { identityRouter } from "./routes/identity.js";
import auditorRoutes from "./routes/auditor.js";
import { loadConfig } from "./config.js";

// ─── Configuration ─────────────────────────────────────────────────

const config = loadConfig();

// ─── Application ───────────────────────────────────────────────────

const app = new Hono();

// ─── Global Middleware ─────────────────────────────────────────────

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-API-Key", "X-Generation-Request-Id", "X-Session-Token"],
  exposeHeaders: ["X-Correlation-Id", "X-RateLimit-Remaining"],
  maxAge: 86400,
}));

app.use("*", logger());
app.use("*", prettyJSON());

// ─── Request ID & Correlation Middleware ───────────────────────────

app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID();
  c.res.headers.set("X-Correlation-Id", requestId);
  await next();
});

// ─── Route Mounting ────────────────────────────────────────────────

app.route("/", healthRouter);
app.route("/health", healthRouter);
app.route("/api/v1/generate", generateRouter);
app.route("/api/v1/guardian", guardianRouter);
app.route("/api/v1/sessions", reviewRouter);
app.route("/api/v1/identity", identityRouter);
app.route("/api/v1/auditor", auditorRoutes);

// ─── 404 Handler ───────────────────────────────────────────────────

app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: `Route not found: ${c.req.method} ${c.req.path}`,
      availableEndpoints: [
        "GET  /health",
        "POST /api/v1/identity/set",
        "GET  /api/v1/identity/me",
        "POST /api/v1/generate",
        "POST /api/v1/guardian/ingest",
        "GET  /api/v1/guardian/sessions/:sessionId",
        "GET  /api/v1/sessions",
        "GET  /api/v1/sessions/:sessionId",
      ],
    },
    404
  );
});

// ─── Global Error Handler ──────────────────────────────────────────

app.onError((err, c) => {
  console.error("[UnhandledError]", err);
  return c.json(
    {
      success: false,
      error: err.message || "Internal server error",
      correlationId: c.res.headers.get("X-Correlation-Id") ?? "unknown",
    },
    500
  );
});

// ─── Server Bootstrap ──────────────────────────────────────────────

export default {
  port: config.port,
  fetch: app.fetch,
};

// When running directly (not imported as module)
// Cloud Run auto-detects the fetch export; the listen() below
// is for local development.
const isMainModule = process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("index.ts");

if (isMainModule) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  🔒 Cerberus FinSec — Insider Threat & Data Exfiltration    ║
║  Guardian v1.0.0 | OpenAI Build Week 2026                    ║
║  GPT-5.6 | MongoDB Atlas                                     ║
║──────────────────────────────────────────────────────────────║
║  Health:  http://localhost:${config.port}/health             ║
║  API v1:  http://localhost:${config.port}/api/v1/            ║
╚══════════════════════════════════════════════════════════════╝
  `);

  // Use @hono/node-server for local dev if available, otherwise
  // output instruction to use wrangler or cloud-run dev.
  try {
    const { serve } = await import("@hono/node-server");
    serve({ fetch: app.fetch, port: config.port });
    console.log(`Server listening on port ${config.port}`);
  } catch {
    console.log(
      "To run locally, install @hono/node-server or use: npx wrangler dev"
    );
  }
}

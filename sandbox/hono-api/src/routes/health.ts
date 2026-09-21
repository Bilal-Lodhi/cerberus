/**
 * Health check and capability discovery endpoint.
 * Provides OpenAPI-aligned metadata for the agent ecosystem.
 */

import { Hono } from "hono";
import { toISOStringLocal } from "../utils/time.js";

const healthRouter = new Hono();

healthRouter.get("/", (c) => {
  return c.json({
    status: "healthy",
    service: "cerberus-fintech-guardian",
    version: "1.0.0",
    platform: "Google Cloud Run",
    modelProvider: "GPT-5.6 (OpenAI SDK)",
    mcpTrack: "MongoDB",
    features: {
      autonomousTestGeneration: "/api/v1/generate",
      intentGuardian: "/api/v1/guardian/ingest",
      analyticalReview: "/api/v1/sessions/:sessionId/review",
    },
    uptime: process.uptime(),
    timestamp: toISOStringLocal(),
  });
});

export { healthRouter };

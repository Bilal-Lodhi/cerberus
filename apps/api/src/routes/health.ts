/**
 * Health check and capability discovery.
 *
 * Unauthenticated by design: container orchestrators and load balancers need
 * to probe it without holding the operator API key. It exposes no telemetry
 * and no configuration values.
 */

import { Hono } from "hono";
import { toISOStringLocal } from "../utils/time.js";

const healthRouter = new Hono();

const SERVICE_NAME = "cerberus-api";
const SERVICE_VERSION = "0.1.0";

healthRouter.get("/", (c) => {
  return c.json({
    status: "healthy",
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    features: {
      threatScenarioAuthoring: "POST /api/v1/scenarios",
      telemetryIngestion: "POST /api/v1/guardian/ingest",
      sessionReview: "GET /api/v1/sessions/:sessionId",
      auditor: "POST /api/v1/auditor/query",
    },
    uptime: process.uptime(),
    timestamp: toISOStringLocal(),
  });
});

export { healthRouter, SERVICE_NAME, SERVICE_VERSION };

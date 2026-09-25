/**
 * Health, readiness and capability discovery.
 *
 * Unauthenticated by design: container orchestrators and load balancers need to
 * probe both endpoints without holding the operator API key. Neither exposes
 * telemetry or configuration values.
 *
 * The two endpoints answer different questions and must not be conflated — see
 * `services/readiness.ts` for why.
 *
 *   GET /health   liveness.  Always 200 while the process answers HTTP. Checks
 *                            nothing. This is the restart probe.
 *   GET /ready    readiness. 200 when the persistence layer is reachable, 503
 *                            when it is not. This is the load-balancer probe.
 */

import { Hono } from "hono";
import { toISOStringLocal } from "../utils/time.js";
import type { ReadinessProbe } from "../services/readiness.js";

const healthRouter = new Hono();

const SERVICE_NAME = "cerberus-api";
const SERVICE_VERSION = "0.1.0";

/**
 * Capability discovery, as a `GET /health` response body.
 *
 * Exported so a test can assert the documented endpoints still exist rather than
 * only that the route answers.
 */
const FEATURES = {
  threatScenarioAuthoring: "POST /api/v1/scenarios",
  telemetryIngestion: "POST /api/v1/guardian/ingest",
  sessionReview: "GET /api/v1/sessions/:sessionId",
  auditor: "POST /api/v1/auditor/query",
  referenceDocuments: "GET /api/v1/reference-documents",
  identityRegistry: "POST /api/v1/identity/set",
} as const;

healthRouter.get("/", (c) => {
  return c.json({
    status: "healthy",
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    features: FEATURES,
    uptime: process.uptime(),
    timestamp: toISOStringLocal(),
  });
});

/**
 * Builds the readiness route around a probe.
 *
 * The probe is injected rather than imported so a test can drive both the ready
 * and the not-ready path deterministically, without a persistence layer.
 */
function createReadyRouter(probe: ReadinessProbe): Hono {
  const router = new Hono();

  router.get("/ready", async (c) => {
    const report = await probe();

    // 503, not 500: the instance is healthy but cannot serve. A load balancer
    // treats 503 as "stop routing here", which is exactly the intent, and it keeps
    // 500 meaning "a request was mishandled".
    return c.json(
      {
        status: report.ready ? "ready" : "not_ready",
        ready: report.ready,
        service: SERVICE_NAME,
        version: SERVICE_VERSION,
        checkedAt: report.checkedAt,
        cached: report.cached,
        dependencies: report.dependencies,
      },
      report.ready ? 200 : 503,
    );
  });

  return router;
}

export { healthRouter, createReadyRouter, SERVICE_NAME, SERVICE_VERSION, FEATURES };

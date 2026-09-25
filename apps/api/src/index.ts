/**
 * Cerberus API entry point.
 *
 *   Hono (routing, CORS, auth) → OpenAIProvider (OpenAI SDK)
 *                              → MCP MongoDB adapter (persistence)
 *
 * Endpoints:
 *   GET    /health                              liveness + capability discovery
 *   POST   /api/v1/identity/set                 register an operator display identity
 *   GET    /api/v1/identity/me                  read the current operator identity
 *   POST   /api/v1/scenarios                    author a threat scenario matrix
 *   POST   /api/v1/scenarios/cancel             cancel an in-flight authoring request
 *   POST   /api/v1/guardian/ingest              ingest telemetry
 *   POST   /api/v1/guardian/deploy              create a monitored session
 *   GET    /api/v1/guardian/sessions            list live sessions (expired excluded)
 *   GET    /api/v1/guardian/sessions/:id        session detail, with derived liveness
 *   POST   /api/v1/guardian/sessions/:id/reactivate
 *   POST   /api/v1/guardian/sessions/:id/terminate
 *   DELETE /api/v1/guardian/sessions/:id
 *   GET    /api/v1/sessions                     session list for the console (includes expired)
 *   GET    /api/v1/sessions/:id                 full session review
 *   POST   /api/v1/auditor/query                natural-language audit query
 *   POST   /api/v1/reference-documents          add a reference document
 *   GET    /api/v1/reference-documents          list the reference corpus
 *   DELETE /api/v1/reference-documents/:id      remove a reference document
 *
 * Everything except /health requires the operator API key. See
 * ../middleware/auth.ts and SECURITY.md.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import { prettyJSON } from "hono/pretty-json";
import { randomUUID } from "node:crypto";

import { loadConfig, ConfigError, type AppConfig } from "./config.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createRateLimitMiddleware } from "./middleware/rate-limit.js";
import { createScenariosRouter } from "./routes/scenarios.js";
import { createGuardianRouter } from "./routes/guardian.js";
import { createReviewRouter } from "./routes/review.js";
import { createAuditorRouter } from "./routes/auditor.js";
import { createReferenceRouter } from "./routes/reference.js";
import { healthRouter, SERVICE_NAME, SERVICE_VERSION } from "./routes/health.js";
import { identityRouter } from "./routes/identity.js";
import { createRateLimiter, type RateLimiter } from "./services/rate-limit.js";
import { systemClock, type Clock } from "./services/session-liveness.js";

export interface AppOptions {
  /**
   * Time source used for `SESSION_TTL_SECONDS` expiry. Defaults to the system
   * clock; tests inject a manual clock so the TTL boundary is asserted exactly
   * rather than by sleeping.
   */
  clock?: Clock;
  /**
   * Overrides the rate limiter. Defaults to one driven by the same injected clock,
   * so a test can assert the limiter's boundary exactly rather than by waiting.
   */
  rateLimiter?: RateLimiter;
}

/** Builds the fully-wired Hono application. */
export function createApp(config: AppConfig, options: AppOptions = {}): Hono {
  const app = new Hono();

  // Session liveness reads the clock on every request, so the injected source
  // is resolved once here and shared by the guardian and review routers.
  const clock: Clock = options.clock ?? systemClock;

  // ── CORS: explicit allow-list only ──────────────────────────────
  const allowedOrigins = config.cors.allowedOrigins;
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return undefined;
        return allowedOrigins.includes(origin) ? origin : undefined;
      },
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-API-Key",
        "X-Session-Token",
        "X-Generation-Request-Id",
      ],
      exposeHeaders: ["X-Correlation-Id"],
      maxAge: 86400,
    }),
  );

  // ── Correlation id ──────────────────────────────────────────────
  app.use("*", async (c, next) => {
    c.header("X-Correlation-Id", randomUUID());
    await next();
  });

  // ── Request body size bound ─────────────────────────────────────
  //
  // Runs before the auth middleware so an oversized body is refused without
  // being read into memory, whether or not the caller is authenticated.
  // `@hono/node-server` imposes no body limit of its own and exposes no option
  // to configure one, so without this the API buffers an arbitrarily large
  // request before any route sees it.
  //
  // `onError` returns the response directly rather than throwing, so the shape
  // stays under this file's control instead of depending on how `app.onError`
  // treats an HTTPException.
  const maxBodyBytes = config.security.maxRequestBodyBytes;
  app.use(
    "*",
    bodyLimit({
      maxSize: maxBodyBytes,
      onError: (c) =>
        c.json(
          {
            success: false,
            error: `Request body exceeds the configured limit of ${maxBodyBytes} bytes.`,
            code: "PAYLOAD_TOO_LARGE",
            maxBytes: maxBodyBytes,
            correlationId: c.res.headers.get("X-Correlation-Id") ?? "unknown",
          },
          413,
        ),
    }),
  );

  // ── Authentication boundary ─────────────────────────────────────
  app.use("*", createAuthMiddleware(config));

  // ── Rate limiting ───────────────────────────────────────────────
  //
  // After auth on purpose. A limiter placed before it would let an
  // unauthenticated caller exhaust a category's bucket and deny service to the
  // legitimate operator, turning a backstop into a denial-of-service amplifier.
  // See services/rate-limit.ts.
  if (config.rateLimit.enabled) {
    const limiter = options.rateLimiter ?? createRateLimiter({ clock });
    app.use("*", createRateLimitMiddleware(limiter, config));
  }

  // ── Observability ───────────────────────────────────────────────
  if (config.devMode) {
    app.use("*", logger());
  }
  app.use("*", prettyJSON());

  // ── Routes ──────────────────────────────────────────────────────
  const guardian = createGuardianRouter(config, { clock });

  app.route("/", healthRouter);
  app.route("/health", healthRouter);
  app.route("/api/v1/identity", identityRouter);
  app.route("/api/v1/scenarios", createScenariosRouter(config));
  app.route("/api/v1/guardian", guardian.router);
  app.route(
    "/api/v1/sessions",
    createReviewRouter(config, guardian.sessionStore, guardian.activeSessions, {
      clock,
    }),
  );
  app.route("/api/v1/auditor", createAuditorRouter(config));
  app.route("/api/v1/reference-documents", createReferenceRouter(config));

  // ── 404 ─────────────────────────────────────────────────────────
  app.notFound((c) =>
    c.json(
      {
        success: false,
        error: "Route not found.",
        code: "NOT_FOUND",
        path: `${c.req.method} ${c.req.path}`,
      },
      404,
    ),
  );

  // ── Error handler: never leak framework or provider internals ───
  app.onError((err, c) => {
    console.error("[api] unhandled error:", err);
    return c.json(
      {
        success: false,
        error: "Internal server error.",
        code: "INTERNAL_ERROR",
        correlationId: c.res.headers.get("X-Correlation-Id") ?? "unknown",
      },
      500,
    );
  });

  return app;
}

// ═══════════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[api] FATAL: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const app = createApp(config);

  console.log(
    `\n  ${SERVICE_NAME} v${SERVICE_VERSION}\n` +
      `  mode:    ${config.devMode ? "development" : "production"}\n` +
      `  listen:  http://localhost:${config.port}\n` +
      `  auth:    ${config.devMode ? "DISABLED (dev mode)" : "API key required"}\n` +
      `  mcp:     ${config.mcp.serverEndpoint}\n` +
      `  cors:    ${config.cors.allowedOrigins.length} origin(s) allow-listed\n`,
  );

  const { serve } = await import("@hono/node-server");
  serve({ fetch: app.fetch, port: config.port });
}

const isMainModule =
  process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("index.ts");

if (isMainModule) {
  main().catch((error) => {
    console.error("[api] Fatal startup error:", error);
    process.exit(1);
  });
}

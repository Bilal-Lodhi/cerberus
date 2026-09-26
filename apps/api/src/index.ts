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
import { bodyLimit } from "hono/body-limit";
import { prettyJSON } from "hono/pretty-json";

import { loadConfig, ConfigError, type AppConfig } from "./config.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createRateLimitMiddleware } from "./middleware/rate-limit.js";
import { createScenariosRouter } from "./routes/scenarios.js";
import { createGuardianRouter } from "./routes/guardian.js";
import { createReviewRouter } from "./routes/review.js";
import { createAuditorRouter } from "./routes/auditor.js";
import { createReferenceRouter } from "./routes/reference.js";
import { healthRouter, createReadyRouter, SERVICE_NAME, SERVICE_VERSION } from "./routes/health.js";
import { identityRouter } from "./routes/identity.js";
import { createRateLimiter, type RateLimiter } from "./services/rate-limit.js";
import { createReadinessProbe, type ReadinessProbe } from "./services/readiness.js";
import { callMcpTool, MCP_TOOL_NAMES } from "./services/mcp-client.js";
import { systemClock, type Clock } from "./services/session-liveness.js";
import { configureLogging, LOG_EVENTS, logger } from "./observability/logger.js";
import {
  currentRequestId,
  resolveRequestId,
  runWithRequestContext,
  type RequestContext,
} from "./observability/request-context.js";
import { matchedRouteTemplate } from "./observability/route-template.js";
import {
  NOTIFICATION_SECRET_ENV_VARS,
  registerConfiguredSecrets,
  registerSecret,
} from "./observability/redaction.js";

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
  /**
   * Overrides the readiness probe. Defaults to one that asks the persistence layer
   * whether it is up; tests inject a probe so both the ready and the not-ready path
   * are deterministic and no network is involved.
   */
  readinessProbe?: ReadinessProbe;
}

/**
 * The default readiness probe: can the persistence layer answer?
 *
 * Uses the MCP adapter's own `health_check`, which pings MongoDB. A failure is
 * reported rather than thrown, so a readiness request always produces an answer.
 */
function defaultReadinessProbe(config: AppConfig, clock: Clock): ReadinessProbe {
  return createReadinessProbe({
    name: "mcp-persistence",
    clock,
    check: async () => {
      const response = await callMcpTool<{ connected?: boolean; healthy?: boolean }>(
        config,
        MCP_TOOL_NAMES.HEALTH_CHECK,
        {},
        { requestId: "readiness", timeoutMs: 1_500 },
      );

      if (!response.ok) {
        throw new Error(response.error ?? "the persistence layer did not respond");
      }
      if (response.data?.connected === false) {
        throw new Error("the persistence layer is reachable but not connected to MongoDB");
      }
    },
  });
}

/** Builds the fully-wired Hono application. */
export function createApp(config: AppConfig, options: AppOptions = {}): Hono {
  const app = new Hono();

  // Logging is configured from the app's own config, so a test that builds a config
  // directly is logged the same way a deployment is. Only the level and the format
  // are set here: a test that installed a capture sink keeps it.
  configureLogging({ level: config.log.level, format: config.log.format });

  // Every configured secret is registered with the redactor before any line is
  // emitted. Notification credentials are read from the environment here rather than
  // through `loadConfig`, because those channels are optional and unset in tests:
  // registering them is about making sure a value that *is* configured can never be
  // logged, and that must not depend on the notification path being reached.
  registerConfiguredSecrets(config);
  for (const name of NOTIFICATION_SECRET_ENV_VARS) {
    registerSecret(process.env[name]);
  }

  // Session liveness reads the clock on every request, so the injected source
  // is resolved once here and shared by the guardian and review routers.
  const clock: Clock = options.clock ?? systemClock;

  // ── Request context and the request log line ────────────────────
  //
  // Registered **first**, before CORS, so every request — including a preflight that
  // the CORS middleware answers without calling `next()` — gets exactly one
  // identifier and exactly one log line.
  //
  // One identifier per request, and the same value in both headers. Before this,
  // `index.ts` set `X-Correlation-Id` while four of the five route groups minted
  // their own `randomUUID()` for the body, so the documented promise in
  // `docs/api-errors.md` §2 held for one route group and failed for four. See
  // `docs/development/operability-model.md` §4.
  app.use("*", async (c, next) => {
    const requestId = resolveRequestId(c.req.header("x-request-id"));
    const startedAtMs = performance.now();

    const context: RequestContext = {
      requestId,
      method: c.req.method,
      route: matchedRouteTemplate(c),
    };

    c.header("X-Request-Id", requestId);
    c.header("X-Correlation-Id", requestId);

    await runWithRequestContext(context, async () => {
      try {
        await next();
      } finally {
        // Resolved after the chain has run, because routing has happened by then and
        // a middleware-only match would otherwise report a wildcard as the route.
        context.route = matchedRouteTemplate(c);

        const response = c.res;
        const errorCode = await extractErrorCode(response);
        const fields = {
          method: context.method,
          route: context.route,
          status: response.status,
          latencyMs: Math.round((performance.now() - startedAtMs) * 100) / 100,
          ...(errorCode ? { errorCode } : {}),
        };

        if (response.status >= 500) logger.error(LOG_EVENTS.HTTP_REQUEST, fields);
        else if (response.status >= 400) logger.warn(LOG_EVENTS.HTTP_REQUEST, fields);
        else logger.info(LOG_EVENTS.HTTP_REQUEST, fields);
      }
    });
  });

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
        "X-Request-Id",
      ],
      // Both spellings of the same identifier are exposed, so a browser client can
      // read the id it was correlated under. `X-Correlation-Id` is kept because it is
      // already a documented exposed header.
      exposeHeaders: ["X-Request-Id", "X-Correlation-Id"],
      maxAge: 86400,
    }),
  );

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
            // The ambient id, not a header read: this middleware runs inside the
            // request context, so the body is provably correlated with the response
            // header rather than with a value read back out of a response that does
            // not exist yet.
            correlationId: currentRequestId(),
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
  //
  // The Hono development logger that used to run here is gone. It printed
  // `METHOD path status - latency` without the correlation id and only in
  // development mode, so it could not be joined to anything and left production
  // with no request line at all. The structured request line above replaces it.
  app.use("*", prettyJSON());

  // ── Routes ──────────────────────────────────────────────────────
  const guardian = createGuardianRouter(config, { clock });

  app.route("/", healthRouter);
  app.route("/health", healthRouter);
  app.route("/", createReadyRouter(options.readinessProbe ?? defaultReadinessProbe(config, clock)));
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
        correlationId: currentRequestId(),
      },
      404,
    ),
  );

  // ── Error handler: never leak framework or provider internals ───
  app.onError((err, c) => {
    // The exception is described, never serialised: a provider or driver error can
    // carry a request object, a connection string or an authorization header.
    logger.failure(LOG_EVENTS.HTTP_UNHANDLED, err, {
      method: c.req.method,
      route: matchedRouteTemplate(c),
    });
    return c.json(
      {
        success: false,
        error: "Internal server error.",
        code: "INTERNAL_ERROR",
        correlationId: currentRequestId(),
      },
      500,
    );
  });

  return app;
}

/**
 * The stable `code` of an error response, read from the response the route produced.
 *
 * Read by cloning rather than by threading a "current error code" through every route:
 * a clone of an error body — which is always a small JSON object — costs one parse and
 * needs no route to remember to record anything. Only 4xx and 5xx responses are
 * inspected, so a successful payload is never cloned, and a body that is not JSON or
 * carries no `code` simply leaves the field absent.
 */
async function extractErrorCode(response: Response): Promise<string | undefined> {
  if (response.status < 400) return undefined;

  try {
    const body = (await response.clone().json()) as { code?: unknown } | null;
    const code = body?.code;
    return typeof code === "string" && code.length > 0 ? code : undefined;
  } catch {
    return undefined;
  }
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
      // Before `createApp`, so logging is not yet configured: this line is the
      // documented exception, and it prints a configuration message that never
      // contains secret material.
      console.error(`[api] FATAL: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const app = createApp(config);

  logger.info(LOG_EVENTS.STARTUP, {
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    mode: config.devMode ? "development" : "production",
    port: config.port,
    auth: config.devMode ? "disabled" : "api-key",
    mcp: config.mcp.serverEndpoint,
    corsOrigins: config.cors.allowedOrigins.length,
    logLevel: config.log.level,
    logFormat: config.log.format,
  });

  const { serve } = await import("@hono/node-server");
  serve({ fetch: app.fetch, port: config.port });
}

const isMainModule =
  process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("index.ts");

if (isMainModule) {
  main().catch((error) => {
    logger.failure(LOG_EVENTS.STARTUP_FAILURE, error);
    process.exit(1);
  });
}

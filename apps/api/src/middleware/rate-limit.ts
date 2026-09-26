/**
 * Rate-limit middleware.
 *
 * Runs **after** authentication, deliberately. `services/rate-limit.ts` explains
 * why: a limiter placed before auth would let an unauthenticated caller exhaust a
 * category's bucket and deny service to the legitimate operator, which turns a
 * backstop into a denial-of-service amplifier.
 */

import type { MiddlewareHandler } from "hono";
import type { AppConfig } from "../config.js";
import { LOG_EVENTS, logger } from "../observability/logger.js";
import { currentRequestId } from "../observability/request-context.js";
import {
  categorizeRequest,
  type RateLimiter,
} from "../services/rate-limit.js";

export function createRateLimitMiddleware(
  limiter: RateLimiter,
  config: AppConfig,
): MiddlewareHandler {
  return async (c, next) => {
    const category = categorizeRequest(c.req.method, c.req.path);

    // Liveness and readiness are exempt: a probe that is rate limited looks like a
    // dead service, which is the one thing the endpoint exists to rule out.
    if (category === null) return next();

    const decision = limiter.check(
      category,
      // The AI ceiling is the configurable one, because every request there
      // spends money. The others are documented backstops.
      category === "ai"
        ? { limit: config.rateLimit.aiRequestsPerMinute, windowMs: 60_000 }
        : undefined,
    );

    c.header("X-RateLimit-Limit", String(decision.limit));
    c.header("X-RateLimit-Remaining", String(decision.remaining));

    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfterSeconds));
      // Safe fields only: the category, the rejection, and the wait. No credential
      // and no IP — the limiter deliberately does not key on either, so there is
      // nothing per-caller to record. See `docs/development/operability-model.md`
      // §3.10 and §7.
      logger.warn(LOG_EVENTS.RATE_LIMITED, {
        category,
        rejected: true,
        retryAfterSeconds: decision.retryAfterSeconds,
        limit: decision.limit,
      });
      return c.json(
        {
          success: false,
          error:
            "Too many requests. This endpoint is rate limited; retry after the " +
            "interval in the Retry-After header.",
          code: "RATE_LIMITED",
          category,
          retryAfterSeconds: decision.retryAfterSeconds,
          correlationId: currentRequestId(),
        },
        429,
      );
    }

    return next();
  };
}

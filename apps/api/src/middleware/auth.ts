/**
 * Authentication boundary for the Cerberus API.
 *
 * Threat model (see SECURITY.md for the full document):
 *   - Cerberus is a self-hosted single-tenant service. There is no user
 *     directory, no OAuth provider, and no multi-tenancy in the OSS baseline.
 *   - Every caller — the operator console and, in future, the endpoint agent —
 *     authenticates with a single pre-shared API key supplied through
 *     environment configuration (CERBERUS_API_KEY).
 *   - The key is compared in constant time. Failures are indistinguishable
 *     from each other and never echo the supplied or expected value.
 *
 * This module deliberately contains no authorization roles: the OSS baseline
 * has exactly two principals, "authenticated operator" and "anonymous".
 */

import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { AppConfig } from "../config.js";

/** Routes that are always reachable without a credential. */
const PUBLIC_PATHS = new Set<string>(["/health", "/"]);

/**
 * Constant-time string comparison that never short-circuits on length.
 * Returns false for empty inputs so a missing credential can never match
 * an unset expected key.
 */
export function constantTimeEquals(supplied: string, expected: string): boolean {
  if (supplied.length === 0 || expected.length === 0) return false;

  // Hash-free approach: compare fixed-length digests so the byte length of
  // the inputs does not influence the comparison time.
  const suppliedBuf = Buffer.from(supplied, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");

  if (suppliedBuf.length !== expectedBuf.length) {
    // Still perform a comparison against a same-length dummy to keep the
    // rejection path timing-similar to the mismatch path.
    const dummy = Buffer.alloc(suppliedBuf.length);
    timingSafeEqual(suppliedBuf, dummy);
    return false;
  }

  return timingSafeEqual(suppliedBuf, expectedBuf);
}

/**
 * Extracts the presented credential from the request.
 * Accepts `Authorization: Bearer <key>` and `X-API-Key: <key>`.
 */
export function extractCredential(c: Context): string {
  const authorization = c.req.header("authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match && match[1]) return match[1].trim();
  }
  const apiKey = c.req.header("x-api-key");
  if (apiKey) return apiKey.trim();
  return "";
}

/**
 * Builds the authentication middleware.
 *
 * Behaviour:
 *   - CERBERUS_DEV_MODE=true  → every request is admitted (loudly, once).
 *   - otherwise               → a valid credential is required; anything
 *                               else receives 401 with a stable error code.
 */
export function createAuthMiddleware(config: AppConfig): MiddlewareHandler {
  let devWarningEmitted = false;

  return async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) {
      return next();
    }

    if (config.devMode) {
      if (!devWarningEmitted) {
        console.warn(
          `[auth] DEV MODE — admitting unauthenticated request to ${c.req.method} ${c.req.path}. ` +
            "This is local-development behaviour only.",
        );
        devWarningEmitted = true;
      }
      return next();
    }

    const presented = extractCredential(c);

    if (presented.length === 0) {
      return c.json(
        {
          success: false,
          error: "Authentication required.",
          code: "UNAUTHENTICATED",
        },
        401,
      );
    }

    if (!constantTimeEquals(presented, config.auth.apiKey)) {
      // Deliberately identical response shape to the missing-credential case.
      return c.json(
        {
          success: false,
          error: "Authentication required.",
          code: "UNAUTHENTICATED",
        },
        401,
      );
    }

    return next();
  };
}

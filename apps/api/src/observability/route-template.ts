/**
 * Resolves the matched route **template** for a request.
 *
 * ── Why the template and not the path ─────────────────────────────────
 *
 * A log line built from `c.req.path` records
 * `/api/v1/guardian/sessions/op-trader-001`, which puts a monitored session's
 * identifier into the logs on every request and makes every session a distinct
 * "route" for any aggregation over the log. The registered template —
 * `/api/v1/guardian/sessions/:sessionId` — is what an operator actually wants to
 * group by, and it carries no identifier.
 *
 * `c.req.matchedRoutes` is the list of every route the dispatcher matched, including
 * the middleware entries registered on `*`. The terminal handler is the **last**
 * entry, so the search runs backwards and skips the wildcard middleware entries.
 * `c.req.routePath` is deliberately not used: it resolves against
 * `req.routeIndex`, which inside a middleware points at that middleware's own `*`
 * registration rather than at the handler.
 *
 * A request that matched no route is reported as {@link UNMATCHED_ROUTE} rather than
 * by its path. That is a deliberate choice: an unmatched path can still contain a
 * session identifier — a mistyped sub-path under a real session — and the operator
 * has the method, the status, the request id and the caller's own identifier to find
 * the caller with. `docs/development/operability-model.md` §5.2 states it.
 */

import type { Context } from "hono";

/** Reported when no route template matched the request. */
export const UNMATCHED_ROUTE = "<unmatched>";

/** Route registrations that belong to middleware rather than to a handler. */
const WILDCARD_ROUTES: ReadonlySet<string> = new Set(["*", "/*", ""]);

/**
 * The matched route template, or {@link UNMATCHED_ROUTE}.
 *
 * Never throws: a request that reached the logger must produce a log line, and a
 * template lookup is not allowed to be the thing that loses it.
 */
export function matchedRouteTemplate(c: Context): string {
  try {
    const routes = c.req.matchedRoutes as Array<{ path?: unknown }> | undefined;
    if (Array.isArray(routes)) {
      for (let index = routes.length - 1; index >= 0; index -= 1) {
        const path = routes[index]?.path;
        if (typeof path === "string" && !WILDCARD_ROUTES.has(path)) return path;
      }
    }
  } catch {
    // A request that cannot describe its route still gets logged, as unmatched.
  }
  return UNMATCHED_ROUTE;
}

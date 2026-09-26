/**
 * The per-request correlation context.
 *
 * ── Why ambient context, and not a parameter ──────────────────────────
 *
 * Before this module every route minted its own `randomUUID()` and passed it down by
 * hand. That is exactly how the correlation defect recorded in
 * `docs/development/operability-model.md` §4 happened: `routes/guardian.ts`,
 * `routes/review.ts`, `routes/reference.ts` and `routes/auditor.ts` each produced a
 * value that appeared in the error body, in no response header, and in no log line
 * an operator could key on. When each caller passes its own id, some callers pass a
 * fresh one.
 *
 * An `AsyncLocalStorage` established once per request by the middleware in
 * `index.ts` means a service module reads the request's id instead of inventing one,
 * and no service signature has to grow a parameter. A missed call site would compile
 * either way; this way it cannot be missed.
 *
 * ── What the id is not ────────────────────────────────────────────────
 *
 * It is a correlation label and nothing else. It is never used for authentication,
 * authorization, replay detection, idempotency or rate-limit keying, and no code may
 * branch on it: a caller can choose it, so treating it as an identity would hand that
 * identity to the caller. See `docs/security/threat-model.md` §9.5.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * The label used for a log line that belongs to no HTTP request: startup, a
 * migration, a readiness probe. Fixed and obviously not an id, so it can never be
 * mistaken for one.
 */
export const NO_REQUEST_ID = "-";

/** Longest accepted caller-supplied identifier. */
export const MAX_REQUEST_ID_LENGTH = 128;

/**
 * The accepted character set: unreserved URI characters plus `.` `:` `-`, which is
 * what every tracing and proxy convention uses.
 *
 * Deliberately excludes whitespace, quotes and every control character. A newline in
 * an identifier forges a second log line, which is how a caller manufactures
 * evidence; see `docs/security/threat-model.md` §9.4.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * True when a caller-supplied value may be used as the request id.
 *
 * Length is bounded before the pattern is applied, so a megabyte header is rejected
 * without being scanned.
 */
export function isValidRequestId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_REQUEST_ID_LENGTH) return false;
  return REQUEST_ID_PATTERN.test(value);
}

/**
 * The request id for a request: the caller's, when it is valid; a fresh UUID
 * otherwise.
 *
 * A **rejected** identifier is replaced rather than echoed and is not an error
 * response. Making it one would turn a header the caller did not know existed into a
 * visible failure, and no route needs to act differently — which is why there is no
 * `INVALID_REQUEST_ID` code. See `docs/development/operability-model.md` §6.2.
 */
export function resolveRequestId(candidate: unknown): string {
  return isValidRequestId(candidate) ? candidate : randomUUID();
}

export interface RequestContext {
  /** The one identifier for this request. */
  requestId: string;
  /** The HTTP method. */
  method: string;
  /**
   * The matched route **template** — `/api/v1/guardian/sessions/:sessionId` — not
   * the concrete path. A session id is not a route, and a log line built from the
   * concrete path would put one in the logs for every request.
   */
  route: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `work` with `context` as the ambient request context. */
export function runWithRequestContext<T>(context: RequestContext, work: () => T): T {
  return storage.run(context, work);
}

/** The ambient request context, or `undefined` outside a request. */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The ambient request id, or {@link NO_REQUEST_ID} outside a request.
 *
 * Every log line and every MCP call carries an id through this function, so a line
 * that belongs to a request is always joinable to it and a line that belongs to no
 * request is always recognisable as such.
 */
export function currentRequestId(): string {
  return storage.getStore()?.requestId ?? NO_REQUEST_ID;
}

/** Records the matched route template on the ambient context, when there is one. */
export function setCurrentRoute(route: string): void {
  const context = storage.getStore();
  if (context) context.route = route;
}

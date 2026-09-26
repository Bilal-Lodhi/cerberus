/**
 * Operator identity route.
 *
 * This is a display-identity registry, NOT an authentication mechanism. It
 * records which operator is driving the console so audit records can carry a
 * human-readable name. Authorization for every sensitive operation is handled
 * by the API-key middleware in ../middleware/auth.ts.
 *
 * The handle returned here is an opaque per-process token that is meaningless
 * outside this server process and is deliberately not accepted as a
 * credential anywhere else. The only route that reads it back is `GET /me`.
 *
 * The registry is bounded in both size and time. It is a `Map` in process
 * memory, and an unbounded one that every `POST /set` appended to would grow for
 * the lifetime of the process.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { IdentityPayload, IdentityResponse } from "../types.js";
import { LOG_EVENTS, logger } from "../observability/logger.js";
import { currentRequestId } from "../observability/request-context.js";

interface StoredIdentity {
  identity: IdentityPayload;
  issuedAtMs: number;
}

/** In-memory identity store (per-process, resets on restart). */
const identityStore = new Map<string, StoredIdentity>();

/**
 * Maximum number of operator handles held in memory at once.
 *
 * Reaching it evicts the oldest handle. A console registers one identity per
 * launch, so this is far above real usage; it exists so a client that registers
 * in a loop cannot grow the process without bound.
 */
export const MAX_IDENTITY_HANDLES = 100;

/**
 * How long an operator handle stays resolvable, in milliseconds (12 hours).
 *
 * The handle is not a credential and nothing authorises against it, so this
 * bounds memory rather than access. It is what the `GET /me` handler has always
 * meant by "unknown or expired operator handle".
 */
export const IDENTITY_HANDLE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Maximum accepted length of any identity field, in characters.
 *
 * These strings are echoed back to the console and written into log lines, so
 * they are bounded rather than accepted at whatever length the caller sends.
 */
export const MAX_IDENTITY_FIELD_CHARS = 200;

const identityRouter = new Hono();

/** True when a stored handle has passed its lifetime. */
function isExpired(entry: StoredIdentity, nowMs: number): boolean {
  return nowMs - entry.issuedAtMs >= IDENTITY_HANDLE_TTL_MS;
}

/**
 * Drops expired handles, then the oldest, until there is room for one more.
 *
 * `Map` preserves insertion order, so the first key is the oldest handle.
 */
function evictIdentities(nowMs: number): void {
  for (const [handle, entry] of identityStore) {
    if (isExpired(entry, nowMs)) identityStore.delete(handle);
  }

  while (identityStore.size >= MAX_IDENTITY_HANDLES) {
    const oldest = identityStore.keys().next();
    if (oldest.done) break;
    identityStore.delete(oldest.value);
  }
}

/**
 * Reads an optional trimmed string field.
 *
 * Returns an error for a non-string value rather than casting and calling
 * `.trim()` on it: a numeric `displayName` used to throw inside the handler and
 * surface as an unhandled 500 instead of a 400.
 */
function readIdentityField(
  source: Record<string, unknown>,
  key: string,
): { value?: string; error?: string } {
  const raw = source[key];
  if (raw === undefined || raw === null) return {};

  if (typeof raw !== "string") {
    return { error: `Field '${key}' must be a string` };
  }

  const trimmed = raw.trim();
  if (trimmed.length > MAX_IDENTITY_FIELD_CHARS) {
    return {
      error:
        `Field '${key}' must be at most ${MAX_IDENTITY_FIELD_CHARS} characters ` +
        `(got ${trimmed.length}).`,
    };
  }

  return { value: trimmed.length > 0 ? trimmed : undefined };
}

/**
 * POST /api/v1/identity/set
 * Body: { displayName, employeeId, role?, department? }
 */
identityRouter.post("/set", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        success: false,
        error:
          "Invalid JSON body — request must be valid JSON with 'displayName' and 'employeeId' fields",
      },
      400,
    );
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return c.json(
      {
        success: false,
        error:
          "Request body must be a valid JSON object with 'displayName' and 'employeeId' fields",
      },
      400,
    );
  }

  const bodyObj = body as Record<string, unknown>;
  const displayName = readIdentityField(bodyObj, "displayName");
  const employeeId = readIdentityField(bodyObj, "employeeId");
  const role = readIdentityField(bodyObj, "role");
  const department = readIdentityField(bodyObj, "department");

  for (const field of [displayName, employeeId, role, department]) {
    if (field.error) {
      return c.json(
        { success: false, error: field.error, code: "INVALID_IDENTITY_FIELD", correlationId: currentRequestId() },
        400,
      );
    }
  }

  if (!displayName.value) {
    return c.json(
      { success: false, error: "displayName is required", correlationId: currentRequestId() },
      400,
    );
  }
  if (!employeeId.value) {
    return c.json(
      { success: false, error: "employeeId is required", correlationId: currentRequestId() },
      400,
    );
  }

  const identity: IdentityPayload = {
    displayName: displayName.value,
    employeeId: employeeId.value,
    role: role.value,
    department: department.value,
  };

  const nowMs = Date.now();
  evictIdentities(nowMs);

  const sessionToken = randomUUID();
  identityStore.set(sessionToken, { identity, issuedAtMs: nowMs });

  const response: IdentityResponse = { success: true, identity, sessionToken };

  // The display name, the employee id and the handle are all operator identifiers.
  // Only the fact of registration and the registry's size are recorded.
  logger.info(LOG_EVENTS.IDENTITY_REGISTERED, { registrySize: identityStore.size });

  return c.json(response, 201);
});

/**
 * GET /api/v1/identity/me
 * Header: X-Session-Token: <handle>
 */
identityRouter.get("/me", (c) => {
  const token = c.req.header("X-Session-Token");

  if (!token) {
    return c.json(
      {
        success: false,
        error: "X-Session-Token header is required",
        correlationId: currentRequestId(),
      },
      401,
    );
  }

  const entry = identityStore.get(token);
  if (!entry || isExpired(entry, Date.now())) {
    // Drop it while we are here, so an expired handle does not linger.
    if (entry) identityStore.delete(token);
    return c.json(
      {
        success: false,
        error: "Unknown or expired operator handle",
        correlationId: currentRequestId(),
      },
      401,
    );
  }

  return c.json({ success: true, identity: entry.identity });
});

export { identityRouter, identityStore };

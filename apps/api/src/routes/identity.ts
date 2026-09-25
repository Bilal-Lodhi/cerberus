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
 * credential anywhere else.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { IdentityPayload, IdentityResponse } from "../types.js";

/** In-memory identity store (per-process, resets on restart). */
const identityStore = new Map<string, IdentityPayload>();

/**
 * Maximum accepted length of any identity field, in characters.
 *
 * These strings are echoed back to the console and written into log lines, so
 * they are bounded rather than accepted at whatever length the caller sends.
 */
export const MAX_IDENTITY_FIELD_CHARS = 200;

const identityRouter = new Hono();

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
        { success: false, error: field.error, code: "INVALID_IDENTITY_FIELD" },
        400,
      );
    }
  }

  if (!displayName.value) {
    return c.json({ success: false, error: "displayName is required" }, 400);
  }
  if (!employeeId.value) {
    return c.json({ success: false, error: "employeeId is required" }, 400);
  }

  const identity: IdentityPayload = {
    displayName: displayName.value,
    employeeId: employeeId.value,
    role: role.value,
    department: department.value,
  };

  const sessionToken = randomUUID();
  identityStore.set(sessionToken, identity);

  const response: IdentityResponse = { success: true, identity, sessionToken };

  console.log(
    `[identity] registered operator "${identity.displayName}" (${identity.employeeId}) ` +
      `handle=${sessionToken.slice(0, 8)}…`,
  );

  return c.json(response, 201);
});

/**
 * GET /api/v1/identity/me
 * Header: X-Session-Token: <handle>
 */
identityRouter.get("/me", (c) => {
  const token = c.req.header("X-Session-Token");

  if (!token) {
    return c.json({ success: false, error: "X-Session-Token header is required" }, 401);
  }

  const identity = identityStore.get(token);
  if (!identity) {
    return c.json({ success: false, error: "Unknown or expired operator handle" }, 401);
  }

  return c.json({ success: true, identity });
});

export { identityRouter, identityStore };

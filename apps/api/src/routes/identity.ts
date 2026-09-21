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

const identityRouter = new Hono();

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
  const displayName = (bodyObj["displayName"] as string | undefined)?.trim();
  const employeeId = (bodyObj["employeeId"] as string | undefined)?.trim();

  if (!displayName) {
    return c.json({ success: false, error: "displayName is required" }, 400);
  }
  if (!employeeId) {
    return c.json({ success: false, error: "employeeId is required" }, 400);
  }

  const identity: IdentityPayload = {
    displayName,
    employeeId,
    role: (bodyObj["role"] as string | undefined)?.trim() || undefined,
    department: (bodyObj["department"] as string | undefined)?.trim() || undefined,
  };

  const sessionToken = randomUUID();
  identityStore.set(sessionToken, identity);

  const response: IdentityResponse = { success: true, identity, sessionToken };

  console.log(
    `[identity] registered operator "${displayName}" (${employeeId}) ` +
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

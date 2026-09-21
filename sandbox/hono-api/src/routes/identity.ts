/**
 * Lightweight Identity Route — Hackathon Demo
 *
 * Provides ephemeral "identity" without authentication:
 *   POST /api/v1/identity/set   — Register a display name + employee ID
 *   GET  /api/v1/identity/me    — Retrieve current identity
 *
 * The "session token" is a UUID stored server-side in a simple Map.
 * In production, replace with Firebase Auth or Google Cloud Identity Platform.
 */

import { Hono } from "hono";
import type { IdentityPayload, IdentityResponse } from "../types.js";

// ─── In-memory identity store (per-process, resets on restart) ─────

const identityStore = new Map<string, IdentityPayload>();

// ─── Router ─────────────────────────────────────────────────────────

const identityRouter = new Hono();

/**
 * POST /api/v1/identity/set
 * Body: { displayName: string, employeeId: string, role?: string }
 * Returns an ephemeral session token.
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
  const displayName = (bodyObj["displayName"] as string)?.trim();
  const employeeId = (bodyObj["employeeId"] as string)?.trim();

  if (!displayName || displayName.length === 0) {
    return c.json({ success: false, error: "displayName is required" }, 400);
  }
  if (!employeeId || employeeId.length === 0) {
    return c.json({ success: false, error: "employeeId is required" }, 400);
  }

  const identity: IdentityPayload = {
    displayName,
    employeeId,
    role: (bodyObj["role"] as string | undefined)?.trim() || undefined,
  };

  const sessionToken = crypto.randomUUID();
  identityStore.set(sessionToken, identity);

  const response: IdentityResponse = {
    success: true,
    identity,
    sessionToken,
  };

  console.log(
    `[identity] Registered → "${displayName}" (${employeeId}) token=${sessionToken.slice(0, 8)}...`,
  );

  return c.json(response, 201);
});

/**
 * GET /api/v1/identity/me
 * Header: X-Session-Token: <token>
 * Returns the identity payload if the token is valid.
 */
identityRouter.get("/me", (c) => {
  const token = c.req.header("X-Session-Token");

  if (!token) {
    return c.json(
      { success: false, error: "X-Session-Token header is required" },
      401,
    );
  }

  const identity = identityStore.get(token);
  if (!identity) {
    return c.json(
      { success: false, error: "Invalid or expired session token" },
      401,
    );
  }

  return c.json({
    success: true,
    identity,
  });
});

export { identityRouter };
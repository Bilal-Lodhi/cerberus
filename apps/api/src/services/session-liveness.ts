/**
 * Session liveness — the single interpretation of `SESSION_TTL_SECONDS`.
 *
 * ── What the TTL means ────────────────────────────────────────────────
 *
 * The TTL defines ACTIVE-LIVENESS, not evidence retention. It answers exactly
 * one question: "is this session still being monitored right now?" It never
 * deletes, truncates, redacts or hides review evidence.
 *
 * An expired session:
 *
 *   - is excluded from the live session list (`GET /api/v1/guardian/sessions`);
 *   - is not resurrected into the live registry by a restart, even when its
 *     durable status is still `active` or `locked`;
 *   - refuses new telemetry until it is explicitly reactivated
 *     (`POST /api/v1/guardian/sessions/:sessionId/reactivate`), so a monitoring
 *     window cannot be extended indefinitely as a side effect of continuing to
 *     emit events;
 *   - remains fully readable through `GET /api/v1/guardian/sessions/:sessionId`,
 *     `GET /api/v1/sessions` and `GET /api/v1/sessions/:sessionId`.
 *
 * ── Why expiry is computed, not persisted ─────────────────────────────
 *
 * Expiry is derived from the session's activity timestamp and the configured
 * TTL on every read. It is deliberately not a persisted session status: the
 * durable vocabulary is `active | locked | terminated` (`SESSION_STATUSES` in
 * `packages/mcp-mongodb/src/tool-names.ts`) and the MCP `set_session_status`
 * tool rejects anything else, so adding a fourth value would change a public
 * contract to store a derived property. It would also need a background sweep
 * to stay accurate, which is a worse failure mode than computing it.
 *
 * ── What is NOT here ──────────────────────────────────────────────────
 *
 * Cleanup of historical evidence is a separate retention policy. Nothing in
 * this module deletes or expires data. Deleting a session remains an explicit
 * operator action (`DELETE /api/v1/guardian/sessions/:sessionId`).
 */

import type { SessionLiveness } from "../types.js";

/** Re-exported so callers can import the liveness contract from either module. */
export type { SessionLiveness };

// ═══════════════════════════════════════════════════════════════════
// Clock
// ═══════════════════════════════════════════════════════════════════

/** A time source. Injected so expiry is testable without sleeping. */
export interface Clock {
  /** Current time as epoch milliseconds. */
  now(): number;
}

/** The production time source. */
export const systemClock: Clock = {
  now: () => Date.now(),
};

/** A clock a test can move by hand. */
export interface ManualClock extends Clock {
  /** Jump to an absolute epoch-millisecond instant. */
  set(epochMs: number): void;
  /** Move forward (or backward, with a negative value) by a duration. */
  advance(ms: number): void;
}

/**
 * Builds a controllable clock. Tests use this instead of sleeping, so the TTL
 * boundary is asserted exactly rather than approximately.
 */
export function createManualClock(startEpochMs: number): ManualClock {
  let current = startEpochMs;
  return {
    now: () => current,
    set: (epochMs: number) => {
      current = epochMs;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// Liveness
// ═══════════════════════════════════════════════════════════════════

/**
 * Every timestamp that can contribute to "when was this session last busy?".
 *
 * Both candidates come from a SERVER clock, and the more recent usable one
 * wins:
 *
 *   - `lastActivityAt` — server-observed time of the last accepted telemetry
 *     batch or lifecycle transition, stamped from the injected {@link Clock}.
 *   - `persistedUpdatedAt` — the durable `updatedAt` the persistence layer
 *     writes on every session mutation. The only candidate that survives a
 *     restart.
 *
 * ── Why the telemetry event timestamp is NOT a candidate ──────────────
 *
 * `MicroEvent.timestamp` is client-supplied. Using it would hand the monitored
 * client control of its own monitoring window: an event stamped in the year
 * 3000 would keep the session "recently active" forever. Clamping such a value
 * to the current time does not fix that — the clamped value then simply tracks
 * `now` on every subsequent evaluation, which is the same bypass with extra
 * steps.
 *
 * The field is still recorded and displayed on the review timeline; it is just
 * not trusted to decide whether monitoring continues. The server-observed
 * `lastActivityAt` already answers "when was telemetry last accepted", which is
 * the question the TTL actually asks.
 */
export interface SessionActivity {
  lastActivityAt?: string | null;
  persistedUpdatedAt?: string | null;
}

/** Parses an ISO-8601 timestamp to epoch ms, or null when unusable. */
export function parseTimestampMs(raw: string | null | undefined): number | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The most recent usable activity instant, normalised against `nowMs`.
 *
 * The `Math.min` is a defensive normalisation, not a security control: the
 * application and MongoDB may run on hosts whose clocks differ by a few
 * seconds, and a durable `updatedAt` slightly ahead of the local clock would
 * otherwise produce a negative age. Every input is already server-generated, so
 * this cannot be used to extend a monitoring window.
 *
 * Returns null when no candidate is usable. Callers treat null as "not
 * expired": an unreadable timestamp must not silently hide a session.
 */
export function resolveLastActivityMs(
  activity: SessionActivity,
  nowMs: number,
): number | null {
  const candidates: number[] = [];
  for (const raw of [activity.lastActivityAt, activity.persistedUpdatedAt]) {
    const parsed = parseTimestampMs(raw);
    if (parsed !== null) candidates.push(parsed);
  }

  if (candidates.length === 0) return null;
  return Math.min(Math.max(...candidates), nowMs);
}

/**
 * True when the session's most recent activity is at least `ttlSeconds` old.
 *
 * The comparison is `>=`, so a session is expired exactly at the TTL boundary.
 * All arithmetic is absolute epoch milliseconds, so timestamps carrying
 * different UTC offsets compare correctly.
 *
 * A non-positive or non-finite `ttlSeconds` disables expiry rather than
 * expiring everything. `loadConfig()` refuses such a value at startup, so this
 * is a second line of defence for programmatic construction (tests, embedders)
 * — "expire every session immediately" is not a useful interpretation of a
 * misconfigured lifetime.
 */
export function isExpired(
  activity: SessionActivity,
  ttlSeconds: number,
  clock: Clock,
): boolean {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return false;

  const nowMs = clock.now();
  const lastActivityMs = resolveLastActivityMs(activity, nowMs);
  if (lastActivityMs === null) return false;

  return nowMs - lastActivityMs >= ttlSeconds * 1000;
}

/** `"expired"` when {@link isExpired} holds, otherwise `"active"`. */
export function resolveLiveness(
  activity: SessionActivity,
  ttlSeconds: number,
  clock: Clock,
): SessionLiveness {
  return isExpired(activity, ttlSeconds, clock) ? "expired" : "active";
}

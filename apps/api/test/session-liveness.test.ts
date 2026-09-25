/**
 * Unit tests for the `SESSION_TTL_SECONDS` liveness predicate.
 *
 * These are pure: no route, no MCP stub, no network. Time is injected through a
 * manual clock, so the TTL boundary is asserted exactly rather than
 * approximately and nothing sleeps.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createManualClock,
  isExpired,
  parseTimestampMs,
  resolveLastActivityMs,
  resolveLiveness,
  systemClock,
} from "../src/services/session-liveness.js";

/** A fixed instant so every assertion is deterministic. */
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

describe("parseTimestampMs", () => {
  test("parses UTC and offset timestamps to the same instant", () => {
    assert.equal(
      parseTimestampMs("2026-01-01T00:00:00.000Z"),
      parseTimestampMs("2026-01-01T05:00:00.000+05:00"),
    );
  });

  test("returns null for unusable input", () => {
    assert.equal(parseTimestampMs(undefined), null);
    assert.equal(parseTimestampMs(null), null);
    assert.equal(parseTimestampMs(""), null);
    assert.equal(parseTimestampMs("   "), null);
    assert.equal(parseTimestampMs("not-a-date"), null);
    assert.equal(parseTimestampMs("2026-13-45T99:99:99Z"), null);
  });
});

describe("resolveLastActivityMs", () => {
  test("takes the most recent of the candidates", () => {
    // `now` is deliberately later than every candidate, so normalisation is not
    // what produces the result under test.
    const now = T0 + 3_600_000;
    assert.equal(
      resolveLastActivityMs(
        {
          lastActivityAt: "2026-01-01T00:10:00.000Z",
          persistedUpdatedAt: "2026-01-01T00:05:00.000Z",
        },
        now,
      ),
      Date.parse("2026-01-01T00:10:00.000Z"),
    );
  });

  test("ignores unusable candidates instead of failing", () => {
    const now = T0 + 3_600_000;
    assert.equal(
      resolveLastActivityMs(
        {
          lastActivityAt: "garbage",
          persistedUpdatedAt: "2026-01-01T00:07:00.000Z",
        },
        now,
      ),
      Date.parse("2026-01-01T00:07:00.000Z"),
    );
  });

  test("returns null when nothing is usable", () => {
    assert.equal(resolveLastActivityMs({}, T0), null);
    assert.equal(
      resolveLastActivityMs({ lastActivityAt: "", persistedUpdatedAt: null }, T0),
      null,
    );
    assert.equal(resolveLastActivityMs({ lastActivityAt: "x" }, T0), null);
  });

  test("does not read the client-supplied telemetry timestamp", () => {
    // `SessionActivity` has no field for it by construction; this asserts the
    // shape stays that way, because a client-controlled timestamp would let the
    // monitored client extend its own monitoring window.
    const activity: Record<string, unknown> = {
      lastActivityAt: new Date(T0).toISOString(),
      lastEventTimestamp: new Date(T0 + 10 * 365 * 24 * 3600 * 1000).toISOString(),
    };
    assert.equal(
      resolveLastActivityMs(activity, T0 + 3_600_000),
      T0,
      "a client-supplied event timestamp influenced the activity instant",
    );
  });

  test("normalises a cross-host clock skew to now", () => {
    // Defensive only: the application and MongoDB may run on hosts whose clocks
    // differ, and a durable timestamp slightly ahead of the local clock must not
    // produce a negative age. Every input is server-generated, so this cannot
    // extend a monitoring window.
    const now = T0;
    const slightlyAhead = new Date(T0 + 5_000).toISOString();
    assert.equal(resolveLastActivityMs({ persistedUpdatedAt: slightlyAhead }, now), now);
  });
});

describe("isExpired", () => {
  const ttl = 3600;

  test("is not expired immediately after activity", () => {
    const clock = createManualClock(T0);
    assert.equal(isExpired({ lastActivityAt: new Date(T0).toISOString() }, ttl, clock), false);
  });

  test("is not expired one millisecond before the boundary", () => {
    const clock = createManualClock(T0);
    clock.advance(ttl * 1000 - 1);
    assert.equal(isExpired({ lastActivityAt: new Date(T0).toISOString() }, ttl, clock), false);
  });

  test("is expired exactly at the boundary", () => {
    const clock = createManualClock(T0);
    clock.advance(ttl * 1000);
    assert.equal(isExpired({ lastActivityAt: new Date(T0).toISOString() }, ttl, clock), true);
  });

  test("is expired well past the boundary", () => {
    const clock = createManualClock(T0);
    clock.advance(ttl * 1000 * 3);
    assert.equal(isExpired({ lastActivityAt: new Date(T0).toISOString() }, ttl, clock), true);
  });

  test("recent activity keeps an old session alive", () => {
    const clock = createManualClock(T0 + ttl * 1000 * 10);
    assert.equal(
      isExpired(
        {
          // Stale durable timestamp...
          persistedUpdatedAt: new Date(T0).toISOString(),
          // ...but the session ingested telemetry a minute ago.
          lastActivityAt: new Date(T0 + ttl * 1000 * 10 - 60_000).toISOString(),
        },
        ttl,
        clock,
      ),
      false,
    );
  });

  test("treats an unreadable activity timestamp as not expired", () => {
    const clock = createManualClock(T0 + ttl * 1000 * 100);
    assert.equal(isExpired({}, ttl, clock), false);
    assert.equal(isExpired({ lastActivityAt: "nonsense" }, ttl, clock), false);
  });

  test("a non-positive TTL disables expiry rather than expiring everything", () => {
    const clock = createManualClock(T0 + ttl * 1000 * 100);
    const activity = { lastActivityAt: new Date(T0).toISOString() };
    assert.equal(isExpired(activity, 0, clock), false);
    assert.equal(isExpired(activity, -1, clock), false);
    assert.equal(isExpired(activity, Number.NaN, clock), false);
    assert.equal(isExpired(activity, Number.POSITIVE_INFINITY, clock), false);
  });
});

describe("resolveLiveness", () => {
  test("reports the derived state without persisting anything", () => {
    const clock = createManualClock(T0);
    const activity = { lastActivityAt: new Date(T0).toISOString() };
    assert.equal(resolveLiveness(activity, 60, clock), "active");

    clock.advance(60_000);
    assert.equal(resolveLiveness(activity, 60, clock), "expired");
  });
});

describe("clocks", () => {
  test("the manual clock moves only when told to", () => {
    const clock = createManualClock(T0);
    assert.equal(clock.now(), T0);
    clock.advance(500);
    assert.equal(clock.now(), T0 + 500);
    clock.set(T0);
    assert.equal(clock.now(), T0);
  });

  test("the system clock returns a plausible epoch-millisecond instant", () => {
    const now = systemClock.now();
    assert.ok(Number.isFinite(now));
    assert.ok(now > Date.parse("2020-01-01T00:00:00.000Z"));
  });
});

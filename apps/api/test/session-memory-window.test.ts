/**
 * Bounded in-memory session state.
 *
 * `session.events` and `session.keystrokeDeltas` used to grow for a session's whole
 * lifetime, so every consumer that scanned them got slower as the session ran and the
 * memory a live session held was unbounded. Both are now windows.
 *
 * The bound is asserted here rather than inferred from a heap delta: a heap delta in
 * one process includes V8 bookkeeping and, in the benchmark, whatever the MCP double
 * is holding alongside it. A length assertion is deterministic and has exactly one
 * contributor.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_IN_MEMORY_EVENTS,
  MAX_KEYSTROKE_DELTAS,
  applyEventToSession,
  computeKeystrokeMetrics,
  trimToWindow,
  type SessionState,
} from "../src/routes/guardian.js";
import type { MicroEvent } from "../src/types.js";

function makeEvent(overrides: Partial<MicroEvent> = {}): MicroEvent {
  return {
    eventId: "evt-1",
    sessionId: "ses-1",
    employeeId: "op-1",
    auditId: "audit-1",
    vectorId: "tv-1",
    eventType: "KEYSTROKE",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: { deltaMs: 120 },
    clientMetadata: {
      userAgent: "t",
      ipAddress: "127.0.0.1",
      screenResolution: "1x1",
      platform: "web",
      language: "en",
    },
    ...overrides,
  };
}

function makeSession(): SessionState {
  return {
    sessionId: "ses-1",
    employeeId: "op-1",
    auditId: "audit-1",
    events: [],
    currentCode: "",
    pasteCount: 0,
    keystrokeDeltas: [],
    tabSwitchCount: 0,
    fullscreenExitCount: 0,
    copyAttemptCount: 0,
    lastRiskPayload: null,
    eventCount: 0,
    status: "active",
    lastAnalyzedCodeHash: "",
    recentEventFingerprints: new Set(),
  };
}

describe("trimToWindow", () => {
  test("keeps the most recent entries", () => {
    const items = [1, 2, 3, 4, 5, 6];
    trimToWindow(items, 2);
    assert.deepEqual(items, [5, 6]);
  });

  test("is a no-op below the limit", () => {
    const items = [1, 2, 3];
    trimToWindow(items, 10);
    assert.deepEqual(items, [1, 2, 3]);
  });

  test("allows growth to twice the limit before trimming", () => {
    // The slack is what makes the amortised cost O(1). Trimming on every push would
    // make each push O(limit) and reintroduce a per-event cost proportional to the
    // window — the same shape of problem the window exists to remove.
    const items = Array.from({ length: 20 }, (_unused, index) => index);
    trimToWindow(items, 10);
    assert.equal(items.length, 20, "trimmed before reaching twice the limit");

    items.push(20);
    trimToWindow(items, 10);
    assert.deepEqual(items, Array.from({ length: 10 }, (_unused, index) => index + 11));
  });

  test("mutates in place, so a held reference stays valid", () => {
    const items = [1, 2, 3, 4];
    const alias = items;
    trimToWindow(items, 1);
    assert.equal(alias, items);
    assert.deepEqual(alias, [4]);
  });

  test("handles an empty array", () => {
    const items: number[] = [];
    trimToWindow(items, 5);
    assert.deepEqual(items, []);
  });
});

describe("the in-memory event window", () => {
  test("a long session does not grow without bound", () => {
    const session = makeSession();

    for (let i = 0; i < 20_000; i++) {
      applyEventToSession(session, makeEvent({ eventId: `e-${i}`, payload: { deltaMs: 120 } }));
    }

    assert.ok(
      session.events.length <= MAX_IN_MEMORY_EVENTS * 2,
      `events grew to ${session.events.length}`,
    );
  });

  test("the window holds the most recent events, not the oldest", () => {
    const session = makeSession();

    for (let i = 0; i < 5_000; i++) {
      applyEventToSession(session, makeEvent({ eventId: `e-${i}`, payload: { deltaMs: 120 } }));
    }

    const ids = session.events.map((event) => event.eventId);
    assert.ok(ids.includes("e-4999"), "the newest event was dropped");
    assert.ok(!ids.includes("e-0"), "the oldest event was kept");
  });

  test("the durable lifetime count is not the window length", () => {
    // `eventCount` is what the durable counter is written from, so bounding the
    // window must not bound the count. They are deliberately different numbers.
    const session = makeSession();

    for (let i = 0; i < 5_000; i++) {
      applyEventToSession(session, makeEvent({ eventId: `e-${i}`, payload: { deltaMs: 120 } }));
      session.eventCount++;
    }

    assert.equal(session.eventCount, 5_000);
    assert.ok(session.events.length < 5_000);
  });
});

describe("the keystroke window", () => {
  test("a long session does not accumulate every delta", () => {
    const session = makeSession();

    for (let i = 0; i < 20_000; i++) {
      applyEventToSession(session, makeEvent({ eventId: `e-${i}`, payload: { deltaMs: 120 } }));
    }

    assert.ok(
      session.keystrokeDeltas.length <= MAX_KEYSTROKE_DELTAS * 2,
      `deltas grew to ${session.keystrokeDeltas.length}`,
    );
  });

  test("PASTE changeLengths are bounded by the same window", () => {
    const session = makeSession();

    for (let i = 0; i < 5_000; i++) {
      applyEventToSession(
        session,
        makeEvent({ eventId: `p-${i}`, eventType: "PASTE", payload: { newText: "x", changeLength: 10 } }),
      );
    }

    assert.ok(session.keystrokeDeltas.length <= MAX_KEYSTROKE_DELTAS * 2);
  });

  test("the window keeps the most recent deltas", () => {
    const session = makeSession();

    for (let i = 0; i < 2_000; i++) {
      applyEventToSession(session, makeEvent({ eventId: `e-${i}`, payload: { deltaMs: i } }));
    }

    assert.ok(session.keystrokeDeltas.includes(1_999), "the newest delta was dropped");
    assert.ok(!session.keystrokeDeltas.includes(0), "the oldest delta was kept");
  });
});

describe("computeKeystrokeMetrics", () => {
  test("computes the metrics", () => {
    assert.deepEqual(computeKeystrokeMetrics([100, 200, 300]), {
      avgDeltaMs: 200,
      maxDeltaMs: 300,
      minDeltaMs: 100,
    });
  });

  test("returns zeroes for an empty input", () => {
    assert.deepEqual(computeKeystrokeMetrics([]), {
      avgDeltaMs: 0,
      maxDeltaMs: 0,
      minDeltaMs: 0,
    });
  });

  test("handles a large array without overflowing the stack", () => {
    // `Math.max(...deltas)` passes one argument per element and throws
    // `RangeError: Maximum call stack size exceeded` somewhere around 100 000
    // entries. The window keeps arrays far below that, but a limit that depends on a
    // different module's constant is not a limit.
    const deltas = Array.from({ length: 200_000 }, (_unused, index) => index);

    const metrics = computeKeystrokeMetrics(deltas);
    assert.equal(metrics.maxDeltaMs, 199_999);
    assert.equal(metrics.minDeltaMs, 0);
    assert.equal(metrics.avgDeltaMs, 99_999.5);
  });

  test("handles negative deltas", () => {
    // A client can send anything; the metrics must not be nonsense.
    assert.deepEqual(computeKeystrokeMetrics([-5, 10]), {
      avgDeltaMs: 2.5,
      maxDeltaMs: 10,
      minDeltaMs: -5,
    });
  });
});

/**
 * Risk-flag / micro-event deduplication tests.
 *
 * The deduplication layers are the mechanism that keeps the risk index honest
 * when a browser client replays a telemetry batch. Each layer is exercised
 * directly against the exported pure helpers.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  applyDiffPatch,
  applyEventToSession,
  collectPasteContents,
  computeEventFingerprint,
  computeKeystrokeMetrics,
  hasAnomalousKeystrokes,
  normalizeStatus,
  type SessionState,
} from "../src/routes/guardian.js";
import type { MicroEvent } from "../src/types.js";
import { makeConfig } from "./helpers.js";

function makeEvent(overrides: Partial<MicroEvent> = {}): MicroEvent {
  return {
    eventId: "evt-1",
    sessionId: "ses-1",
    employeeId: "op-1",
    auditId: "audit-1",
    vectorId: "tv-1",
    eventType: "KEYSTROKE",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: {},
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

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
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
    ...overrides,
  };
}

describe("computeEventFingerprint", () => {
  test("identical events produce identical fingerprints", () => {
    const a = makeEvent({ payload: { newText: "hello", changeLength: 5 } });
    const b = makeEvent({ payload: { newText: "hello", changeLength: 5 } });
    assert.equal(computeEventFingerprint(a), computeEventFingerprint(b));
  });

  test("different event types produce different fingerprints", () => {
    const a = makeEvent({ eventType: "KEYSTROKE", payload: { newText: "x" } });
    const b = makeEvent({ eventType: "PASTE", payload: { newText: "x" } });
    assert.notEqual(computeEventFingerprint(a), computeEventFingerprint(b));
  });

  test("keystroke deltas are bucketed to 10ms", () => {
    const a = makeEvent({ eventType: "KEYSTROKE", payload: { deltaMs: 101 } });
    const b = makeEvent({ eventType: "KEYSTROKE", payload: { deltaMs: 104 } });
    assert.equal(computeEventFingerprint(a), computeEventFingerprint(b));
  });

  test("deltas more than a bucket apart differ", () => {
    const a = makeEvent({ eventType: "KEYSTROKE", payload: { deltaMs: 100 } });
    const b = makeEvent({ eventType: "KEYSTROKE", payload: { deltaMs: 130 } });
    assert.notEqual(computeEventFingerprint(a), computeEventFingerprint(b));
  });

  test("content is truncated to 512 characters", () => {
    const a = makeEvent({ payload: { newText: "a".repeat(600) + "X" } });
    const b = makeEvent({ payload: { newText: "a".repeat(600) + "Y" } });
    assert.equal(computeEventFingerprint(a), computeEventFingerprint(b));
  });
});

describe("applyEventToSession", () => {
  test("PASTE appends content and counts the paste", () => {
    const session = makeSession();
    applyEventToSession(session, makeEvent({ eventType: "PASTE", payload: { newText: "abc", changeLength: 3 } }));

    assert.equal(session.pasteCount, 1);
    assert.equal(session.currentCode, "abc");
    assert.deepEqual(session.keystrokeDeltas, [3]);
  });

  test("PASTE_TRIGGER accumulates content", () => {
    const session = makeSession();
    applyEventToSession(session, makeEvent({ eventType: "PASTE_TRIGGER", payload: { pasteContent: "one" } }));
    applyEventToSession(session, makeEvent({ eventType: "PASTE_TRIGGER", payload: { pasteContent: "two" } }));

    assert.equal(session.pasteCount, 2);
    assert.equal(session.currentCode, "onetwo");
  });

  test("TAB_SWITCH and WINDOW_BLUR increment focus breaches", () => {
    const session = makeSession();
    applyEventToSession(session, makeEvent({ eventType: "TAB_SWITCH" }));
    applyEventToSession(session, makeEvent({ eventType: "WINDOW_BLUR" }));
    applyEventToSession(session, makeEvent({ eventType: "FULLSCREEN_EXIT" }));

    assert.equal(session.tabSwitchCount, 1);
    assert.equal(session.fullscreenExitCount, 2);
  });

  test("COPY_ATTEMPT is counted", () => {
    const session = makeSession();
    applyEventToSession(session, makeEvent({ eventType: "COPY_ATTEMPT", payload: { copiedLength: 50 } }));
    assert.equal(session.copyAttemptCount, 1);
  });

  test("KEYSTROKE records the inter-key delta", () => {
    const session = makeSession();
    applyEventToSession(session, makeEvent({ eventType: "KEYSTROKE", payload: { deltaMs: 45 } }));
    assert.deepEqual(session.keystrokeDeltas, [45]);
  });

  test("EDIT replaces the workspace snapshot", () => {
    const session = makeSession({ currentCode: "old" });
    applyEventToSession(session, makeEvent({ eventType: "EDIT", payload: { newText: "new" } }));
    assert.equal(session.currentCode, "new");
  });

  test("every event is appended to the event log", () => {
    const session = makeSession();
    applyEventToSession(session, makeEvent({ eventType: "KEYSTROKE" }));
    applyEventToSession(session, makeEvent({ eventType: "SUBMIT" }));
    assert.equal(session.events.length, 2);
  });
});

describe("applyDiffPatch", () => {
  test("appends a raw patch fragment", () => {
    assert.equal(applyDiffPatch("abc", "def"), "abcdef");
  });

  test("extracts added lines from a unified diff", () => {
    const diff = "@@ -1,2 +1,2 @@\n context\n+added one\n+added two";
    assert.equal(applyDiffPatch("original", diff), "added one\nadded two");
  });

  test("ignores the +++ file header", () => {
    const diff = "--- a/f\n+++ b/f\n+real";
    assert.equal(applyDiffPatch("x", diff), "real");
  });

  test("keeps the original when the diff adds nothing", () => {
    const diff = "@@ -1,1 +1,1 @@\n-removed";
    assert.equal(applyDiffPatch("original", diff), "original");
  });
});

describe("hasAnomalousKeystrokes", () => {
  const config = makeConfig();

  test("requires at least ten samples", () => {
    assert.equal(hasAnomalousKeystrokes([10, 10, 10], config), false);
  });

  test("flags a majority of sub-threshold intervals", () => {
    assert.equal(hasAnomalousKeystrokes(new Array(10).fill(20), config), true);
  });

  test("does not flag human-paced typing", () => {
    assert.equal(hasAnomalousKeystrokes(new Array(10).fill(200), config), false);
  });

  test("uses the configured threshold", () => {
    const strict = makeConfig();
    strict.security.minHumanKeystrokeMs = 500;
    assert.equal(hasAnomalousKeystrokes(new Array(10).fill(200), strict), true);
  });
});

describe("computeKeystrokeMetrics", () => {
  test("returns zeros for an empty sample", () => {
    assert.deepEqual(computeKeystrokeMetrics([]), {
      avgDeltaMs: 0,
      maxDeltaMs: 0,
      minDeltaMs: 0,
    });
  });

  test("computes average, max and min", () => {
    const metrics = computeKeystrokeMetrics([100, 200, 300]);
    assert.equal(metrics.avgDeltaMs, 200);
    assert.equal(metrics.maxDeltaMs, 300);
    assert.equal(metrics.minDeltaMs, 100);
  });
});

describe("collectPasteContents", () => {
  test("collects both PASTE and PASTE_TRIGGER payloads", () => {
    const contents = collectPasteContents([
      makeEvent({ eventType: "PASTE", payload: { newText: "a" } }),
      makeEvent({ eventType: "PASTE_TRIGGER", payload: { pasteContent: "b" } }),
      makeEvent({ eventType: "KEYSTROKE", payload: { char: "c" } }),
    ]);

    assert.deepEqual(contents, ["a", "b"]);
  });
});

describe("normalizeStatus", () => {
  test("passes through valid statuses", () => {
    assert.equal(normalizeStatus("locked"), "locked");
    assert.equal(normalizeStatus("investigating"), "investigating");
  });

  test("falls back to active for unknown statuses", () => {
    assert.equal(normalizeStatus("banana"), "active");
    assert.equal(normalizeStatus(""), "active");
  });

  test("does not leak the terminated status into the active registry", () => {
    assert.equal(normalizeStatus("terminated"), "active");
  });
});

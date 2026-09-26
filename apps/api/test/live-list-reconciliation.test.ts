/**
 * The live-list reconciliation rule.
 *
 * ── Why this is unit-tested and not only route-tested ─────────────────
 *
 * `reconcileLiveList` is a pure function, and it is the thing that carries the invariant:
 * *a live read must not report a durable-authoritative field with a value the durable
 * document contradicts.* The states it has to handle are exactly the ones that are awkward
 * to produce through HTTP — a durable document newer than memory, a durable-only session, a
 * page where some rows reconciled and some did not, a store that did not answer.
 *
 * The route tests in `live-list-multi-writer.test.ts` prove the wiring. These prove the
 * rule, including the refusals, because a merge that has only ever been observed agreeing
 * with itself is not a merge anyone can trust.
 *
 * No database, no clock, no network: the instant is passed in.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  reconcileLiveList,
  type LocalLiveSession,
  type ReconcileLiveListOptions,
} from "../src/services/session-reconciliation.js";

/** A fixed instant, so expiry is asserted exactly rather than approximately. */
const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const TTL_SECONDS = 3600;
const ALERT_THRESHOLD = 75;

/** An instant `minutes` before NOW. */
function ago(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function localSession(overrides: Partial<LocalLiveSession> = {}): LocalLiveSession {
  return {
    sessionId: "s1",
    employeeId: "op-1",
    matrixId: "audit-1",
    targetSystem: "Core Trading Ledger",
    status: "active",
    deployedAt: ago(60),
    lastActivityAt: ago(1),
    riskIndex: 0,
    eventCount: 0,
    pasteCount: 0,
    tabSwitchCount: 0,
    focusLossCount: 0,
    copyAttemptCount: 0,
    ephemeralStateAvailable: true,
    ...overrides,
  };
}

function durableDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "s1",
    employeeId: "op-1",
    matrixId: "audit-1",
    targetSystem: "Core Trading Ledger",
    status: "active",
    eventCount: 0,
    pasteCount: 0,
    tabSwitchCount: 0,
    focusLossCount: 0,
    copyAttemptCount: 0,
    peakRiskScore: 0,
    deployedAt: ago(60),
    updatedAt: ago(1),
    ...overrides,
  };
}

function reconcile(
  local: LocalLiveSession[],
  durable: Record<string, unknown>[] | null,
  options: Partial<ReconcileLiveListOptions> = {},
) {
  return reconcileLiveList(local, durable, {
    ttlSeconds: TTL_SECONDS,
    nowMs: NOW,
    alertThreshold: ALERT_THRESHOLD,
    ...options,
  });
}

describe("a durable status contradicts this process's cache", () => {
  test("a durably terminated session is dropped, not reported active", () => {
    const result = reconcile(
      [localSession({ status: "active" })],
      [durableDocument({ status: "terminated" })],
    );

    assert.deepEqual(result.sessions, []);
    assert.deepEqual(result.dropped, [{ sessionId: "s1", reason: "terminated" }]);
    assert.equal(result.reconciled, true);
  });

  test("the divergence is reported as a repair carrying the durable document", () => {
    const document = durableDocument({ status: "terminated" });
    const result = reconcile([localSession({ status: "active" })], [document]);

    assert.equal(result.repairs.length, 1);
    assert.equal(result.repairs[0]!.sessionId, "s1");
    assert.equal(result.repairs[0]!.status, "terminated");
    // The document travels with the repair so the caller does not pay a second read.
    assert.equal(result.repairs[0]!.durable, document);
  });

  test("a durable lock overrides a stale local active, and is labelled durable", () => {
    const result = reconcile(
      [localSession({ status: "active" })],
      [durableDocument({ status: "locked" })],
    );

    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]!.status, "locked");
    assert.equal(result.sessions[0]!.statusSource, "durable");
    assert.equal(result.repairs.length, 1);
  });

  test("a local status that is already terminated is dropped without a document", () => {
    const result = reconcile([localSession({ status: "terminated" })], []);

    assert.deepEqual(result.sessions, []);
    assert.deepEqual(result.dropped, [{ sessionId: "s1", reason: "terminated" }]);
    // Nothing durable to repair toward, so there is no repair.
    assert.deepEqual(result.repairs, []);
  });

  test("no repair is emitted when the cache already agrees", () => {
    const result = reconcile(
      [localSession({ status: "locked" })],
      [durableDocument({ status: "locked" })],
    );

    assert.equal(result.sessions[0]!.status, "locked");
    assert.deepEqual(result.repairs, []);
  });
});

describe("another process's sessions", () => {
  test("a session only the durable document knows about is added", () => {
    const result = reconcile([], [durableDocument({ sessionId: "other" })]);

    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]!.sessionId, "other");
    assert.equal(result.sessions[0]!.statusSource, "durable");
    assert.deepEqual(result.addedFromDurable, ["other"]);
  });

  test("a durable-only session offers no ephemeral state, and says so", () => {
    const result = reconcile([], [durableDocument({ sessionId: "other" })]);

    // Nothing is ingested here, so there is no workspace and no payload. That is a
    // statement about this process, not about the session.
    assert.equal(result.sessions[0]!.ephemeralStateAvailable, false);
  });

  test("a durably terminated session is not added", () => {
    const result = reconcile(
      [],
      [durableDocument({ sessionId: "other", status: "terminated" })],
    );

    assert.deepEqual(result.sessions, []);
    assert.deepEqual(result.dropped, [{ sessionId: "other", reason: "terminated" }]);
  });

  test("an expired durable-only session is not added", () => {
    const result = reconcile(
      [],
      [durableDocument({ sessionId: "other", updatedAt: ago(120) })],
    );

    assert.deepEqual(result.sessions, []);
    assert.deepEqual(result.dropped, [{ sessionId: "other", reason: "expired" }]);
  });

  test("a local-only session is kept and labelled process-local", () => {
    const result = reconcile([localSession()], []);

    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]!.statusSource, "process-local");
    assert.deepEqual(result.localOnly, ["s1"]);
    assert.equal(result.reconciled, true);
  });
});

describe("counters and risk are merged, never discarded", () => {
  test("the larger event count wins in both directions", () => {
    const higherLocally = reconcile(
      [localSession({ eventCount: 15 })],
      [durableDocument({ eventCount: 13 })],
    );
    assert.equal(higherLocally.sessions[0]!.eventCount, 15);

    const higherDurably = reconcile(
      [localSession({ eventCount: 13 })],
      [durableDocument({ eventCount: 15 })],
    );
    assert.equal(higherDurably.sessions[0]!.eventCount, 15);
  });

  test("every counter is merged the same way", () => {
    const result = reconcile(
      [
        localSession({
          pasteCount: 3,
          tabSwitchCount: 7,
          focusLossCount: 2,
          copyAttemptCount: 1,
        }),
      ],
      [
        durableDocument({
          pasteCount: 5,
          tabSwitchCount: 4,
          focusLossCount: 9,
          copyAttemptCount: 6,
        }),
      ],
    );

    const row = result.sessions[0]!;
    assert.equal(row.pasteCount, 5);
    assert.equal(row.tabSwitchCount, 7);
    assert.equal(row.focusLossCount, 9);
    assert.equal(row.copyAttemptCount, 6);
    // The deprecated alias is the same number, not a second counter that could drift.
    assert.equal(row.fullscreenExitCount, row.focusLossCount);
  });

  test("a local risk payload not yet persisted is not discarded", () => {
    const result = reconcile(
      [localSession({ riskIndex: 90 })],
      [durableDocument({ peakRiskScore: 0 })],
    );

    assert.equal(result.sessions[0]!.peakRiskScore, 90);
    assert.equal(result.sessions[0]!.riskIndex, 90);
  });

  test("a durable peak score this process never saw is reported", () => {
    const result = reconcile(
      [localSession({ riskIndex: 0 })],
      [durableDocument({ peakRiskScore: 90 })],
    );

    assert.equal(result.sessions[0]!.peakRiskScore, 90);
    // The alert follows the reconciled peak, not this process's empty payload. Before the
    // reconciliation existed, a session another process scored reported 0 and no alert.
    assert.equal(result.sessions[0]!.alertTriggered, true);
  });

  test("alertTriggered is false below the threshold", () => {
    const result = reconcile(
      [localSession()],
      [durableDocument({ peakRiskScore: ALERT_THRESHOLD - 1 })],
    );

    assert.equal(result.sessions[0]!.alertTriggered, false);
  });

  test("a non-numeric counter reads as zero rather than propagating", () => {
    const result = reconcile(
      [localSession({ eventCount: Number.NaN })],
      [durableDocument({ eventCount: 4 })],
    );

    assert.equal(result.sessions[0]!.eventCount, 4);
  });
});

describe("liveness uses the more recent activity instant", () => {
  test("a durable activity instant keeps a session live when the local one is stale", () => {
    const result = reconcile(
      [localSession({ lastActivityAt: ago(120) })],
      [durableDocument({ updatedAt: ago(1) })],
    );

    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]!.liveness, "active");
  });

  test("a local activity instant keeps a session live when the durable one is stale", () => {
    const result = reconcile(
      [localSession({ lastActivityAt: ago(1) })],
      [durableDocument({ updatedAt: ago(120) })],
    );

    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]!.liveness, "active");
  });

  test("a session stale on both sides is dropped as expired", () => {
    const result = reconcile(
      [localSession({ lastActivityAt: ago(120) })],
      [durableDocument({ updatedAt: ago(120) })],
    );

    assert.deepEqual(result.sessions, []);
    assert.deepEqual(result.dropped, [{ sessionId: "s1", reason: "expired" }]);
  });

  test("a non-positive TTL disables expiry rather than expiring everything", () => {
    const result = reconcile(
      [localSession({ lastActivityAt: ago(100_000) })],
      [durableDocument({ updatedAt: ago(100_000) })],
      { ttlSeconds: 0 },
    );

    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]!.liveness, "active");
  });
});

describe("an unreachable store", () => {
  test("is reported as unreconciled, not as an empty page", () => {
    const result = reconcile([localSession()], null);

    assert.equal(result.reconciled, false);
    assert.equal(result.sessions.length, 1);
  });

  test("labels every row process-local rather than presenting it as durable truth", () => {
    const result = reconcile([localSession({ status: "locked" })], null);

    assert.equal(result.sessions[0]!.status, "locked");
    assert.equal(result.sessions[0]!.statusSource, "process-local");
  });

  test("invents nothing and drops nothing", () => {
    const empty = reconcile([], null);
    assert.deepEqual(empty.sessions, []);
    assert.equal(empty.reconciled, false);
    assert.deepEqual(empty.dropped, []);
    assert.deepEqual(empty.repairs, []);
  });

  test("still applies the local expiry predicate", () => {
    const result = reconcile([localSession({ lastActivityAt: ago(120) })], null);

    assert.deepEqual(result.sessions, []);
    assert.deepEqual(result.dropped, [{ sessionId: "s1", reason: "expired" }]);
  });
});

describe("identity and ordering", () => {
  test("identity comes from the durable document when it exists", () => {
    const result = reconcile(
      [localSession({ employeeId: "stale", matrixId: "stale", targetSystem: "stale" })],
      [
        durableDocument({
          employeeId: "op-durable",
          matrixId: "audit-durable",
          targetSystem: "SWIFT Gateway",
        }),
      ],
    );

    const row = result.sessions[0]!;
    assert.equal(row.employeeId, "op-durable");
    assert.equal(row.matrixId, "audit-durable");
    assert.equal(row.auditId, "audit-durable");
    assert.equal(row.targetSystem, "SWIFT Gateway");
  });

  test("the local identity survives when there is no document", () => {
    const result = reconcile([localSession({ employeeId: "op-local" })], []);

    assert.equal(result.sessions[0]!.employeeId, "op-local");
  });

  test("rows are ordered newest deployment first", () => {
    const result = reconcile(
      [
        localSession({ sessionId: "old", deployedAt: ago(120) }),
        localSession({ sessionId: "new", deployedAt: ago(5) }),
      ],
      [],
    );

    assert.deepEqual(
      result.sessions.map((row) => row.sessionId),
      ["new", "old"],
    );
  });

  test("a malformed deployment instant sorts last rather than reordering the page", () => {
    const result = reconcile(
      [
        localSession({ sessionId: "broken", deployedAt: "not-a-date" }),
        localSession({ sessionId: "good", deployedAt: ago(5) }),
      ],
      [],
    );

    assert.deepEqual(
      result.sessions.map((row) => row.sessionId),
      ["good", "broken"],
    );
  });

  test("a duplicate id appears once", () => {
    const result = reconcile(
      [localSession({ sessionId: "dup" }), localSession({ sessionId: "dup" })],
      [],
    );

    assert.equal(result.sessions.length, 1);
  });

  test("a durable document with no sessionId is ignored", () => {
    const result = reconcile([], [{ status: "active" }]);

    assert.deepEqual(result.sessions, []);
  });
});

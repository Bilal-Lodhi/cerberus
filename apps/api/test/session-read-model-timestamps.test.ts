/**
 * The durable timestamp readers, and the asymmetry between them.
 *
 * ── Why this is pinned rather than "fixed" ────────────────────────────
 *
 * Two readers look at a session document's timestamps and they do not agree about types:
 *
 *   `readDurableString(document, "updatedAt")` accepts a **non-empty string** and nothing else.
 *   `readDurableSessionView`'s chain does `String(value ?? …)`, so it accepts anything that is
 *   not nullish — a `Date` included.
 *
 * The reconciler uses the first for a session this process holds in memory and the second for a
 * session it does not (model §4.1 of `live-list-equivalence-model.md`). That is a real
 * inconsistency, and the obvious tidy-up — teach `readDurableString` to accept a `Date` too —
 * is **not** semantics-preserving. This file is the evidence for keeping the inconsistency and
 * documenting it instead of removing it:
 *
 *   - a document whose `updatedAt` is an ISO string gives the local-row branch a durable
 *     candidate, and the **later** of it and this process's own instant decides liveness;
 *   - the same document with a `Date` instead of the string gives that branch **nothing**, so
 *     this process's own instant decides alone.
 *
 * With a stale local instant the first is listed and the second is dropped. Making the reader
 * accept a `Date` would therefore change the answer for a document shape that only a raw driver
 * read produces — and, more importantly, it would be the first step towards the in-place
 * `updatedAt` normalisation that model §9.3 proves cannot be equivalent.
 *
 * ── What is asserted ──────────────────────────────────────────────────
 *
 * The readers' behaviour exactly as it is, the fallback chain's order, the injected-instant
 * fallback, and the millisecond truncation that `String(Date)` performs and the JSON path does
 * not. Each is a fact a future change could quietly break, and each has a stated consequence.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  readDurableSessionView,
  readDurableString,
} from "../src/services/session-read-model.js";
import { isExpired } from "../src/services/session-liveness.js";
import {
  reconcileLiveList,
  type LocalLiveSession,
} from "../src/services/session-reconciliation.js";

const NOW_MS = Date.parse("2026-03-01T12:00:00.000Z");
const TTL_SECONDS = 3600;
const RECENT = new Date(NOW_MS - 60_000);
const OLD = new Date(NOW_MS - TTL_SECONDS * 1000 - 60_000);

const OPTIONS = { ttlSeconds: TTL_SECONDS, nowMs: NOW_MS, alertThreshold: 1000 };

/** A local row with the given session id and last-activity instant. */
function localRow(sessionId: string, lastActivityAt: string): LocalLiveSession {
  return {
    sessionId,
    employeeId: "op",
    matrixId: "matrix",
    targetSystem: "system",
    status: "active",
    deployedAt: lastActivityAt,
    lastActivityAt,
    riskIndex: 0,
    eventCount: 0,
    pasteCount: 0,
    tabSwitchCount: 0,
    focusLossCount: 0,
    copyAttemptCount: 0,
    ephemeralStateAvailable: true,
  };
}

/** A minimal durable document, with the wire representation of a recent `updatedAt`. */
function document(updatedAt: unknown): Record<string, unknown> {
  return {
    sessionId: "adv-reader",
    employeeId: "op",
    matrixId: "matrix",
    targetSystem: "system",
    status: "active",
    updatedAt,
    deployedAt: RECENT.toISOString(),
    createdAt: RECENT.toISOString(),
  };
}

describe("readDurableString accepts a non-empty string and nothing else", () => {
  test("the values it accepts", () => {
    assert.equal(readDurableString({ updatedAt: "2026-03-01T11:59:00.000Z" }, "updatedAt"), "2026-03-01T11:59:00.000Z");
    // Whitespace is a non-empty string. The reader does not trim, and a value of `" "` is
    // therefore passed on to `Date.parse`, which refuses it — so the *parser* is what rejects
    // it, not the reader. Asserting this keeps the boundary between the two explicit.
    assert.equal(readDurableString({ updatedAt: " " }, "updatedAt"), " ");
  });

  test("the values it refuses, including a BSON Date", () => {
    const refused: unknown[] = [
      "",
      null,
      undefined,
      0,
      1_700_000_000_000,
      true,
      false,
      {},
      [],
      RECENT,
    ];

    for (const value of refused) {
      assert.equal(
        readDurableString({ updatedAt: value }, "updatedAt"),
        null,
        `readDurableString accepted ${Object.prototype.toString.call(value)}, which the ` +
          "durable-only branch would then treat as a usable activity instant",
      );
    }

    assert.equal(readDurableString(null, "updatedAt"), null);
    assert.equal(readDurableString({}, "updatedAt"), null);
  });
});

describe("the fallback chain, in order", () => {
  test("updatedAt wins whenever it is present, even when it cannot be parsed", () => {
    // `??`, not "the first parseable value": a present-but-unusable `updatedAt` blocks the
    // fallback, which is what makes an unreadable timestamp mean "never expires" rather than
    // "fall back to createdAt".
    const view = readDurableSessionView(
      { updatedAt: "not-a-date", deployedAt: RECENT.toISOString(), createdAt: RECENT.toISOString() },
      "adv-reader",
      NOW_MS,
    );
    assert.equal(view.lastActivityAt, "not-a-date");
  });

  test("deployedAt is used when updatedAt is absent or null", () => {
    for (const absent of [undefined, null]) {
      const view = readDurableSessionView(
        { updatedAt: absent, deployedAt: RECENT.toISOString(), createdAt: OLD.toISOString() },
        "adv-reader",
        NOW_MS,
      );
      assert.equal(view.lastActivityAt, RECENT.toISOString());
      assert.equal(view.deployedAt, RECENT.toISOString());
    }
  });

  test("createdAt is used only when both updatedAt and deployedAt are absent or null", () => {
    const view = readDurableSessionView(
      { createdAt: OLD.toISOString() },
      "adv-reader",
      NOW_MS,
    );
    assert.equal(view.lastActivityAt, OLD.toISOString());
    assert.equal(view.deployedAt, OLD.toISOString());
  });

  test("a document with no timestamp at all is dated to the instant it is given", () => {
    // The fallback is the **request instant**, not a second reading of the wall clock: the
    // reader takes the reconciler's injected `nowMs`. Before that parameter existed this read
    // `Date.now()` inside the row loop, so the page was not a function of `(documents, now)`.
    const view = readDurableSessionView({}, "adv-reader", NOW_MS);
    assert.equal(
      Date.parse(view.deployedAt),
      NOW_MS,
      "the no-timestamp fallback is not the injected instant",
    );
    assert.equal(view.lastActivityAt, view.deployedAt);
  });

  test("the default is the wall clock, so a caller with no injected clock is unaffected", () => {
    const before = Date.now();
    const view = readDurableSessionView({}, "adv-reader");
    const after = Date.now();

    const parsed = Date.parse(view.deployedAt);
    assert.ok(
      parsed >= before - 1 && parsed <= after + 1,
      `the default fallback instant ${view.deployedAt} is not the wall clock`,
    );
  });
});

describe("the two readers disagree about a Date, and that disagreement is load-bearing", () => {
  test("the same document is listed or dropped depending only on its updatedAt's type", () => {
    const staleLocal = localRow("adv-reader", OLD.toISOString());

    const asWire = document(RECENT.toISOString());
    const asDriverDocument = document(RECENT);

    // The two documents describe the same instant. Only one of them gives the local-row branch
    // a durable candidate, because `readDurableString` refuses a `Date`.
    assert.equal(readDurableString(asWire, "updatedAt"), RECENT.toISOString());
    assert.equal(readDurableString(asDriverDocument, "updatedAt"), null);

    const listedFromWire = reconcileLiveList([staleLocal], [asWire], OPTIONS).sessions;
    const listedFromDate = reconcileLiveList([staleLocal], [asDriverDocument], OPTIONS).sessions;

    assert.deepEqual(
      listedFromWire.map((row) => row.sessionId),
      ["adv-reader"],
      "the wire document should be listed: its durable instant is later than this process's",
    );
    assert.deepEqual(
      listedFromDate,
      [],
      "the raw document should be dropped: with no durable candidate, this process's own " +
        "stale instant expires it",
    );
  });

  test("teaching the reader to accept a Date would flip that verdict, which is why it does not", () => {
    // The rejected alternative, spelled out: a reader that also accepted a `Date`. Evaluating
    // both candidates through the shipped `isExpired` is what makes this a demonstration rather
    // than an assertion about a hypothetical — the difference below is the difference in the
    // liveness verdict, computed by the same function the reconciler calls.
    function readTimestampAcceptingDates(
      source: Record<string, unknown> | null,
      key: string,
    ): string | null {
      const value = source?.[key];
      if (value instanceof Date) return value.toISOString();
      return typeof value === "string" && value.length > 0 ? value : null;
    }

    const asDriverDocument = document(RECENT);
    const clock = { now: () => NOW_MS };

    const shipped = readDurableString(asDriverDocument, "updatedAt");
    const alternative = readTimestampAcceptingDates(asDriverDocument, "updatedAt");

    assert.equal(shipped, null, "the shipped reader now accepts a Date, so this is stale");
    assert.equal(alternative, RECENT.toISOString());

    const activity = (persistedUpdatedAt: string | null) => ({
      lastActivityAt: OLD.toISOString(),
      persistedUpdatedAt,
    });

    assert.equal(
      isExpired(activity(shipped), TTL_SECONDS, clock),
      true,
      "with no durable candidate, this process's stale instant expires the session",
    );
    assert.equal(
      isExpired(activity(alternative), TTL_SECONDS, clock),
      false,
      "with the Date accepted, the later instant wins and the session is live — the flip that " +
        "makes the shared-reader change a semantic change",
    );
  });

  test("String(Date) loses milliseconds and the JSON path does not", () => {
    // The reason the wire path is the one the model describes, and the reason migration 0005
    // reads a BSON `Date` through `getTime()` rather than through `String()`.
    const withMilliseconds = new Date(NOW_MS - TTL_SECONDS * 1000 + 1);

    assert.equal(
      Date.parse(String(withMilliseconds)),
      withMilliseconds.getTime() - 1,
      "this runtime kept milliseconds in String(Date), so the truncation is not demonstrated",
    );
    assert.equal(
      Date.parse(JSON.parse(JSON.stringify(withMilliseconds)) as string),
      withMilliseconds.getTime(),
      "the JSON path lost milliseconds",
    );

    // And through the chain the truncation is observable, because the chain stringifies.
    const view = readDurableSessionView(
      { updatedAt: withMilliseconds },
      "adv-reader",
      NOW_MS,
    );
    assert.equal(Date.parse(view.lastActivityAt), withMilliseconds.getTime() - 1);
  });
});

/**
 * The live-list normal form, checked against the semantics it has to preserve.
 *
 * ── The invariant this file exists for ────────────────────────────────
 *
 * `docs/development/live-list-equivalence-model.md` §9.2 derives the one property migration
 * `0005` has to establish for a bounded live-list query to be possible at all:
 *
 * ```
 * for every document d and every request instant T:
 *   status(d) ∈ {active, locked} ∧ liveListUpdatedAt(d) > T - ttl
 *     <=>  d is live under the current durable-only rule
 * ```
 *
 * The right-hand side is evaluated by calling **`reconcileLiveList`** — the shipped semantics,
 * in another workspace package, reached through its own module — over the *migrated* document.
 * That is what stops this from being a test that restates its own implementation: the
 * expectation comes from the code the migration has to agree with, at instants the migration
 * never sees.
 *
 * The sweep of instants matters. A single `T` would pass for a `liveListUpdatedAt` that is
 * merely "recent", and the difficult cases are the rows with **no verifiable instant at all** —
 * the current reader dates those to the request instant on every read, so they are live
 * forever. The sweep includes a clock a hundred years past the fixture, which is what a fixed
 * sentinel has to survive and what a "use `now`" repair would fail.
 *
 * ── What is asserted independently ────────────────────────────────────
 *
 * The status normalisation is a deliberate re-implementation inside the storage package (which
 * may not import `apps/api`), so it is checked **against** `normalizeStatus` on every value in
 * the model's table rather than being trusted to match.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildSessionListUpdate,
  MAX_LIVENESS_INSTANT,
  normalisedStatusOf,
  parseLivenessValue,
  planChangesDocument,
  planSessionListNormalisation,
  readLivenessInstant,
} from "../../../packages/mcp-mongodb/src/session-list-normalisation.js";
import {
  PERSISTED_SESSION_STATUSES,
  normalizeStatus,
} from "../src/services/session-status.js";
import { reconcileLiveList } from "../src/services/session-reconciliation.js";
import {
  ADVERSARIAL_NOW_MS,
  ADVERSARIAL_SESSION_ROWS,
  ADVERSARIAL_TTL_SECONDS,
  toApiDocument,
} from "./support/release-fixture.js";

const HOUR_MS = ADVERSARIAL_TTL_SECONDS * 1000;

/** Applies a plan the way the migration does, to a copy of the document. */
function migrated(document: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...document };
  const update = buildSessionListUpdate(planSessionListNormalisation(copy));
  if (!update) return copy;
  return { ...copy, ...(update["$set"] as Record<string, unknown>) };
}

/**
 * Every request instant the invariant is checked at.
 *
 * The fixture instant itself, a year either side of it, and a hundred years past it — the last
 * one specifically to prove that the "never expires" sentinel is still ahead of a clock no
 * deployment will reach, rather than merely ahead of today's.
 */
const CLOCKS: readonly number[] = [
  ADVERSARIAL_NOW_MS - 365 * 24 * HOUR_MS,
  ADVERSARIAL_NOW_MS - 1,
  ADVERSARIAL_NOW_MS,
  ADVERSARIAL_NOW_MS + 1,
  ADVERSARIAL_NOW_MS + 365 * 24 * HOUR_MS,
  ADVERSARIAL_NOW_MS + 100 * 365 * 24 * HOUR_MS,
];

describe("the normal form preserves the durable-only liveness rule", () => {
  test("liveListUpdatedAt > cutoff is equivalent to the reconciler listing the row, at every clock", () => {
    for (const row of ADVERSARIAL_SESSION_ROWS) {
      const document = migrated(toApiDocument(row.document));

      const status = String(document["status"] ?? "");
      const statusIsLive = status === "active" || status === "locked";
      // A document with no usable `sessionId` is skipped by the reconciler before any liveness
      // question is asked, so the predicate's job for it is nothing at all.
      const hasUsableSessionId = String(document["sessionId"] ?? "").length > 0;
      const stored = document["liveListUpdatedAt"];
      assert.ok(stored instanceof Date, `${row.label}: liveListUpdatedAt is not a Date`);
      const instant = (stored as Date).getTime();

      for (const nowMs of CLOCKS) {
        const cutoff = nowMs - HOUR_MS;
        const listed = reconcileLiveList([], [document], {
          ttlSeconds: ADVERSARIAL_TTL_SECONDS,
          nowMs,
          alertThreshold: 1000,
        }).sessions.length;

        const predicate = hasUsableSessionId && statusIsLive && instant > cutoff;
        assert.equal(
          listed === 1,
          predicate,
          `${row.label}: at ${new Date(nowMs).toISOString()} the reconciler listed the row ` +
            `${listed === 1} time(s) but the predicate says ${predicate} ` +
            `(status ${JSON.stringify(status)}, ` +
            `instant ${new Date(instant).toISOString()}, ` +
            `cutoff ${new Date(cutoff).toISOString()})`,
        );
      }
    }
  });

  test("the instant is derived from the same chain link the reconciler would use", () => {
    // One tier below the equivalence above: the invariant could hold while the field's *value*
    // is wrong for every document whose row happens to agree. This pins where each instant came
    // from, so a change that swapped `deployedAt` for `createdAt` would fail even in a world
    // where both happened to be recent.
    const cases: ReadonlyArray<[string, string]> = [
      ["updatedAt recent BSON Date", "updatedAt"],
      ["updatedAt old BSON Date (expired)", "updatedAt"],
      ["updatedAt ISO string (live)", "updatedAt"],
      ["updatedAt missing, deployedAt recent", "deployedAt"],
      ["updatedAt null, deployedAt recent", "deployedAt"],
      ["updatedAt unparseable string", "updatedAt"],
      ["updatedAt number (epoch ms, unparseable as a string)", "updatedAt"],
      ["createdAt recent, no deployedAt, no updatedAt (live by createdAt)", "createdAt"],
      ["createdAt old, no deployedAt, no updatedAt (expired by createdAt)", "createdAt"],
      // `deployedAt` is present-but-empty, so `??` never reaches `createdAt`.
      ["deployedAt empty string blocks createdAt (permanently live)", "deployedAt"],
      ["no updatedAt, no deployedAt, no createdAt (permanently live)", "unverifiable"],
    ];

    for (const [label, expectedSource] of cases) {
      const row = ADVERSARIAL_SESSION_ROWS.find((candidate) => candidate.label === label);
      assert.ok(row, `the fixture no longer has a row labelled "${label}"`);

      assert.equal(
        readLivenessInstant(toApiDocument(row!.document)).source,
        expectedSource,
        `${label}: the instant was taken from the wrong chain link`,
      );
    }
  });

  test("a document with no verifiable instant keeps a sentinel that outlives any plausible clock", () => {
    const rows = [
      "updatedAt unparseable string",
      "updatedAt empty string",
      "updatedAt boolean",
      "updatedAt object",
      "deployedAt empty string blocks createdAt (permanently live)",
      "no updatedAt, no deployedAt, no createdAt (permanently live)",
    ];

    for (const label of rows) {
      const row = ADVERSARIAL_SESSION_ROWS.find((candidate) => candidate.label === label);
      assert.ok(row, `the fixture no longer has a row labelled "${label}"`);

      const plan = planSessionListNormalisation(toApiDocument(row!.document));
      assert.equal(plan.source, "unverifiable", `${label}: expected the unverifiable sentinel`);
      assert.equal(
        plan.liveListUpdatedAt?.getTime(),
        MAX_LIVENESS_INSTANT,
        `${label}: the sentinel is not the maximum representable instant, so it would expire`,
      );
    }

    // Not "now": a migration that dated these rows to the moment it ran would make them expire
    // one TTL later, which is a different answer from the one the current reader gives.
    assert.ok(
      MAX_LIVENESS_INSTANT - ADVERSARIAL_NOW_MS > 365 * 24 * HOUR_MS,
      "the sentinel is not far enough ahead of the fixture instant to be a sentinel",
    );
  });
});

describe("the normal form is a normal form", () => {
  test("applying it twice changes nothing the second time", () => {
    for (const row of ADVERSARIAL_SESSION_ROWS) {
      const once = migrated(toApiDocument(row.document));
      const plan = planSessionListNormalisation(once);

      assert.equal(
        planChangesDocument(plan),
        false,
        `${row.label}: a second pass would still rewrite ` +
          `${JSON.stringify(buildSessionListUpdate(plan))}`,
      );
      assert.equal(plan.status, null, `${row.label}: status is not stable under normalisation`);
      assert.equal(
        plan.liveListUpdatedAt,
        null,
        `${row.label}: liveListUpdatedAt is not stable under normalisation`,
      );
    }
  });

  test("the write touches only the two normal-form fields", () => {
    // The reconciler and every other read surface consult `status`, `updatedAt`, `deployedAt`,
    // `createdAt`, the counters and `peakRiskScore`. Only the first is a field this migration may
    // change, and `updatedAt` in particular is off limits — rewriting it changes the answer for
    // the malformed rows the model's §9.3 works through.
    for (const row of ADVERSARIAL_SESSION_ROWS) {
      const update = buildSessionListUpdate(
        planSessionListNormalisation(toApiDocument(row.document)),
      );
      if (!update) continue;

      const written = Object.keys(update["$set"] as Record<string, unknown>).sort();
      assert.deepEqual(
        written.filter((key) => key !== "status" && key !== "liveListUpdatedAt"),
        [],
        `${row.label}: the migration wrote a field outside the normal form: ${written.join(", ")}`,
      );
      assert.deepEqual(Object.keys(update), ["$set"], `${row.label}: an operator other than $set`);
    }
  });

  test("a document that already holds the normal form produces no update document at all", () => {
    const already = migrated(
      toApiDocument(ADVERSARIAL_SESSION_ROWS.find((row) => row.label === "status active")!.document),
    );
    assert.equal(buildSessionListUpdate(planSessionListNormalisation(already)), null);
  });

  test("the stored timestamp type is part of the form, not just its value", () => {
    // A hand-edited ISO string parses to the same instant as the `Date` the migration would
    // write, but a range query compares within a BSON type bracket, so a string is not the same
    // stored value as a date. The plan rewrites it.
    const row = ADVERSARIAL_SESSION_ROWS.find(
      (candidate) => candidate.label === "updatedAt ISO string (live)",
    )!;
    const document = toApiDocument(row.document);
    const plan = planSessionListNormalisation({
      ...document,
      liveListUpdatedAt: String(document["updatedAt"]),
    });

    assert.ok(plan.liveListUpdatedAt instanceof Date, "a string instant was left in place");
  });
});

describe("the normaliser cannot drift from the API's status vocabulary", () => {
  test("normalisedStatusOf agrees with normalizeStatus on every value in the model's table", () => {
    // The storage package deliberately re-implements this rather than importing `apps/api`.
    // That makes agreement something to check rather than something to assume, and every value
    // the model's §3 table names is checked — including the two that are easy to get wrong:
    // a case variant, which is *not* terminal, and a non-string, which the API stringifies
    // before normalising.
    const values: unknown[] = [
      ...PERSISTED_SESSION_STATUSES,
      "flagged",
      "investigating",
      "cleared",
      "",
      " ",
      "Terminated",
      "TERMINATED",
      "Active",
      "unknown",
      "null",
      "undefined",
      "[object Object]",
      "0",
      "1",
      0,
      1,
      42,
      true,
      false,
      null,
      undefined,
      { at: "whenever" },
      ["active"],
      [],
    ];

    for (const value of values) {
      // The API's reader is `normalizeStatus(String(d.status ?? "active"))`.
      const apiAnswer = normalizeStatus(String(value ?? "active"));
      assert.equal(
        normalisedStatusOf(value),
        apiAnswer,
        `the two normalisers disagree about ${JSON.stringify(value)}`,
      );
    }
  });

  test("a stored 'terminated' is never rewritten", () => {
    const plan = planSessionListNormalisation({ status: "terminated" });
    assert.equal(plan.status, null, "the terminal status was rewritten");
  });
});

describe("parsing a chain value mirrors the reader exactly", () => {
  test("the values V8 parses as legacy instants are parsed, not rejected", () => {
    // These two are the reason the migration cannot decide "this is not a Date, therefore it has
    // no instant". `Date.parse("123")` is the year 12 and `Date.parse("1,2")` is 2001, and the
    // current reader treats both as real instants — one permanently expired, one not.
    assert.equal(parseLivenessValue(123), Date.parse("123"));
    assert.equal(parseLivenessValue([1, 2]), Date.parse("1,2"));
    assert.ok(Number.isFinite(parseLivenessValue(123)));
    assert.ok(Number.isFinite(parseLivenessValue([1, 2])));
  });

  test("the values V8 cannot parse are rejected", () => {
    for (const value of [
      "not-a-date",
      "",
      "nope",
      true,
      false,
      1_700_000_000_000,
      { at: "whenever" },
      ["nope"],
      null,
      undefined,
    ]) {
      assert.equal(
        parseLivenessValue(value),
        null,
        `${JSON.stringify(value)} was treated as an instant but the reader does not`,
      );
    }
  });

  test("a Date keeps its milliseconds, which String(Date) would lose", () => {
    const withMilliseconds = new Date(ADVERSARIAL_NOW_MS - HOUR_MS + 1);
    assert.equal(
      parseLivenessValue(withMilliseconds),
      withMilliseconds.getTime(),
      "a BSON Date was truncated to the second",
    );
    // And the truncation is real, which is why the wire path is the one the model describes.
    assert.equal(Date.parse(String(withMilliseconds)), withMilliseconds.getTime() - 1);
  });
});

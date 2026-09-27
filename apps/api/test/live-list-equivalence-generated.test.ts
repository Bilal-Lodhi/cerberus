/**
 * The equivalence proof, over generated fixtures.
 *
 * ── What is being proven ──────────────────────────────────────────────
 *
 * The claim this cycle has to establish is not "the bounded query returns the same sessions on the
 * fixtures we thought of". It is:
 *
 * > For every stored document — including legacy, hand-edited and malformed ones — the page built
 * > from the **bounded** query equals the page the **previous build** produced from a full scan.
 *
 * One fixture cannot support that, and neither can a hand-written table: the space is the product
 * of status values, timestamp types and validity, age relative to the cutoff, migration state and
 * this process's own memory. So this file generates that space — seeded and deterministic, so a
 * failure names a fixture that can be regenerated — and checks the whole equivalence on each one.
 *
 * ── The two sides, stated so they cannot collapse into one ────────────
 *
 * ```
 * expected = reconcileLiveList(local, wire(preMigrationDocuments))          // old build: scan + reconcile
 * actual   = reconcileLiveList(local, wire(selectBounded(migratedDocuments)))  // new build: bound + reconcile
 * ```
 *
 * The left side is the **shipped reconciler over the documents as they were**, converted to the
 * wire form the MCP adapter produces. The right side applies migration `0005`'s plan, then the
 * bounded selection, then the same reconciler. Comparing them is the whole proof, and it is
 * deliberately not a comparison of two implementations of the same idea.
 *
 * `selectBounded` is a mirror of MongoDB's comparison semantics rather than of the filter builder,
 * and it is grounded against a real server by
 * `apps/api/test/release/live-list-mirror-vs-query.test.ts`. Without that grounding the property
 * test would be asserting that a JavaScript function agrees with itself.
 *
 * ── What is compared ──────────────────────────────────────────────────
 *
 * `sessions` in full and in order, plus `repairs`, `localOnly`, `addedFromDurable` and
 * `reconciled`. Not `dropped`: it counts the documents the request fetched and found not live, so
 * a bounded request reports fewer, and that difference is asserted separately in
 * `live-list-bounded-query.test.ts` rather than hidden here.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { reconcileLiveList } from "../src/services/session-reconciliation.js";
import { toApiDocument } from "./support/release-fixture.js";
import {
  generateFixtures,
  selectBounded,
  type GeneratedFixture,
} from "./support/bounded-select.js";

/** The seed every run uses. Pinned so a failure is reproducible from this file alone. */
const SEED = 0xc3b3e5;
const FIXTURE_COUNT = 60;

const FIXTURES = generateFixtures({ seed: SEED, count: FIXTURE_COUNT });

/** The cutoff the bounded query is given, mirroring the route's arithmetic. */
function cutoffOf(fixture: GeneratedFixture): Date | null {
  if (!Number.isFinite(fixture.ttlSeconds) || fixture.ttlSeconds <= 0) return null;
  return new Date(fixture.nowMs - fixture.ttlSeconds * 1000);
}

/** The options the reconciler is driven with. */
function optionsOf(fixture: GeneratedFixture) {
  return {
    ttlSeconds: fixture.ttlSeconds,
    nowMs: fixture.nowMs,
    alertThreshold: 1000,
  };
}

describe("the generated fixture set", () => {
  test("is deterministic, so a failure is reproducible from the seed", () => {
    const again = generateFixtures({ seed: SEED, count: FIXTURE_COUNT });
    assert.deepEqual(
      again.map((fixture) => fixture.name),
      FIXTURES.map((fixture) => fixture.name),
      "the generator produced a different set for the same seed",
    );
  });

  test("covers the axes the model's case tables name, rather than one happy path", () => {
    // A property test over a space that happens to be uniform proves very little, so the coverage
    // is asserted rather than assumed.
    const statuses = new Set<string>();
    const updatedAtTypes = new Set<string>();
    let nonFiniteTtl = 0;
    let unclassified = 0;
    let withLocalRows = 0;
    let boundaryDocuments = 0;

    for (const fixture of FIXTURES) {
      if (!Number.isFinite(fixture.ttlSeconds) || fixture.ttlSeconds <= 0) nonFiniteTtl += 1;
      if (fixture.unclassified > 0) unclassified += fixture.unclassified;
      if (fixture.localRows.length > 0) withLocalRows += 1;

      const cutoff = cutoffOf(fixture);
      for (const document of fixture.documents) {
        const status = document["status"];
        statuses.add(status === undefined ? "<absent>" : typeof status === "string" ? status : typeof status);

        const updatedAt = document["updatedAt"];
        updatedAtTypes.add(
          updatedAt === undefined
            ? "<absent>"
            : updatedAt === null
              ? "<null>"
              : updatedAt instanceof Date
                ? "Date"
                : Array.isArray(updatedAt)
                  ? "array"
                  : typeof updatedAt,
        );

        if (cutoff && updatedAt instanceof Date) {
          const delta = updatedAt.getTime() - cutoff.getTime();
          if (Math.abs(delta) <= 1) boundaryDocuments += 1;
        }
      }
    }

    for (const status of ["active", "locked", "terminated", "Terminated", "cleared", "", "<absent>"]) {
      assert.ok(statuses.has(status), `no generated document has status ${JSON.stringify(status)}`);
    }
    for (const type of ["Date", "string", "number", "boolean", "object", "array", "<absent>", "<null>"]) {
      assert.ok(
        updatedAtTypes.has(type),
        `no generated document has an updatedAt of type ${type}`,
      );
    }
    assert.ok(nonFiniteTtl > 0, "no fixture disables expiry");
    assert.ok(unclassified > 0, "no fixture contains a document the migration has not classified");
    assert.ok(withLocalRows > 0, "no fixture holds a session in this process's memory");
    assert.ok(
      boundaryDocuments > 0,
      "no generated document sits within a millisecond of its cutoff, so the boundary is untested",
    );
  });
});

describe("the bounded query is equivalent on every generated fixture", () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.name}: the bounded page equals the unbounded page`, () => {
      const cutoff = cutoffOf(fixture);
      const options = optionsOf(fixture);

      // ── The previous build: every document, as it was, through the shipped reconciler ──
      const preMigrationWire = fixture.documents.map(toApiDocument);
      const expected = reconcileLiveList(fixture.localRows, preMigrationWire, options);

      // ── This build: the migration applied, the bound applied, the same reconciler ──
      //
      // The two sides take **different inputs** — the documents as the previous release left them,
      // and the same documents after migration `0005` — which is what makes this an equivalence
      // between two builds rather than a comparison of a value with itself. `selectBounded` is the
      // mirror of the server's selection, grounded against a real MongoDB elsewhere.
      const bounded = selectBounded(fixture.migratedDocuments, {
        liveAfter: cutoff,
        sessionIds: fixture.localRows.map((row) => row.sessionId),
      });
      const actual = reconcileLiveList(fixture.localRows, bounded.map(toApiDocument), options);

      assert.deepEqual(actual.sessions, expected.sessions, "the page differs");

      // ── The repairs, by decision rather than by payload ──
      //
      // A repair carries the durable document so the caller can correct its cache without a second
      // read, and that document is *by construction* the one the build sees: the previous build
      // hands over the document it scanned, this build hands over the migrated one. The decision —
      // which session, and to what status — is what has to be identical, and it is.
      const repairDecisions = (
        repairs: ReadonlyArray<{ sessionId: string; status: string }>,
      ): Array<{ sessionId: string; status: string }> =>
        repairs.map((repair) => ({ sessionId: repair.sessionId, status: repair.status }));

      assert.deepEqual(
        repairDecisions(actual.repairs),
        repairDecisions(expected.repairs),
        "the cache repairs differ",
      );
      for (const repair of actual.repairs) {
        assert.equal(
          repair.durable["status"],
          repair.status,
          "a repair's payload does not carry the status it is repairing to",
        );
      }

      assert.deepEqual(actual.localOnly, expected.localOnly, "localOnly differs");
      assert.deepEqual(
        [...actual.addedFromDurable].sort(),
        [...expected.addedFromDurable].sort(),
        "the durable-only sessions differ",
      );
      assert.equal(actual.reconciled, expected.reconciled, "reconciled differs");
    });
  }

  test("the bound is a real reduction across the whole generated set", () => {
    // The equivalence would also hold if `selectBounded` returned everything, so the reduction is
    // asserted over the set as a whole rather than trusted.
    let examined = 0;
    let stored = 0;

    for (const fixture of FIXTURES) {
      const bounded = selectBounded(fixture.documents, {
        liveAfter: cutoffOf(fixture),
        sessionIds: fixture.localRows.map((row) => row.sessionId),
      });
      examined += bounded.length;
      stored += fixture.documents.length;
    }

    assert.ok(
      examined < stored,
      `the bounded selection returned ${examined} of ${stored} documents, so it is not a bound`,
    );
  });
});

describe("the one document shape the bounded query does not cover", () => {
  test("an unclassified document with no usable updatedAt is dropped, and that is the contract", () => {
    // Stated as a test rather than left as a gap in the prose.
    //
    // The bounded filter has no branch for "no `liveListUpdatedAt`" — such a branch cannot carry a
    // status prefix, and without one the whole query becomes a collection scan, which is measured
    // in `live-list-query-plan.test.ts`. So a document that the migration has **not** classified
    // *and* whose `updatedAt` is not a `Date` is invisible to the bounded query.
    //
    // That combination cannot be produced by any version of the store: every write path sets a
    // `Date` `updatedAt`, and `connect()` applies the migrations before it serves anything, so the
    // only way to reach this state is to hand-edit a document into it after the migration ran.
    // The consequence is a session that does not appear on the live list until it is written
    // again, which is why `docs/operations/upgrade.md` says a direct database edit must keep the
    // normal form.
    const document: Record<string, unknown> = {
      sessionId: "unclassified-and-unusable",
      status: "active",
      updatedAt: "not-a-date",
      deployedAt: new Date(),
    };

    const cutoff = new Date(Date.now() - 3600 * 1000);
    assert.deepEqual(
      selectBounded([document], { liveAfter: cutoff, sessionIds: [] }),
      [],
      "the bounded query now covers this shape, so this documented limitation is stale",
    );

    // And the previous build did list it: an unreadable timestamp is not expired, deliberately.
    const listed = reconcileLiveList(
      [],
      [toApiDocument({ ...document, deployedAt: new Date() })],
      { ttlSeconds: 3600, nowMs: Date.now(), alertThreshold: 1000 },
    ).sessions;
    assert.equal(listed.length, 1, "the previous build did not list it either, so nothing changed");

    // What closes the gap is writing the document — a status transition or a telemetry batch —
    // because that sets a `Date` `updatedAt` and the `updatedAt` branch sees it.
    const rewritten = { ...document, updatedAt: new Date() };
    assert.equal(
      selectBounded([rewritten], { liveAfter: cutoff, sessionIds: [] }).length,
      1,
      "a rewritten document is still invisible to the bounded query",
    );
  });
});

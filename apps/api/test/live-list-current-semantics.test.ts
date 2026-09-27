/**
 * The live-list semantics model, executed.
 *
 * ── What this file is for ─────────────────────────────────────────────
 *
 * [live-list-equivalence-model.md](../../../docs/development/live-list-equivalence-model.md)
 * describes what the live list does **today**, case by case, including the legacy and
 * malformed documents a real deployment accumulates. This file is that description as
 * assertions: every case in the model's tables appears here with the answer written out by
 * hand, not computed from `normalizeStatus` and `isExpired`.
 *
 * That distinction is the whole point. A test that derived its expectation by calling the
 * code it is testing would pass no matter what the code did, and the document it is supposed
 * to pin would drift away from the behaviour without anything failing. The expectations
 * below are therefore transcribed from the model — deliberately duplicating logic in the
 * service — so that a change to `normalizeStatus`, `readDurableString`, `readDurableSessionView`
 * or the expiry comparison shows up as a diff against the specification rather than as a
 * silent change in what the list means.
 *
 * ── Why the cases are adversarial rather than realistic ───────────────
 *
 * The rows in `ADVERSARIAL_SESSION_ROWS` are mostly shapes no Cerberus code path can produce:
 * a numeric `updatedAt`, a `Date.parse`-able `123`, an empty `deployedAt` that blocks
 * `createdAt` from ever being consulted. They are here because those shapes are exactly what
 * a hand-edited or partially-recovered database holds, and because the bounded query that
 * follows this cycle has to be provably equivalent to the current answer **for them**, not
 * merely for healthy documents. Every one is a document the current code already answers
 * definitively; none is a "should".
 *
 * ── The real-database half ────────────────────────────────────────────
 *
 * `store.listSessions` returns BSON documents; the API never sees one, because the MCP HTTP
 * adapter answers with `JSON.stringify`. The last test seeds the same rows into a real
 * MongoDB, reads them back through the store, applies `toApiDocument` and re-runs the whole
 * case table — which is what proves the case table the model documents is the table a
 * deployment actually gets. Skipped, with a stated reason, when
 * `CERBERUS_TEST_MONGODB_URI` is unset; the CI integration job provides it and asserts that
 * nothing was skipped.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { MongoClient } from "mongodb";

import { MongoStore } from "../../../packages/mcp-mongodb/src/mongo-client.js";
import { normalizeStatus, PERSISTED_SESSION_STATUSES } from "../src/services/session-status.js";
import {
  reconcileLiveList,
  type LocalLiveSession,
  type ReconcileLiveListOptions,
} from "../src/services/session-reconciliation.js";
import {
  ADVERSARIAL_NOW_MS,
  ADVERSARIAL_SESSION_ROWS,
  ADVERSARIAL_TTL_SECONDS,
  seedAdversarialSessionRows,
  toApiDocument,
} from "./support/release-fixture.js";

const REAL_MONGODB_URI = process.env["CERBERUS_TEST_MONGODB_URI"]?.trim() ?? "";

/** The options every case is judged with: a fixed instant and the fixture's one-hour TTL. */
const OPTIONS: ReconcileLiveListOptions = {
  ttlSeconds: ADVERSARIAL_TTL_SECONDS,
  nowMs: ADVERSARIAL_NOW_MS,
  // Above every `peakRiskScore` in the fixture, so `alertTriggered` never confuses a diff.
  alertThreshold: 1000,
};

const HOUR_MS = ADVERSARIAL_TTL_SECONDS * 1000;
const RECENT_ISO = new Date(ADVERSARIAL_NOW_MS - 60_000).toISOString();
const OLD_ISO = new Date(ADVERSARIAL_NOW_MS - HOUR_MS - 60_000).toISOString();

/**
 * One row of the model's case table.
 *
 * `listed` is the status the row is reported with, or `null` when it does not appear.
 * `reason` is why: `"listed"`, one of the two drop reasons, or `"skipped"` for a document the
 * reconciler never considers because it carries no usable `sessionId`.
 */
interface CaseExpectation {
  label: string;
  listed: "active" | "locked" | null;
  reason: "listed" | "terminated" | "expired" | "skipped";
}

/**
 * The whole case table, transcribed from `live-list-equivalence-model.md` §3, §5, §5.1 and §6.
 *
 * Held as one array compared in a single assertion so a failure reports every diverged row
 * at once rather than one per run.
 */
const DURABLE_ONLY_CASES: readonly CaseExpectation[] = [
  // §3 — the status normalisation table.
  { label: "status active", listed: "active", reason: "listed" },
  { label: "status locked", listed: "locked", reason: "listed" },
  { label: "status terminated", listed: null, reason: "terminated" },
  { label: "status missing", listed: "active", reason: "listed" },
  { label: "status null", listed: "active", reason: "listed" },
  { label: "status unknown (cleared)", listed: "active", reason: "listed" },
  { label: "status unknown (flagged)", listed: "active", reason: "listed" },
  // Case-sensitive: `"Terminated"` is not the terminal status, so the row is **live**.
  { label: "status case variant (Terminated)", listed: "active", reason: "listed" },
  { label: "status wrong type (number)", listed: "active", reason: "listed" },
  { label: "status empty string", listed: "active", reason: "listed" },

  // §5 — the `updatedAt` table.
  { label: "updatedAt recent BSON Date", listed: "active", reason: "listed" },
  { label: "updatedAt old BSON Date (expired)", listed: null, reason: "expired" },
  // `isExpired` compares with `>=`, so the cutoff instant itself is expired.
  { label: "updatedAt exactly at the cutoff (expired, >= boundary)", listed: null, reason: "expired" },
  { label: "updatedAt one millisecond inside the cutoff (live)", listed: "active", reason: "listed" },
  { label: "updatedAt in the future (clamped, live)", listed: "active", reason: "listed" },
  { label: "updatedAt ISO string (live)", listed: "active", reason: "listed" },
  { label: "updatedAt ISO string, old (expired)", listed: null, reason: "expired" },
  // U2/U3: the chain falls through to `deployedAt`.
  { label: "updatedAt missing, deployedAt recent", listed: "active", reason: "listed" },
  { label: "updatedAt missing, deployedAt old, createdAt recent", listed: null, reason: "expired" },
  { label: "updatedAt null, deployedAt recent", listed: "active", reason: "listed" },
  // U4–U9: an unusable `updatedAt` never expires. These are the rows a recency bound
  // on `updatedAt` alone would silently drop.
  { label: "updatedAt unparseable string", listed: "active", reason: "listed" },
  { label: "updatedAt empty string", listed: "active", reason: "listed" },
  { label: "updatedAt number (epoch ms, unparseable as a string)", listed: "active", reason: "listed" },
  // U7: `Date.parse("123")` is a finite legacy instant, so this one *is* expired.
  { label: "updatedAt number that V8 parses as a legacy date", listed: null, reason: "expired" },
  { label: "updatedAt boolean", listed: "active", reason: "listed" },
  { label: "updatedAt array that stringifies to an unparseable value", listed: "active", reason: "listed" },
  // `String([1, 2])` is `"1,2"`, which V8 parses as a year-2001 instant: expired.
  { label: "updatedAt array that stringifies to a parseable value", listed: null, reason: "expired" },
  { label: "updatedAt object", listed: "active", reason: "listed" },

  // §5.1 — the `deployedAt`/`createdAt` fallback chain.
  { label: "createdAt missing, deployedAt recent", listed: null, reason: "expired" },
  { label: "createdAt unparseable, no deployedAt, no updatedAt", listed: "active", reason: "listed" },
  { label: "createdAt old, no deployedAt, no updatedAt (expired by createdAt)", listed: null, reason: "expired" },
  { label: "createdAt recent, no deployedAt, no updatedAt (live by createdAt)", listed: "active", reason: "listed" },
  // `??` stops at the first non-nullish value, so the empty `deployedAt` blocks `createdAt`.
  { label: "deployedAt empty string blocks createdAt (permanently live)", listed: "active", reason: "listed" },
  // C4: no timestamp anywhere → the request instant → live at every instant.
  { label: "no updatedAt, no deployedAt, no createdAt (permanently live)", listed: "active", reason: "listed" },

  // §6 combinations.
  { label: "combination: status missing with updatedAt missing", listed: null, reason: "expired" },
  { label: "combination: status unknown with unparseable updatedAt", listed: "active", reason: "listed" },
  { label: "combination: status locked with expired updatedAt", listed: null, reason: "expired" },
  { label: "combination: status terminated with recent updatedAt", listed: null, reason: "terminated" },
  { label: "combination: status missing with recent updatedAt", listed: "active", reason: "listed" },

  // §8 — identity.
  { label: "no sessionId at all (skipped by the reconciler)", listed: null, reason: "skipped" },
  { label: "empty sessionId (skipped by the reconciler)", listed: null, reason: "skipped" },
];

/** A `LocalLiveSession` with the fixture's identity, so only the fields under test vary. */
function localRow(sessionId: string, lastActivityAt: string): LocalLiveSession {
  return {
    sessionId,
    employeeId: "adv-operator",
    matrixId: "adv-matrix",
    targetSystem: "Adversarial Fixture",
    status: "active",
    deployedAt: RECENT_ISO,
    lastActivityAt,
    riskIndex: 17,
    eventCount: 3,
    pasteCount: 1,
    tabSwitchCount: 2,
    focusLossCount: 1,
    copyAttemptCount: 0,
    ephemeralStateAvailable: true,
  };
}

/** One case's observed outcome, in the same shape as the expectation. */
function observe(label: string, document: Record<string, unknown>): CaseExpectation {
  const reconciliation = reconcileLiveList([], [document], OPTIONS);
  const row = reconciliation.sessions[0];

  if (!row) {
    const dropped = reconciliation.dropped[0];
    const sessionId = String(document["sessionId"] ?? "");
    return {
      label,
      listed: null,
      reason: sessionId.length === 0 ? "skipped" : (dropped?.reason ?? "skipped"),
    };
  }

  return {
    label,
    listed: row.status === "terminated" ? null : row.status,
    reason: "listed",
  };
}

/** The fixture's cases, observed through the reconciler, with no local state at all. */
function observeDurableOnlyCases(
  documents: readonly Record<string, unknown>[],
): CaseExpectation[] {
  return ADVERSARIAL_SESSION_ROWS.map((row, index) =>
    observe(row.label, documents[index] ?? toApiDocument(row.document)),
  );
}

describe("the live-list case table, before any change", () => {
  test("the fixture covers exactly the cases the model documents", () => {
    // Both directions, so a row added to the fixture without a documented expectation — or a
    // documented expectation with no row behind it — is a failure rather than a gap.
    assert.deepEqual(
      ADVERSARIAL_SESSION_ROWS.map((row) => row.label),
      DURABLE_ONLY_CASES.map((entry) => entry.label),
      "the adversarial fixture and the documented case table have diverged",
    );
  });

  test("every documented case is what the reconciler answers, durable-only", () => {
    assert.deepEqual(
      observeDurableOnlyCases(ADVERSARIAL_SESSION_ROWS.map((row) => toApiDocument(row.document))),
      DURABLE_ONLY_CASES,
    );
  });

  test("the raw driver document and the wire document are the same question except at 1 ms", () => {
    // The API never sees a BSON `Date`: the MCP HTTP adapter answers with `JSON.stringify`, so
    // a `Date` arrives as an ISO-8601 string with milliseconds. A test that hands a raw driver
    // document to `reconcileLiveList` is asking a *different* question, because `String(date)`
    // — which is what the durable-only branch does to the fallback chain — renders
    // `Sun Mar 01 2026 10:59:59 GMT+0500 (…)` with **no milliseconds**.
    //
    // This asserts both halves of that: the two paths agree everywhere in this fixture, and
    // the one row where they cannot agree is the row one millisecond inside the cutoff. That
    // row is the asymmetry, demonstrated rather than asserted; it is recorded in
    // live-list-equivalence-model.md §5.1 and is why every equivalence fixture in this cycle
    // models the wire path.
    const rawObserved = ADVERSARIAL_SESSION_ROWS.map((row) => observe(row.label, row.document));
    const wireObserved = observeDurableOnlyCases(
      ADVERSARIAL_SESSION_ROWS.map((row) => toApiDocument(row.document)),
    );

    const differences = rawObserved
      .map((entry, index) => ({ raw: entry, wire: wireObserved[index]!, index }))
      .filter(({ raw, wire }) => raw.reason !== wire.reason || raw.listed !== wire.listed);

    assert.deepEqual(
      differences.map(({ wire }) => wire.label),
      ["updatedAt one millisecond inside the cutoff (live)"],
      "the raw-document and wire-document paths diverged somewhere other than the " +
        "sub-second boundary, so the asymmetry is not the one the model documents",
    );

    // The mechanism, stated directly: truncating to the second moves the instant onto the
    // cutoff, where `isExpired`'s `>=` makes it expired.
    const justInside = new Date(ADVERSARIAL_NOW_MS - HOUR_MS + 1);
    assert.equal(
      Date.parse(String(justInside)),
      ADVERSARIAL_NOW_MS - HOUR_MS,
      "String(Date) kept milliseconds, so this environment cannot demonstrate the asymmetry",
    );
  });
});

describe("the expiry boundary and the ordering rule", () => {
  test("the cutoff instant is expired and one millisecond inside it is not", () => {
    const atCutoff = toApiDocument(
      ADVERSARIAL_SESSION_ROWS.find(
        (row) => row.label === "updatedAt exactly at the cutoff (expired, >= boundary)",
      )!.document,
    );
    const justInside = toApiDocument(
      ADVERSARIAL_SESSION_ROWS.find(
        (row) => row.label === "updatedAt one millisecond inside the cutoff (live)",
      )!.document,
    );

    // The boundary is asserted by difference rather than by each verdict alone, so a change
    // to `>=` versus `>` fails here even if both rows were otherwise misclassified.
    const cutoffAt = Date.parse(String(atCutoff["updatedAt"]));
    const insideAt = Date.parse(String(justInside["updatedAt"]));
    assert.equal(insideAt - cutoffAt, 1, "the boundary pair is not one millisecond apart");
    assert.equal(cutoffAt, ADVERSARIAL_NOW_MS - HOUR_MS, "the cutoff row is not at the cutoff");

    assert.equal(reconcileLiveList([], [atCutoff], OPTIONS).sessions.length, 0);
    assert.equal(reconcileLiveList([], [justInside], OPTIONS).sessions.length, 1);
  });

  test("expiry is disabled by a non-positive or non-finite TTL", () => {
    const expired = ADVERSARIAL_SESSION_ROWS.find(
      (row) => row.label === "updatedAt old BSON Date (expired)",
    )!.document;

    for (const ttlSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(
        reconcileLiveList([], [toApiDocument(expired)], { ...OPTIONS, ttlSeconds }).sessions.length,
        1,
        `a TTL of ${ttlSeconds} expired a session, but a non-positive TTL disables expiry`,
      );
    }
  });

  test("the response is ordered by deployedAt descending, then sessionId ascending", () => {
    const documents = ADVERSARIAL_SESSION_ROWS.map((row) => toApiDocument(row.document));
    const { sessions } = reconcileLiveList([], documents, OPTIONS);

    // A property of the output rather than a hard-coded order: rank never increases, and
    // within a run of equal rank the `sessionId` never decreases. `rank` is the documented
    // rule — an unusable instant ranks below every usable one — and is spelled out here rather
    // than borrowed so that a change to the rule shows up as a failure.
    const rank = (deployedAt: string): number => {
      const parsed = Date.parse(deployedAt);
      return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    };

    for (let index = 1; index < sessions.length; index += 1) {
      const previous = sessions[index - 1]!;
      const current = sessions[index]!;
      const previousRank = rank(previous.deployedAt);
      const currentRank = rank(current.deployedAt);

      assert.ok(
        previousRank >= currentRank,
        `${current.sessionId} (${current.deployedAt}) was ordered after ` +
          `${previous.sessionId} (${previous.deployedAt})`,
      );

      if (previousRank === currentRank) {
        assert.ok(
          previous.sessionId < current.sessionId,
          `equal deployedAt did not fall back to ascending sessionId: ` +
            `${previous.sessionId} then ${current.sessionId}`,
        );
      }
    }
  });

  test("an unusable deployedAt sorts last rather than producing NaN comparisons", () => {
    const malformed = { ...toApiDocument(ADVERSARIAL_SESSION_ROWS[0]!.document) };
    malformed["sessionId"] = "adv-malformed-order";
    malformed["deployedAt"] = "not-a-date";

    const { sessions } = reconcileLiveList(
      [],
      [malformed, toApiDocument(ADVERSARIAL_SESSION_ROWS[0]!.document)],
      OPTIONS,
    );

    assert.deepEqual(
      sessions.map((row) => row.sessionId),
      ["adv-status-active", "adv-malformed-order"],
      "the row with no usable deployedAt did not sort last",
    );
  });

  test("two rows with unusable deployedAt are still totally ordered", () => {
    // `bRank - aRank` is `-Infinity - -Infinity`, i.e. `NaN`, for two such rows. Before the
    // sessionId tie-break the sort specification collapsed that to "equal" and the order was
    // whatever the input happened to be.
    const first = { ...toApiDocument(ADVERSARIAL_SESSION_ROWS[0]!.document), sessionId: "adv-z", deployedAt: "" };
    const second = { ...toApiDocument(ADVERSARIAL_SESSION_ROWS[0]!.document), sessionId: "adv-a", deployedAt: "" };

    const { sessions } = reconcileLiveList([], [first, second], OPTIONS);
    assert.deepEqual(sessions.map((row) => row.sessionId), ["adv-a", "adv-z"]);
  });
});

describe("the revocation asymmetry between the two branches", () => {
  // Model §4.1 and §9.3. These four assertions are why the replacement predicate must not
  // normalise `updatedAt` in place: for these documents the durable-only verdict and the
  // local-row verdict are different, and a rewritten `updatedAt` collapses them into one.

  const staleDeployed = toApiDocument(
    ADVERSARIAL_SESSION_ROWS.find(
      (row) => row.label === "updatedAt missing, deployedAt old, createdAt recent",
    )!.document,
  );
  const garbageUpdated = toApiDocument(
    ADVERSARIAL_SESSION_ROWS.find(
      (row) => row.label === "updatedAt unparseable string",
    )!.document,
  );

  test("a document with no usable updatedAt is expired durable-only, and live when held locally", () => {
    const sessionId = String(staleDeployed["sessionId"]);

    assert.deepEqual(
      reconcileLiveList([], [staleDeployed], OPTIONS).sessions.map((row) => row.sessionId),
      [],
      "durable-only: the chain falls to the old deployedAt, so the row is expired",
    );

    assert.deepEqual(
      reconcileLiveList([localRow(sessionId, RECENT_ISO)], [staleDeployed], OPTIONS).sessions.map(
        (row) => row.sessionId,
      ),
      [sessionId],
      "local: readDurableString(updatedAt) is null, so this process's recent instant lists it",
    );

    assert.deepEqual(
      reconcileLiveList([localRow(sessionId, OLD_ISO)], [staleDeployed], OPTIONS).sessions.map(
        (row) => row.sessionId,
      ),
      [],
      "local: with a stale local instant the row is expired",
    );
  });

  test("a document with an unparseable updatedAt is live forever durable-only, and can be expired locally", () => {
    const sessionId = String(garbageUpdated["sessionId"]);

    assert.deepEqual(
      reconcileLiveList([], [garbageUpdated], OPTIONS).sessions.map((row) => row.sessionId),
      [sessionId],
      "durable-only: an unreadable timestamp must not silently hide a session",
    );

    assert.deepEqual(
      reconcileLiveList([localRow(sessionId, OLD_ISO)], [garbageUpdated], OPTIONS).sessions.map(
        (row) => row.sessionId,
      ),
      [],
      "local: the garbage string parses to null, so this process's stale instant expires it",
    );
  });

  test("a durably terminated session is dropped even though this process holds it as active", () => {
    const terminated = toApiDocument(
      ADVERSARIAL_SESSION_ROWS.find((row) => row.label === "status terminated")!.document,
    );
    const sessionId = String(terminated["sessionId"]);

    const reconciliation = reconcileLiveList(
      [localRow(sessionId, RECENT_ISO)],
      [terminated],
      OPTIONS,
    );

    assert.deepEqual(reconciliation.sessions, [], "a terminated session leaked into the live list");
    assert.deepEqual(reconciliation.dropped, [{ sessionId, reason: "terminated" }]);
    // The repair is what stops the next request rediscovering the divergence. It carries the
    // durable document so the caller needs no second read.
    assert.deepEqual(
      reconciliation.repairs.map((repair) => ({ sessionId: repair.sessionId, status: repair.status })),
      [{ sessionId, status: "terminated" }],
    );
  });

  test("a local session with no durable document is labelled process-local, not dropped", () => {
    const reconciliation = reconcileLiveList(
      [localRow("adv-not-in-the-store", RECENT_ISO)],
      [],
      OPTIONS,
    );

    assert.deepEqual(reconciliation.sessions.map((row) => row.sessionId), ["adv-not-in-the-store"]);
    assert.equal(reconciliation.sessions[0]?.statusSource, "process-local");
    assert.deepEqual(reconciliation.localOnly, ["adv-not-in-the-store"]);
    assert.equal(reconciliation.reconciled, true, "an empty answer is still an answer");
  });

  test("a store that did not answer leaves every row process-local and unreconciled", () => {
    const reconciliation = reconcileLiveList(
      [localRow("adv-not-in-the-store", RECENT_ISO)],
      null,
      OPTIONS,
    );

    assert.equal(reconciliation.reconciled, false);
    assert.equal(reconciliation.sessions[0]?.statusSource, "process-local");
  });
});

describe("the status vocabulary this model assumes", () => {
  test("normalizeStatus is idempotent, which is what lets a migration rewrite status", () => {
    const inputs = [
      "active",
      "locked",
      "terminated",
      "",
      "flagged",
      "investigating",
      "cleared",
      "Terminated",
      "ACTIVE",
      "0",
      "null",
      "undefined",
      "[object Object]",
    ];

    for (const input of inputs) {
      const once = normalizeStatus(input);
      assert.ok(
        (PERSISTED_SESSION_STATUSES as readonly string[]).includes(once),
        `${JSON.stringify(input)} normalised to ${once}, which is not a persisted status`,
      );
      assert.equal(
        normalizeStatus(once),
        once,
        `normalizeStatus is not idempotent for ${JSON.stringify(input)}`,
      );
    }
  });

  test("only the exact string 'terminated' is terminal", () => {
    for (const input of ["terminated", "Terminated", "TERMINATED", "terminated ", " terminated"]) {
      const normalised = normalizeStatus(input);
      assert.equal(
        normalised === "terminated",
        input === "terminated",
        `${JSON.stringify(input)} terminality disagrees with the model`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// The same table, through a real database
// ═══════════════════════════════════════════════════════════════════

if (REAL_MONGODB_URI) {
  describe("the case table through a real store", () => {
    test("the store's own read preserves every case in the table", async () => {
      const databaseName = `cerberus_live_list_semantics_${randomUUID().replace(/-/g, "")}`;
      const client = new MongoClient(REAL_MONGODB_URI);
      await client.connect();
      const db = client.db(databaseName);

      // `migrate: false` so this test observes the store's read path and nothing else. It
      // seeds documents the current store would refuse to write, which is the point.
      const store = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });
      await store.connect({ migrate: false });

      try {
        const seeded = await seedAdversarialSessionRows(db);
        assert.equal(
          seeded.inserted,
          ADVERSARIAL_SESSION_ROWS.length,
          "the fixture did not insert every adversarial row",
        );

        const stored = await store.listSessions();
        assert.equal(
          stored.length,
          ADVERSARIAL_SESSION_ROWS.length,
          "the store returned a different number of documents than were seeded",
        );

        // Through the adapter's conversion, which is the shape the API is handed.
        const asApiSeesThem = stored.map(toApiDocument);

        // The store sorts by `createdAt: -1`, but a row with no usable `sessionId` has no
        // stable position in that order, so the table is matched by identity rather than by
        // position.
        const observed = ADVERSARIAL_SESSION_ROWS.map((row) => {
          const document =
            row.sessionId === null
              ? asApiSeesThem.find((candidate) => !("sessionId" in candidate))
              : row.sessionId === ""
                ? asApiSeesThem.find((candidate) => candidate["sessionId"] === "")
                : asApiSeesThem.find((candidate) => candidate["sessionId"] === row.sessionId);

          assert.ok(
            document,
            `the store did not return ${row.label} (sessionId ${JSON.stringify(row.sessionId)})`,
          );
          return observe(row.label, document!);
        });

        assert.deepEqual(observed, DURABLE_ONLY_CASES);

        // And the boundary survives the round trip as a `Date`, which is the shape migration
        // 0005 will read. A stored `Date` compared against an ISO string is a different
        // question, so the instant itself is asserted.
        const cutoffRow = asApiSeesThem.find((document) => document["sessionId"] === "adv-updated-at-cutoff");
        assert.ok(cutoffRow, "the cutoff row is missing from the store's answer");
        assert.equal(
          Date.parse(String(cutoffRow!["updatedAt"])),
          ADVERSARIAL_NOW_MS - HOUR_MS,
          "the cutoff instant did not survive the store round trip",
        );
      } finally {
        await store.disconnect().catch(() => {});
        await db.dropDatabase().catch(() => {});
        await client.close();
      }
    });
  });
} else {
  test(
    "the case table through a real store",
    { skip: "CERBERUS_TEST_MONGODB_URI is not set, so there is no store to read from" },
    () => {},
  );
}

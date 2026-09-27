/**
 * The query-plan gate for the bounded live session list.
 *
 * ── What this asserts, and what it refuses to assert ──────────────────
 *
 * `live-list-query.test.ts` proves the *filter* returns the right documents. This file proves the
 * **server answers it from an index** rather than by reading the collection — which is the entire
 * point of the change, and the one property a unit test cannot see.
 *
 * It asserts properties, not planner JSON:
 *
 *   - the winning plan contains no `COLLSCAN`;
 *   - it uses one of the two declared live-list indexes, by **name**;
 *   - `docsExamined` and `keysExamined` are bounded by what the predicate actually selects, with
 *     a stated allowance, rather than by the size of the collection;
 *   - the same assertions hold when the collection is ten times larger.
 *
 * Pinning the exact plan tree would fail on a MongoDB minor upgrade for no reason, and a gate
 * that cries wolf is a gate that gets ignored — which is the failure mode this repository's own
 * documentation warns about. Pinning the *shape* and the *cost* catches the regression that
 * matters: a predicate that stopped being index-usable.
 *
 * ── The negative control ──────────────────────────────────────────────
 *
 * A "no COLLSCAN" assertion is only worth something if the same instrument can detect one, so the
 * first test runs `find({})` — the query this cycle replaces — through the same code and asserts
 * it **does** collect-scan and **does** examine every document. Without that, a mistake in the
 * plan walker would make every assertion here pass vacuously.
 *
 * ── Gating ────────────────────────────────────────────────────────────
 *
 * Runs when `CERBERUS_TEST_MONGODB_URI` is set, and is **skipped with a stated reason** when it is
 * not. The CI integration job provides a `mongo:7` and asserts that nothing was skipped.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { MongoClient, type Db, type Document } from "mongodb";

import { MongoStore } from "../../../../packages/mcp-mongodb/src/mongo-client.js";
import {
  buildLiveListFilter,
  LIVE_LIST_INDEXES,
  liveListCutoff,
} from "../../../../packages/mcp-mongodb/src/live-list-query.js";
import { COLLECTION_NAMES } from "../../../../packages/mcp-mongodb/src/tool-names.js";

const REAL_MONGODB_URI = process.env["CERBERUS_TEST_MONGODB_URI"]?.trim() ?? "";

/** The instant the fixture is built around, and the window it is judged in. */
const NOW_MS = Date.parse("2026-03-01T12:00:00.000Z");
const TTL_SECONDS = 3600;
const HOUR_MS = TTL_SECONDS * 1000;

/** How many documents the canonical fixture holds. Overridable so the scaling claim is checkable. */
const TOTAL_DOCUMENTS = Number.parseInt(
  process.env["CERBERUS_QUERY_PLAN_DOCUMENTS"] ?? "5000",
  10,
);

/** The share of the fixture that is live. The rest is history the query must not pay for. */
const LIVE_DOCUMENTS = Math.floor(TOTAL_DOCUMENTS / 5);

/** Documents whose `updatedAt` is not a `Date`, covered by the derived-instant branch. */
const RESIDUE_DOCUMENTS = 5;
/** Documents migration has not classified, covered by the un-migrated branch. */
const UNMIGRATED_DOCUMENTS = 5;
/** Sessions this process holds in memory, whose documents the query must return. */
const LOCAL_SESSION_IDS = Array.from({ length: 8 }, (_unused, index) => `plan-local-${index}`);

const CUTOFF = liveListCutoff(NOW_MS, TTL_SECONDS);
assert.ok(CUTOFF, "expiry is disabled, so this fixture would not be measuring a bounded query");

/** A stored session document in the post-migration normal form. */
function session(
  sessionId: string,
  status: string,
  updatedAt: Date | string | number | null,
  liveListUpdatedAt: Date | null,
): Document {
  const document: Document = {
    sessionId,
    employeeId: "plan-operator",
    auditId: "plan-audit",
    matrixId: "plan-matrix",
    targetSystem: "Query Plan Fixture",
    status,
    eventCount: 1,
    pasteCount: 0,
    tabSwitchCount: 0,
    focusLossCount: 0,
    copyAttemptCount: 0,
    peakRiskScore: 10,
    createdAt: new Date(NOW_MS - 200 * 24 * HOUR_MS),
  };
  if (updatedAt !== null) document["updatedAt"] = updatedAt;
  if (liveListUpdatedAt !== null) document["liveListUpdatedAt"] = liveListUpdatedAt;
  return document;
}

/**
 * Seeds the canonical fixture.
 *
 * Deliberately shaped like a real deployment rather than like a benchmark: most of the
 * collection is **history** — terminated sessions and sessions that are still marked `active` but
 * expired, which is the shape a deployment accumulates because expiry is derived and never
 * persisted. Those are the documents the old list read and discarded, and they are what the
 * bounded query has to stop paying for.
 */
async function seedCanonicalFixture(db: Db): Promise<void> {
  const documents: Document[] = [];

  // Live: half active, half locked, all inside the window.
  for (let index = 0; index < LIVE_DOCUMENTS; index += 1) {
    documents.push(
      session(
        `plan-live-${index}`,
        index % 2 === 0 ? "active" : "locked",
        new Date(NOW_MS - 60_000),
        new Date(NOW_MS - 60_000),
      ),
    );
  }

  const historical = TOTAL_DOCUMENTS - LIVE_DOCUMENTS - RESIDUE_DOCUMENTS - UNMIGRATED_DOCUMENTS;

  for (let index = 0; index < historical; index += 1) {
    if (index % 2 === 0) {
      // Terminated recently: inside the recency window, and not live. The old query read these
      // and the reconciler dropped them.
      documents.push(
        session(
          `plan-terminated-${index}`,
          "terminated",
          new Date(NOW_MS - 60_000),
          new Date(NOW_MS - 60_000),
        ),
      );
    } else {
      // Still marked active, long expired. The shape that makes `status` alone unselective.
      const stale = new Date(NOW_MS - 100 * 24 * HOUR_MS);
      documents.push(session(`plan-expired-${index}`, "active", stale, stale));
    }
  }

  // The residue: `updatedAt` is not a Date, so only the derived instant can judge it.
  for (let index = 0; index < RESIDUE_DOCUMENTS; index += 1) {
    documents.push(
      session(
        `plan-residue-${index}`,
        "active",
        index % 2 === 0 ? "not-a-date" : 1_700_000_000_000,
        new Date(NOW_MS - 60_000),
      ),
    );
  }

  // Un-migrated: no derived instant, so the server cannot judge them and hands them over.
  for (let index = 0; index < UNMIGRATED_DOCUMENTS; index += 1) {
    documents.push(
      session(`plan-unmigrated-${index}`, "active", new Date(NOW_MS - 60_000), null),
    );
  }

  // The local rows' documents: one terminated and one expired, because those are the ones a
  // filter that returned only the live set would lose.
  documents.push(
    session(
      LOCAL_SESSION_IDS[0]!,
      "terminated",
      new Date(NOW_MS - 60_000),
      new Date(NOW_MS - 60_000),
    ),
  );
  const staleLocal = new Date(NOW_MS - 100 * 24 * HOUR_MS);
  for (const sessionId of LOCAL_SESSION_IDS.slice(1)) {
    documents.push(session(sessionId, "active", staleLocal, staleLocal));
  }

  await db.collection(COLLECTION_NAMES.sessions).insertMany(documents, { ordered: false });
}

/** Every stage name in a plan tree, so a COLLSCAN anywhere is visible. */
function stageNames(node: unknown, found: string[] = []): string[] {
  if (!node || typeof node !== "object") return found;
  const record = node as Record<string, unknown>;
  if (typeof record["stage"] === "string") found.push(record["stage"]);
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) for (const entry of value) stageNames(entry, found);
    else if (value && typeof value === "object") stageNames(value, found);
  }
  return found;
}

/** Every index name a plan used. */
function indexNames(node: unknown, found: Set<string> = new Set()): Set<string> {
  if (!node || typeof node !== "object") return found;
  const record = node as Record<string, unknown>;
  if (typeof record["indexName"] === "string") found.add(record["indexName"]);
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) for (const entry of value) indexNames(entry, found);
    else if (value && typeof value === "object") indexNames(value, found);
  }
  return found;
}

/** Runs `explain("executionStats")` over the sessions collection with `filter`. */
async function explain(
  db: Db,
  filter: Record<string, unknown>,
): Promise<{
  stages: string[];
  indexes: Set<string>;
  docsExamined: number;
  keysExamined: number;
  returned: number;
}> {
  const result = (await db
    .collection(COLLECTION_NAMES.sessions)
    .find(filter)
    .explain("executionStats")) as Record<string, unknown>;

  const stats = (result["executionStats"] ?? {}) as Record<string, unknown>;
  return {
    stages: stageNames(result["queryPlanner"] ?? result),
    indexes: indexNames(result["queryPlanner"] ?? result),
    docsExamined: Number(stats["totalDocsExamined"] ?? 0),
    keysExamined: Number(stats["totalKeysExamined"] ?? 0),
    returned: Number(stats["nReturned"] ?? 0),
  };
}

if (REAL_MONGODB_URI) {
  describe("the bounded live-list query plan", () => {
    test("the instrument can detect a collection scan, so a passing gate means something", async () => {
      const databaseName = `cerberus_query_plan_${randomUUID().replace(/-/g, "")}`;
      const client = new MongoClient(REAL_MONGODB_URI);
      await client.connect();
      const db = client.db(databaseName);

      const store = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });
      await store.connect({ migrate: false });

      try {
        await seedCanonicalFixture(db);
        await store.ensureIndexes();

        // The query this cycle replaces.
        const unbounded = await explain(db, {});
        assert.ok(
          unbounded.stages.includes("COLLSCAN"),
          `find({}) did not collect-scan (stages: ${unbounded.stages.join(", ")}), so this gate ` +
            "cannot detect one and every assertion below would pass vacuously",
        );
        assert.equal(
          unbounded.docsExamined,
          TOTAL_DOCUMENTS + LOCAL_SESSION_IDS.length,
          "the unbounded query did not examine every document",
        );
      } finally {
        await store.disconnect().catch(() => {});
        await db.dropDatabase().catch(() => {});
        await client.close();
      }
    });

    test("the bounded predicate is answered from a live-list index, not from the collection", async () => {
      const databaseName = `cerberus_query_plan_${randomUUID().replace(/-/g, "")}`;
      const client = new MongoClient(REAL_MONGODB_URI);
      await client.connect();
      const db = client.db(databaseName);

      const store = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });
      await store.connect({ migrate: false });

      try {
        await seedCanonicalFixture(db);
        await store.ensureIndexes();

        const filter = buildLiveListFilter({
          liveAfter: CUTOFF,
          sessionIds: LOCAL_SESSION_IDS,
        });
        assert.ok(filter, "the bounded filter is null, so there is nothing to plan");

        const plan = await explain(db, filter);
        const total = TOTAL_DOCUMENTS + LOCAL_SESSION_IDS.length;

        assert.ok(
          !plan.stages.includes("COLLSCAN"),
          `the bounded live-list query collected-scanned the sessions collection ` +
            `(stages: ${plan.stages.join(", ")})`,
        );
        assert.ok(
          plan.stages.includes("IXSCAN"),
          `no index scan in the plan (stages: ${plan.stages.join(", ")})`,
        );

        // By name, because two indexes with the same key and different names are different
        // indexes, and the whole point of naming them is that a plan can be held to one.
        const declared = new Set(LIVE_LIST_INDEXES.map((index) => index.name));
        const used = [...plan.indexes].filter((name) => declared.has(name));
        assert.ok(
          used.length > 0,
          `the plan used none of the declared live-list indexes ` +
            `(declared: ${[...declared].join(", ")}; used: ${[...plan.indexes].join(", ")})`,
        );

        // ── The cost bound ──
        //
        // What the predicate selects: the live documents, the residue, the legacy-status
        // documents and the local rows' documents. The allowance is a multiple with a stated
        // slack rather than an exact number, so a planner improvement does not fail the gate —
        // while a return to reading history does. The measured figure for this fixture is within
        // a few percent of the result count, because both branches are index-bounded.
        const expected =
          LIVE_DOCUMENTS + RESIDUE_DOCUMENTS + UNMIGRATED_DOCUMENTS + LOCAL_SESSION_IDS.length + 10;
        const allowance = expected * 3 + 100;

        assert.ok(
          plan.docsExamined <= allowance,
          `the bounded query examined ${plan.docsExamined} documents for ${expected} expected ` +
            `results (allowance ${allowance}); it is reading history again`,
        );
        assert.ok(
          plan.keysExamined <= allowance * 2,
          `the bounded query examined ${plan.keysExamined} index keys for ${expected} expected ` +
            `results (allowance ${allowance * 2})`,
        );

        // And the contrast that makes the number meaningful: the collection is far larger than
        // what the query looked at.
        assert.ok(
          plan.docsExamined < total / 2,
          `the bounded query examined ${plan.docsExamined} of ${total} documents, which is not a ` +
            "bound worth having",
        );

        // ── Sort ──
        //
        // The bounded query does not sort. It does not have to: the reconciler's comparator is
        // total (`deployedAt` descending, then `sessionId` ascending), so the page's order is a
        // function of the set of documents rather than of the order they arrived in. A blocking
        // `SORT` stage over the matched documents would be wasted work, and one over the whole
        // collection would be the unbounded read coming back in another form.
        assert.ok(
          !plan.stages.includes("SORT"),
          `the bounded query sorted (stages: ${plan.stages.join(", ")}), which the reconciler's ` +
            "total comparator makes unnecessary",
        );
      } finally {
        await store.disconnect().catch(() => {});
        await db.dropDatabase().catch(() => {});
        await client.close();
      }
    });

    test("the bound holds as the collection grows", async () => {
      // The same assertion at a different size, because "bounded" is a claim about scaling and a
      // single size cannot distinguish a bound from a coincidence. The live set is held constant
      // while history grows, which is what a real deployment looks like over time.
      const databaseName = `cerberus_query_plan_${randomUUID().replace(/-/g, "")}`;
      const client = new MongoClient(REAL_MONGODB_URI);
      await client.connect();
      const db = client.db(databaseName);

      const store = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });
      await store.connect({ migrate: false });

      try {
        await seedCanonicalFixture(db);
        await store.ensureIndexes();

        const filter = buildLiveListFilter({
          liveAfter: CUTOFF,
          sessionIds: LOCAL_SESSION_IDS,
        });
        const before = await explain(db, filter!);

        // Ten times the history, and nothing else changed.
        const extra: Document[] = [];
        for (let index = 0; index < TOTAL_DOCUMENTS * 9; index += 1) {
          const stale = new Date(NOW_MS - (100 + (index % 900)) * 24 * HOUR_MS);
          extra.push(session(`plan-extra-${index}`, index % 2 === 0 ? "terminated" : "active", stale, stale));
        }
        await db.collection(COLLECTION_NAMES.sessions).insertMany(extra, { ordered: false });

        const after = await explain(db, filter!);

        assert.ok(
          !after.stages.includes("COLLSCAN"),
          `the bounded query collected-scanned once history grew (stages: ${after.stages.join(", ")})`,
        );
        assert.equal(
          after.returned,
          before.returned,
          "the same filter returned a different number of documents at a larger size",
        );
        assert.ok(
          after.docsExamined <= before.docsExamined * 2 + 50,
          `examining ${after.docsExamined} documents against ${before.docsExamined} before the ` +
            "collection grew tenfold: the query cost is tracking history rather than the live set",
        );
      } finally {
        await store.disconnect().catch(() => {});
        await db.dropDatabase().catch(() => {});
        await client.close();
      }
    });

    test("with expiry disabled the query says so rather than pretending to be bounded", async () => {
      // `SESSION_TTL_SECONDS <= 0` disables expiry, and the live set is then every non-terminated
      // session ever created. That is genuinely unbounded, so the filter narrows on status only —
      // and the read is allowed to examine the whole live-status population, because that *is*
      // the answer.
      assert.equal(liveListCutoff(NOW_MS, 0), null);
      assert.equal(liveListCutoff(NOW_MS, -1), null);
      assert.equal(liveListCutoff(NOW_MS, Number.NaN), null);

      const filter = buildLiveListFilter({ liveAfter: null, sessionIds: [] });
      assert.deepEqual(filter, { status: { $ne: "terminated" } });
    });

    test("the filter states the status rule the reconciler uses, not an enumeration of it", async () => {
      // `normalizeStatus` maps a missing, null, unknown or wrong-typed status onto `active`, and
      // `isMonitored` is `status !== "terminated"`. So "not the exact string `terminated`" is the
      // whole rule, and enumerating the live values instead would drop every status no version of
      // the vocabulary happened to hold — the historical `undefined`-to-`null` clobber produced
      // exactly such documents. This asserts the filter carries that rule and no enumeration.
      const filter = buildLiveListFilter({
        liveAfter: CUTOFF,
        sessionIds: [],
      }) as { $or: Array<Record<string, unknown>> };

      for (const branch of filter.$or) {
        assert.deepEqual(
          branch["status"],
          { $ne: "terminated" },
          `a branch enumerated the live statuses instead of excluding the terminal one: ` +
            JSON.stringify(branch["status"]),
        );
      }
    });
  });
} else {
  test(
    "the bounded live-list query plan",
    { skip: "CERBERUS_TEST_MONGODB_URI is not set, so there is no server to plan against" },
    () => {},
  );
}

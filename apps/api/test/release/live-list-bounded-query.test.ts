/**
 * The bounded live-list query, and the equivalence it has to preserve.
 *
 * ── The claim under test ──────────────────────────────────────────────
 *
 * > For every fixture, the page produced from the **bounded** query equals the page produced from
 * > the **unbounded** one, over the same reconciler.
 *
 * That is the whole of the change. `reconcileLiveList` is not modified by this cycle, so the
 * question is only whether the query returns everything the reconciler needs — and the answer is
 * compared field by field rather than by counting rows, because a query that returned the right
 * *number* of sessions could still return the wrong ones.
 *
 * The comparison is deliberately structured as **one function over two document sets**, so it
 * cannot drift into comparing an implementation with itself:
 *
 * ```
 * expected = reconcileLiveList(local, await store.listSessions())                 // every document
 * actual   = reconcileLiveList(local, await store.listSessions({ liveList }))     // the bound
 * ```
 *
 * ── What is compared, and what is not ─────────────────────────────────
 *
 * `sessions`, `repairs`, `localOnly`, `addedFromDurable` and `reconciled` are compared exactly.
 * `sessions` is order-sensitive and *must* be, because the response is: the reconciler's
 * comparator is total (`deployedAt` descending, then `sessionId` ascending), so the page is a
 * function of the document *set* and not of the order they arrived in — which is also why the
 * bounded query does not sort.
 *
 * `dropped` is the one field that is allowed to differ, and the difference is asserted rather
 * than ignored: it is a debug counter of the documents **this request looked at** and found not
 * live, so the bounded query reports fewer. The response body does not contain it.
 *
 * ── Gating ────────────────────────────────────────────────────────────
 *
 * Runs when `CERBERUS_TEST_MONGODB_URI` is set, and is **skipped with a stated reason** when it is
 * not. The CI integration job provides a `mongo:7` and asserts that nothing was skipped.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { MongoClient, type Db } from "mongodb";

import { MongoStore } from "../../../../packages/mcp-mongodb/src/mongo-client.js";
import {
  createToolRegistry,
  ToolArgumentError,
} from "../../../../packages/mcp-mongodb/src/tools.js";
import { MCP_TOOL_NAMES, COLLECTION_NAMES } from "../../../../packages/mcp-mongodb/src/tool-names.js";
import {
  reconcileLiveList,
  type LocalLiveSession,
  type LiveListReconciliation,
} from "../../src/services/session-reconciliation.js";
import {
  ADVERSARIAL_NOW_MS,
  ADVERSARIAL_SESSION_ROWS,
  ADVERSARIAL_TTL_SECONDS,
  seedAdversarialSessionRows,
  seedV061AdversarialFixture,
  toApiDocument,
} from "../support/release-fixture.js";

const REAL_MONGODB_URI = process.env["CERBERUS_TEST_MONGODB_URI"]?.trim() ?? "";

const HOUR_MS = ADVERSARIAL_TTL_SECONDS * 1000;
const CUTOFF = new Date(ADVERSARIAL_NOW_MS - HOUR_MS);
const RECENT_ISO = new Date(ADVERSARIAL_NOW_MS - 60_000).toISOString();
const OLD_ISO = new Date(ADVERSARIAL_NOW_MS - HOUR_MS - 60_000).toISOString();

const OPTIONS = {
  ttlSeconds: ADVERSARIAL_TTL_SECONDS,
  nowMs: ADVERSARIAL_NOW_MS,
  alertThreshold: 1000,
};

/**
 * Sessions this process holds in memory while the page is built.
 *
 * Chosen so that each branch of the completeness requirement is exercised, and every one of them
 * corresponds to a real document in the fixture:
 *
 *   `adv-status-terminated`  held as `active` locally, terminated durably — the session a query
 *                            that returned only the live set would republish as live.
 *   `adv-updated-missing-stale-deployed`
 *                            expired under the local-row rule and live under the durable-only one,
 *                            which is the asymmetry the model's §4.1 records.
 *   `adv-status-active`      an ordinary live session this process holds.
 *   `adv-not-in-the-store`   a session with no durable document at all.
 */
const LOCAL_ROWS: ReadonlyArray<{ sessionId: string; lastActivityAt: string }> = [
  { sessionId: "adv-status-terminated", lastActivityAt: RECENT_ISO },
  { sessionId: "adv-updated-missing-stale-deployed", lastActivityAt: OLD_ISO },
  { sessionId: "adv-status-active", lastActivityAt: RECENT_ISO },
  { sessionId: "adv-not-in-the-store", lastActivityAt: RECENT_ISO },
];

/** This process's view of those rows. */
function localSessions(): LocalLiveSession[] {
  return LOCAL_ROWS.map((row) => ({
    sessionId: row.sessionId,
    employeeId: "adv-operator",
    matrixId: "adv-matrix",
    targetSystem: "Adversarial Fixture",
    status: "active",
    deployedAt: row.lastActivityAt,
    lastActivityAt: row.lastActivityAt,
    riskIndex: 17,
    eventCount: 3,
    pasteCount: 1,
    tabSwitchCount: 2,
    focusLossCount: 1,
    copyAttemptCount: 0,
    ephemeralStateAvailable: true,
  }));
}

/** A disposable database seeded with the v0.6.1 adversarial fixture. */
async function withFixture(
  run: (context: { store: MongoStore; databaseName: string; db: Db }) => Promise<void>,
  options: { migrate?: boolean; indexes?: boolean } = {},
): Promise<void> {
  const databaseName = `cerberus_bounded_list_${randomUUID().replace(/-/g, "")}`;
  const client = new MongoClient(REAL_MONGODB_URI);
  await client.connect();
  const db = client.db(databaseName);

  const store = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });

  // Connect **without** migrating, so the fixture can be written before the ledger exists —
  // which is the order an upgrade actually happens in, and the only order in which the fixture's
  // own ledger rows can be the starting point.
  await store.connect({ migrate: false });

  try {
    if (options.migrate === false) {
      await seedAdversarialSessionRows(db);
    } else {
      await seedV061AdversarialFixture(db);
      await store.runMigrations();
    }
    // Indexes are created unless a test is specifically about their absence.
    if (options.indexes !== false) await store.ensureIndexes();
    await run({ store, databaseName, db });
  } finally {
    await store.disconnect().catch(() => {});
    await db.dropDatabase().catch(() => {});
    await client.close();
  }
}

/** The page's session ids, in order. */
function idsOf(reconciliation: LiveListReconciliation): string[] {
  return reconciliation.sessions.map((row) => row.sessionId);
}

if (REAL_MONGODB_URI) {
  describe("the bounded live-list query is equivalent to the unbounded one", () => {
    test("the bounded page equals the unbounded page, field for field", async () => {
      await withFixture(async ({ store }) => {
        assert.equal(
          store.liveListQueryIsBounded,
          true,
          "the store did not take the bounded path, so this test would compare two unbounded reads",
        );

        const local = localSessions();

        const unboundedDocuments = (await store.listSessions()).map(toApiDocument);
        const boundedDocuments = (
          await store.listSessions({
            liveList: { liveAfter: CUTOFF, sessionIds: local.map((row) => row.sessionId) },
          })
        ).map(toApiDocument);

        const expected = reconcileLiveList(local, unboundedDocuments, OPTIONS);
        const actual = reconcileLiveList(local, boundedDocuments, OPTIONS);

        // ── The response, exactly ──
        assert.deepEqual(
          actual.sessions,
          expected.sessions,
          "the bounded query produced a different page",
        );

        // ── And everything the route uses to maintain this process's cache ──
        assert.deepEqual(actual.repairs, expected.repairs, "the repairs differ");
        assert.deepEqual(actual.localOnly, expected.localOnly, "localOnly differs");
        assert.equal(actual.reconciled, expected.reconciled, "reconciled differs");
        assert.deepEqual(
          [...actual.addedFromDurable].sort(),
          [...expected.addedFromDurable].sort(),
          "the set of sessions visible only durably differs",
        );

        // ── `dropped` is a diagnostic, and its documented difference is asserted ──
        //
        // It counts the documents *this request fetched* and found not live. The bounded query
        // fetches fewer, so it reports fewer — and every session-level decision is unchanged.
        // The response body does not carry it.
        assert.ok(
          actual.dropped.length <= expected.dropped.length,
          "the bounded query dropped more documents than it was given",
        );
        const expectedDropped = new Set(expected.dropped.map((entry) => entry.sessionId));
        for (const entry of actual.dropped) {
          assert.ok(
            expectedDropped.has(entry.sessionId),
            `the bounded query dropped ${entry.sessionId}, which the unbounded path kept`,
          );
        }
      });
    });

    test("the bound is a real bound: it fetches a fraction of the collection", async () => {
      await withFixture(async ({ store }) => {
        const local = localSessions();
        const unbounded = await store.listSessions();
        const bounded = await store.listSessions({
          liveList: { liveAfter: CUTOFF, sessionIds: local.map((row) => row.sessionId) },
        });

        assert.equal(
          unbounded.length,
          ADVERSARIAL_SESSION_ROWS.length,
          "the unbounded read did not return every document",
        );
        assert.ok(
          bounded.length < unbounded.length,
          `the bounded query returned ${bounded.length} of ${unbounded.length} documents, so it ` +
            "is not bounded at all",
        );

        // Every document the reconciler needed is present: the local rows' documents — including
        // the terminated one — and every live row.
        const boundedIds = new Set(
          bounded.map((document) => String(document["sessionId"] ?? "")),
        );
        for (const row of LOCAL_ROWS) {
          if (row.sessionId === "adv-not-in-the-store") continue;
          assert.ok(
            boundedIds.has(row.sessionId),
            `${row.sessionId} is held locally but its document was not returned, so the ` +
              "reconciler would answer from this process's cache",
          );
        }
      });
    });

    test("the query's cutoff is the reconciler's boundary, not one millisecond away from it", async () => {
      await withFixture(async ({ store }) => {
        const bounded = await store.listSessions({
          liveList: { liveAfter: CUTOFF, sessionIds: [] },
        });
        const ids = new Set(bounded.map((document) => String(document["sessionId"] ?? "")));

        // `isExpired` compares with `>=`, so a document exactly at the cutoff is **expired** and
        // the query's `> cutoff` must agree. The fixture holds both sides of the boundary.
        assert.equal(
          ids.has("adv-updated-at-cutoff"),
          false,
          "the query returned the document sitting exactly on the cutoff, which the reconciler expires",
        );
        assert.equal(
          ids.has("adv-updated-just-inside"),
          true,
          "the query omitted the document one millisecond inside the cutoff, which the reconciler lists",
        );
      });
    });

    test("a session held locally as active but terminated durably is still dropped", async () => {
      await withFixture(async ({ store }) => {
        // The failure this whole branch of the predicate exists to prevent: without the local
        // rows' documents the reconciler sees no durable record, answers from the cache, and
        // republishes a terminated session as live.
        const local = localSessions();
        const bounded = (
          await store.listSessions({
            liveList: { liveAfter: CUTOFF, sessionIds: local.map((row) => row.sessionId) },
          })
        ).map(toApiDocument);

        const page = reconcileLiveList(local, bounded, OPTIONS);
        assert.equal(
          page.sessions.some((row) => row.sessionId === "adv-status-terminated"),
          false,
          "a durably terminated session leaked onto the live list",
        );
        assert.deepEqual(
          page.repairs.map((repair) => repair.sessionId),
          ["adv-status-terminated"],
          "the cache was not told to correct the terminated session",
        );
      });
    });
    test("the bound is correct without its indexes, and only slower", async () => {
      // The predicate's *answer* cannot depend on an index: an index changes how the server finds
      // documents, not which ones match. This is worth asserting because the two are easy to
      // conflate — a query that returned the right rows only because of an index would be a
      // correctness bug waiting for a restore that lost the index, and the critical-index list
      // exists precisely because a restore can lose one.
      //
      // So: same fixture, **no live-list indexes**, same comparison. The plan is asserted to be a
      // collection scan, which is what makes this test about the unindexed path rather than luck.
      await withFixture(
        async ({ store, db }) => {
          const local = localSessions();

          const unbounded = (await store.listSessions()).map(toApiDocument);
          const bounded = (
            await store.listSessions({
              liveList: { liveAfter: CUTOFF, sessionIds: local.map((row) => row.sessionId) },
            })
          ).map(toApiDocument);

          assert.deepEqual(
            reconcileLiveList(local, bounded, OPTIONS).sessions,
            reconcileLiveList(local, unbounded, OPTIONS).sessions,
            "the bounded query answered differently without its indexes",
          );

          const plan = (await db
            .collection(COLLECTION_NAMES.sessions)
            .find({
              $or: [
                { sessionId: { $in: local.map((row) => row.sessionId) } },
                { status: { $ne: "terminated" }, liveListUpdatedAt: { $gt: CUTOFF } },
                { status: { $ne: "terminated" }, updatedAt: { $gt: CUTOFF } },
              ],
            })
            .explain("executionStats")) as Record<string, unknown>;

          const stages: string[] = [];
          const walk = (node: unknown): void => {
            if (!node || typeof node !== "object") return;
            const record = node as Record<string, unknown>;
            if (typeof record["stage"] === "string") stages.push(record["stage"]);
            for (const value of Object.values(record)) {
              if (Array.isArray(value)) value.forEach(walk);
              else if (value && typeof value === "object") walk(value);
            }
          };
          walk(plan["queryPlanner"] ?? plan);

          assert.ok(
            stages.includes("COLLSCAN"),
            `the unindexed fixture was answered from an index after all (stages: ${stages.join(", ")}), ` +
              "so this test did not exercise the path it claims to",
          );
        },
        { indexes: false },
      );
    });
  });

  describe("the store's fallback when the database is not in the normal form", () => {
    test("a process that did not migrate reads every document and says so", async () => {
      await withFixture(
        async ({ store }) => {
          assert.equal(
            store.liveListQueryIsBounded,
            false,
            "a store connected with migrate: false reported the bounded query as available",
          );

          const bounded = await store.listSessions({
            liveList: { liveAfter: CUTOFF, sessionIds: [] },
          });
          assert.equal(
            bounded.length,
            ADVERSARIAL_SESSION_ROWS.length,
            "the store applied the bound to a database the migration has not classified, so " +
              "documents whose status the vocabulary does not include could be dropped",
          );
        },
        { migrate: false },
      );
    });

    test("no argument is the published behaviour, whatever the migration state", async () => {
      await withFixture(async ({ store }) => {
        const listed = await store.listSessions();
        assert.equal(listed.length, ADVERSARIAL_SESSION_ROWS.length);

        // Newest `createdAt` first, with a missing `createdAt` sorting last — the documented
        // order of the unbounded listing, unchanged.
        const createdAts = listed.map((document) => document["createdAt"]);
        const firstMissing = createdAts.findIndex((value) => value === undefined);
        if (firstMissing >= 0) {
          assert.ok(
            createdAts.slice(firstMissing).every((value) => value === undefined),
            "a document with a createdAt was ordered after one without",
          );
        }
      });
    });
  });

  describe("the list_sessions argument contract", () => {
    test("no argument still means the unbounded listing", async () => {
      const calls: Array<{ liveList?: unknown }> = [];
      const store = {
        listSessions: async (options: { liveList?: unknown } = {}) => {
          calls.push(options);
          return [];
        },
      } as unknown as MongoStore;

      const registry = createToolRegistry(store);
      const result = (await registry[MCP_TOOL_NAMES.LIST_SESSIONS]!({})) as {
        success: boolean;
        data: unknown[];
      };

      assert.deepEqual(result, { success: true, data: [] });
      assert.deepEqual(calls, [{}], "an argument-less call passed a liveList request");
    });

    test("a valid liveList request reaches the store as a Date and an id list", async () => {
      const calls: Array<{ liveList?: { liveAfter: Date | null; sessionIds: string[] } }> = [];
      const store = {
        listSessions: async (options: { liveList?: { liveAfter: Date | null; sessionIds: string[] } } = {}) => {
          calls.push(options);
          return [];
        },
      } as unknown as MongoStore;

      const registry = createToolRegistry(store);
      await registry[MCP_TOOL_NAMES.LIST_SESSIONS]!({
        liveList: { liveAfter: CUTOFF.toISOString(), sessionIds: ["a", "b"] },
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.liveList?.liveAfter?.getTime(), CUTOFF.getTime());
      assert.deepEqual(calls[0]!.liveList?.sessionIds, ["a", "b"]);
    });

    test("a null cutoff is passed through as 'expiry is disabled'", async () => {
      const calls: Array<{ liveList?: { liveAfter: Date | null } }> = [];
      const store = {
        listSessions: async (options: { liveList?: { liveAfter: Date | null } } = {}) => {
          calls.push(options);
          return [];
        },
      } as unknown as MongoStore;

      const registry = createToolRegistry(store);
      await registry[MCP_TOOL_NAMES.LIST_SESSIONS]!({ liveList: { liveAfter: null } });

      assert.equal(calls[0]!.liveList?.liveAfter, null);
    });

    test("a malformed request is refused rather than answered with a different question", async () => {
      const store = {
        listSessions: async () => {
          throw new Error("the store must not be reached for a malformed request");
        },
      } as unknown as MongoStore;

      const registry = createToolRegistry(store);

      const refused: unknown[] = [
        { liveList: "not-an-object" },
        { liveList: [] },
        { liveList: { sessionIds: ["a"] } },
        { liveList: { liveAfter: 1234 } },
        { liveList: { liveAfter: "not-an-instant" } },
        { liveList: { liveAfter: null, sessionIds: "a" } },
        { liveList: { liveAfter: null, sessionIds: [1] } },
      ];

      for (const body of refused) {
        await assert.rejects(
          () => registry[MCP_TOOL_NAMES.LIST_SESSIONS]!(body as Record<string, unknown>),
          (error: unknown) => error instanceof ToolArgumentError,
          `${JSON.stringify(body)} was accepted`,
        );
      }
    });
  });
} else {
  test(
    "the bounded live-list query is equivalent to the unbounded one",
    { skip: "CERBERUS_TEST_MONGODB_URI is not set, so there is no database to query" },
    () => {},
  );
}

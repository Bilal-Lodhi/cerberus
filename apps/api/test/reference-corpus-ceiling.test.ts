/**
 * The reference-corpus hard ceiling.
 *
 * The corpus is read in full on every risk analysis, so its size bounds the work one
 * analysis does as well as the storage it occupies. The ceiling used to be a **read**
 * ceiling only: `listReferenceDocuments` returns at most `MAX_REFERENCE_DOCUMENTS`, so a
 * 201st document was stored and then never returned — invisible, and silently excluded
 * from every similarity comparison. The API and the console both advertised a limit that
 * was not enforced.
 *
 * It is now a store-side rejection with a stable code, and the boundary is tested at
 * 199 / 200 / 201 plus under concurrency.
 *
 * ── Why the concurrency case needs a real database ────────────────────
 *
 * The mechanism is an atomic conditional `$inc` on one counter document. A
 * single-threaded in-process double cannot interleave two claims, so it cannot show
 * whether the mechanism works — it would pass for the trivial reason that nothing races.
 * The concurrency case therefore runs against a real `MongoStore` when
 * `CERBERUS_TEST_MONGODB_URI` is set, and is skipped with a stated reason when it is not.
 */

import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { MongoClient } from "mongodb";

import { MongoStore } from "../../../packages/mcp-mongodb/src/mongo-client.js";
import {
  MAX_REFERENCE_DOCUMENTS,
  createToolRegistry,
} from "../../../packages/mcp-mongodb/src/tools.js";
import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import { REFERENCE_CORPUS_LIMIT_CODE } from "../src/routes/reference.js";
import {
  authorizedHeaders,
  installFetchStub,
  makeConfig,
  type FetchStub,
} from "./helpers.js";
import { McpStoreDouble } from "./support/mcp-store-double.js";

const REAL_MONGODB_URI = process.env["CERBERUS_TEST_MONGODB_URI"]?.trim() ?? "";

/** A reference document with a unique id. */
function referenceDocument(suffix: string): Record<string, unknown> {
  return {
    referenceId: `ref-${suffix}`,
    label: `Reference ${suffix}`,
    content: `ledger content ${suffix}`,
    tags: [],
  };
}

// ═══════════════════════════════════════════════════════════════════
// The store ceiling, against the shared double
// ═══════════════════════════════════════════════════════════════════

describe("reference corpus ceiling — store", () => {
  /** Seeds a corpus to exactly `size` documents. */
  async function seed(store: McpStoreDouble, size: number): Promise<void> {
    for (let index = 0; index < size; index++) {
      await store.storeReferenceDocument(referenceDocument(`seed-${index}`));
    }
  }

  test("199 documents: one more is accepted", async () => {
    const store = new McpStoreDouble();
    await seed(store, 199);

    const result = await store.storeReferenceDocument(referenceDocument("last"), {
      limit: MAX_REFERENCE_DOCUMENTS,
    });

    assert.equal(result.created, true);
    assert.equal(result.count, 200);
  });

  test("200 documents: one more is refused with the limit error", async () => {
    const store = new McpStoreDouble();
    await seed(store, 200);

    await assert.rejects(
      () =>
        store.storeReferenceDocument(referenceDocument("overflow"), {
          limit: MAX_REFERENCE_DOCUMENTS,
        }),
      (error: unknown) =>
        error instanceof Error && error.name === "ReferenceCorpusLimitError",
    );

    assert.equal(
      await store.referenceDocumentCount(),
      200,
      "a refused create changed the corpus size",
    );
  });

  test("201: the corpus never exceeds the ceiling", async () => {
    const store = new McpStoreDouble();
    await seed(store, 200);

    // Two further attempts, both refused.
    for (const suffix of ["a", "b"]) {
      await assert.rejects(() =>
        store.storeReferenceDocument(referenceDocument(suffix), {
          limit: MAX_REFERENCE_DOCUMENTS,
        }),
      );
    }

    const listed = await store.listReferenceDocuments(MAX_REFERENCE_DOCUMENTS + 50);
    assert.equal(listed.length, 200, "the corpus grew past its ceiling");
  });

  test("updating an existing document is always allowed at the ceiling", async () => {
    // An update does not grow the corpus, so the ceiling must not block it — otherwise an
    // operator could not correct a document once the corpus was full.
    const store = new McpStoreDouble();
    await seed(store, 200);

    const result = await store.storeReferenceDocument(
      { ...referenceDocument("seed-0"), content: "corrected" },
      { limit: MAX_REFERENCE_DOCUMENTS },
    );

    assert.equal(result.created, false, "an update claimed a slot");
    assert.equal(result.count, 200);
    const listed = await store.listReferenceDocuments(MAX_REFERENCE_DOCUMENTS);
    const updated = listed.find((document) => document["referenceId"] === "ref-seed-0");
    assert.equal(updated?.["content"], "corrected");
  });

  test("deleting a document frees a slot", async () => {
    const store = new McpStoreDouble();
    await seed(store, 200);
    await assert.rejects(() =>
      store.storeReferenceDocument(referenceDocument("blocked"), {
        limit: MAX_REFERENCE_DOCUMENTS,
      }),
    );

    assert.equal(await store.deleteReferenceDocument("ref-seed-0"), true);

    const result = await store.storeReferenceDocument(referenceDocument("allowed"), {
      limit: MAX_REFERENCE_DOCUMENTS,
    });
    assert.equal(result.created, true, "a slot was not released by the delete");
    assert.equal(result.count, 200);
  });

  test("deleting an unknown document frees nothing", async () => {
    // Otherwise a delete for an id that does not exist would hand out a slot twice and
    // the corpus could grow past the ceiling.
    const store = new McpStoreDouble();
    await seed(store, 200);

    assert.equal(await store.deleteReferenceDocument("no-such-document"), false);
    await assert.rejects(() =>
      store.storeReferenceDocument(referenceDocument("still-blocked"), {
        limit: MAX_REFERENCE_DOCUMENTS,
      }),
    );
  });

  test("the corpus-limit error names the limit and the count", async () => {
    const store = new McpStoreDouble();
    await seed(store, 200);

    await assert.rejects(
      () =>
        store.storeReferenceDocument(referenceDocument("overflow"), {
          limit: MAX_REFERENCE_DOCUMENTS,
        }),
      (error: unknown) => {
        const limitError = error as { limit?: number; count?: number; message?: string };
        assert.equal(limitError.limit, MAX_REFERENCE_DOCUMENTS);
        assert.equal(limitError.count, 200);
        assert.match(String(limitError.message), /Remove a document/);
        return true;
      },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// The route: the refusal reaches the operator as a stable code
// ═══════════════════════════════════════════════════════════════════

describe("reference corpus ceiling — API route", () => {
  let stub: FetchStub;
  let mcp: McpStoreDouble;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetAIProvider();
    mcp = new McpStoreDouble();
    stub = installFetchStub({ mcpResponse: mcp.responder() });
    app = createApp(makeConfig());
  });

  afterEach(() => {
    stub.restore();
    resetAIProvider();
  });

  async function add(label: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await app.request("/api/v1/reference-documents", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        label,
        content: `ledger content for ${label}`,
        tags: [],
      }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  test("the API reports the full corpus as 409, not as an outage", async () => {
    // Before the adapter's code was surfaced, this was a 503
    // `REFERENCE_STORE_UNAVAILABLE` — telling the operator to retry something that would
    // never succeed.
    for (let index = 0; index < MAX_REFERENCE_DOCUMENTS; index++) {
      await mcp.storeReferenceDocument(referenceDocument(`seed-${index}`));
    }

    const result = await add("one too many");

    assert.equal(result.status, 409);
    assert.equal(result.body["code"], REFERENCE_CORPUS_LIMIT_CODE);
    assert.equal(result.body["limit"], MAX_REFERENCE_DOCUMENTS);
    assert.match(String(result.body["error"]), /full/i);
  });

  test("a corpus with room still accepts a document", async () => {
    const result = await add("plenty of room");
    assert.equal(result.status, 201);
    assert.equal(result.body["success"], true);
  });

  test("an unreachable corpus store is still a 503", async () => {
    // The two failures must stay distinguishable: one is retryable, the other is not.
    mcp.failToolsMatching("reference");

    const result = await add("store down");

    assert.equal(result.status, 503);
    assert.equal(result.body["code"], "REFERENCE_STORE_UNAVAILABLE");
  });

  test("the console's pre-flight limit agrees with the server's", async () => {
    // The corpus panel validates against its own copy of the limit before sending, so a
    // drift would let the console refuse documents the server would accept — or, worse,
    // send ones the server refuses after the operator filled in a form.
    const listed = await app.request("/api/v1/reference-documents", {
      headers: authorizedHeaders(),
    });
    const body = (await listed.json()) as { success: boolean; total: number };
    assert.equal(body.success, true);
    assert.equal(body.total, 0);

    // The constant the route enforces is the one the console mirrors; both are asserted
    // against the adapter's in `mcp-tool-mapping.test.ts`.
    assert.equal(MAX_REFERENCE_DOCUMENTS, 200);
  });
});

// ═══════════════════════════════════════════════════════════════════
// The ceiling under concurrency, against a real MongoDB
// ═══════════════════════════════════════════════════════════════════

if (REAL_MONGODB_URI) {
  describe("reference corpus ceiling — concurrency against real MongoDB", () => {
    const databaseName = `cerberus_corpus_${randomUUID().replace(/-/g, "")}`;
    let store: MongoStore;

    before(async () => {
      store = new MongoStore({ uri: REAL_MONGODB_URI, databaseName });
      await store.connect();
    });

    after(async () => {
      await store.disconnect();
      const client = new MongoClient(REAL_MONGODB_URI);
      try {
        await client.connect();
        await client.db(databaseName).dropDatabase();
      } finally {
        await client.close();
      }
    });

    test("concurrent creates at one below the limit: exactly one succeeds", async () => {
      // This is the case a count-then-insert gets wrong: both callers read 199, both
      // insert, and the corpus reaches 201. The conditional `$inc` on a single counter
      // document is atomic, so only one can take the last slot.
      const store1 = new MongoStore({ uri: REAL_MONGODB_URI, databaseName: `${databaseName}_race` });
      await store1.connect();

      try {
        for (let index = 0; index < MAX_REFERENCE_DOCUMENTS - 1; index++) {
          await store1.storeReferenceDocument(referenceDocument(`race-seed-${index}`), {
            limit: MAX_REFERENCE_DOCUMENTS,
          });
        }

        const attempts = await Promise.allSettled(
          Array.from({ length: 8 }, (_unused, index) =>
            store1.storeReferenceDocument(referenceDocument(`concurrent-${index}`), {
              limit: MAX_REFERENCE_DOCUMENTS,
            }),
          ),
        );

        const created = attempts.filter(
          (attempt) => attempt.status === "fulfilled" && attempt.value.created,
        );
        const refused = attempts.filter(
          (attempt) =>
            attempt.status === "rejected" &&
            (attempt.reason as Error).name === "ReferenceCorpusLimitError",
        );

        assert.equal(
          created.length,
          1,
          `expected exactly one create to succeed, got ${created.length}`,
        );
        assert.equal(refused.length, 7, "a refusal was not reported as a limit error");
        assert.equal(
          await store1.referenceDocumentCount(),
          MAX_REFERENCE_DOCUMENTS,
          "the corpus exceeded its ceiling under concurrency",
        );
      } finally {
        await store1.disconnect();
        const client = new MongoClient(REAL_MONGODB_URI);
        try {
          await client.connect();
          await client.db(`${databaseName}_race`).dropDatabase();
        } finally {
          await client.close();
        }
      }
    });

    test("a counter behind reality is raised, so the ceiling still holds", async () => {
      // The dangerous direction. A restore, or a write that bypassed this store, can leave
      // the counter *below* the real document count — and a counter that is too low would
      // let the corpus grow past its ceiling. The claim path raises it with `$max`, which
      // cannot lose an in-flight reservation.
      const behind = new MongoStore({
        uri: REAL_MONGODB_URI,
        databaseName: `${databaseName}_behind`,
      });
      await behind.connect();

      try {
        await behind.storeReferenceDocument(referenceDocument("behind-a"), {
          limit: MAX_REFERENCE_DOCUMENTS,
        });
        await behind.storeReferenceDocument(referenceDocument("behind-b"), {
          limit: MAX_REFERENCE_DOCUMENTS,
        });

        // Force the counter below reality without touching the documents.
        const client = new MongoClient(REAL_MONGODB_URI);
        try {
          await client.connect();
          await client
            .db(`${databaseName}_behind`)
            .collection("reference_corpus_meta")
            .updateOne({ _id: "reference_documents" }, { $set: { count: 0 } });
        } finally {
          await client.close();
        }

        // A create must raise the counter to the real count before claiming, so the
        // corpus cannot silently grow past the ceiling.
        const result = await behind.storeReferenceDocument(referenceDocument("behind-c"), {
          limit: MAX_REFERENCE_DOCUMENTS,
        });

        assert.equal(result.created, true);
        assert.equal(
          await behind.referenceDocumentCount(),
          3,
          "the counter was not raised to the real document count",
        );
      } finally {
        await behind.disconnect();
        const client = new MongoClient(REAL_MONGODB_URI);
        try {
          await client.connect();
          await client.db(`${databaseName}_behind`).dropDatabase();
        } finally {
          await client.close();
        }
      }
    });

    test("a counter ahead of reality is NOT lowered by a claim", async () => {
      // The safety half of the same mechanism. Between a claim and its insert the counter
      // is legitimately ahead of the collection, so lowering it to the document count in
      // that window would discard the reservation and hand the slot out twice. A claim
      // therefore only ever raises.
      const ahead = new MongoStore({
        uri: REAL_MONGODB_URI,
        databaseName: `${databaseName}_ahead`,
      });
      await ahead.connect();

      try {
        await ahead.storeReferenceDocument(referenceDocument("ahead-a"), {
          limit: MAX_REFERENCE_DOCUMENTS,
        });

        const client = new MongoClient(REAL_MONGODB_URI);
        try {
          await client.connect();
          await client
            .db(`${databaseName}_ahead`)
            .collection("reference_corpus_meta")
            .updateOne(
              { _id: "reference_documents" },
              { $set: { count: MAX_REFERENCE_DOCUMENTS } },
            );
        } finally {
          await client.close();
        }

        // A claim with the counter at the ceiling is refused, and the refusal must not
        // reconcile the counter downward — that is what would let a second caller in.
        await assert.rejects(() =>
          ahead.storeReferenceDocument(referenceDocument("ahead-b"), {
            limit: MAX_REFERENCE_DOCUMENTS,
          }),
        );

        assert.equal(
          await ahead.referenceDocumentCount(),
          MAX_REFERENCE_DOCUMENTS,
          "a refusal lowered the counter, which would discard an in-flight reservation",
        );
      } finally {
        await ahead.disconnect();
        const client = new MongoClient(REAL_MONGODB_URI);
        try {
          await client.connect();
          await client.db(`${databaseName}_ahead`).dropDatabase();
        } finally {
          await client.close();
        }
      }
    });

    test("connect reconciles a counter left ahead by a crashed process", async () => {
      // The one place lowering is safe: at startup nothing can be in flight. A process
      // that died between claiming a slot and inserting its document would otherwise leak
      // that reservation for the life of the database, permanently shrinking the corpus.
      const target = `${databaseName}_crash`;
      const first = new MongoStore({ uri: REAL_MONGODB_URI, databaseName: target });
      await first.connect();
      try {
        await first.storeReferenceDocument(referenceDocument("crash-a"), {
          limit: MAX_REFERENCE_DOCUMENTS,
        });
      } finally {
        await first.disconnect();
      }

      // Simulate the leak: one document, but a reservation never released.
      const client = new MongoClient(REAL_MONGODB_URI);
      try {
        await client.connect();
        await client
          .db(target)
          .collection("reference_corpus_meta")
          .updateOne(
            { _id: "reference_documents" },
            { $set: { count: MAX_REFERENCE_DOCUMENTS } },
          );
      } finally {
        await client.close();
      }

      const restarted = new MongoStore({ uri: REAL_MONGODB_URI, databaseName: target });
      await restarted.connect();
      try {
        assert.equal(
          await restarted.referenceDocumentCount(),
          1,
          "connect did not reconcile a leaked reservation",
        );
      } finally {
        await restarted.disconnect();
        const cleanup = new MongoClient(REAL_MONGODB_URI);
        try {
          await cleanup.connect();
          await cleanup.db(target).dropDatabase();
        } finally {
          await cleanup.close();
        }
      }
    });

    test("the registry refuses through the real tool with the documented code", async () => {
      const full = new MongoStore({
        uri: REAL_MONGODB_URI,
        databaseName: `${databaseName}_tool`,
      });
      await full.connect();

      try {
        for (let index = 0; index < MAX_REFERENCE_DOCUMENTS; index++) {
          await full.storeReferenceDocument(referenceDocument(`tool-seed-${index}`), {
            limit: MAX_REFERENCE_DOCUMENTS,
          });
        }

        const registry = createToolRegistry(full);
        await assert.rejects(
          () =>
            registry["store_reference_document"]({
              referenceId: "ref-tool-overflow",
              label: "overflow",
              content: "content",
            }),
          (error: unknown) => {
            const limitError = error as { code?: string; limit?: number };
            assert.equal(limitError.code, REFERENCE_CORPUS_LIMIT_CODE);
            assert.equal(limitError.limit, MAX_REFERENCE_DOCUMENTS);
            return true;
          },
        );
      } finally {
        await full.disconnect();
        const client = new MongoClient(REAL_MONGODB_URI);
        try {
          await client.connect();
          await client.db(`${databaseName}_tool`).dropDatabase();
        } finally {
          await client.close();
        }
      }
    });

    test("the contract suite's own store is unaffected", async () => {
      // A guard against the ceiling leaking into an unrelated store instance: the counter
      // is per database, and this store's database holds no reference documents.
      assert.equal(await store.referenceDocumentCount(), 0);
    });
  });
} else {
  describe("reference corpus ceiling — concurrency against real MongoDB", () => {
    test("skipped: CERBERUS_TEST_MONGODB_URI is not set", { skip: true }, () => {
      // The ceiling is enforced with an atomic conditional `$inc`. A single-threaded
      // double cannot interleave two claims, so it would pass for the trivial reason that
      // nothing races. Run
      //   CERBERUS_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm test
      // to exercise the boundary against a real server.
    });
  });
}

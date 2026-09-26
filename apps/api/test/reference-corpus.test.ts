/**
 * Reference corpus routes and the exfiltration matcher they feed.
 *
 * The corpus exists so `DATA_LEAKAGE_SIMILARITY_THRESHOLD` gates something. The
 * last test in this file is the acceptance criterion: a paste above the threshold
 * produces at least one `ExfiltrationMatch`, and one below it does not.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import {
  MAX_REFERENCE_CONTENT_CHARS,
  MAX_REFERENCE_LABEL_CHARS,
  MAX_REFERENCE_TAGS,
  MAX_REFERENCE_TAG_CHARS,
} from "../src/routes/reference.js";
import { makeConfigWithTtl } from "./helpers.js";
import { authorizedHeaders, installFetchStub, makeConfig, type FetchStub } from "./helpers.js";

import { McpStoreDouble } from "./support/mcp-store-double.js";

/** A 40-word reference document, long enough to clear the comparable floor. */
const REFERENCE_WORDS = Array.from({ length: 40 }, (_, i) => `ledger${i}`);
const REFERENCE_TEXT = REFERENCE_WORDS.join(" ");

/** A near-copy of the reference: one word in forty changed. */
const NEAR_COPY = (() => {
  const words = [...REFERENCE_WORDS];
  words[20] = "substituted";
  return words.join(" ");
})();

/** Roughly half the reference, so it shares phrasing without being a copy. */
const HALF_OVERLAP = REFERENCE_WORDS.slice(0, 20).join(" ");

/** A PASTE event whose content is real prose, so it clears the token floor. */
function prosePasteEvent(sessionId: string, text: string): Record<string, unknown> {
  return {
    eventId: `evt-${Math.random().toString(16).slice(2, 10)}`,
    sessionId,
    employeeId: "op-trader-001",
    auditId: "audit-2026-q1",
    vectorId: "tv-exfil-001",
    eventType: "PASTE",
    timestamp: new Date().toISOString(),
    payload: { newText: text, changeLength: text.length },
    clientMetadata: {
      userAgent: "test-agent",
      ipAddress: "127.0.0.1",
      screenResolution: "1920x1080",
      platform: "web",
      language: "en-US",
    },
  };
}

describe("reference corpus routes", () => {
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

  async function addDocument(
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await app.request("/api/v1/reference-documents", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  test("stores a document and returns its id", async () => {
    const { status, json } = await addDocument({
      label: "internal-ledger-snippet",
      content: REFERENCE_TEXT,
      tags: ["ledger", "internal"],
    });

    assert.equal(status, 201);
    assert.equal(json["success"], true);
    assert.ok(typeof json["referenceId"] === "string" && json["referenceId"].length > 0);
    assert.equal(json["charCount"], REFERENCE_TEXT.length);
    assert.deepEqual(json["tags"], ["ledger", "internal"]);
    assert.equal(mcp.referenceDocuments.size, 1);
  });

  test("re-submitting the same id updates rather than duplicating", async () => {
    await addDocument({ referenceId: "ref-fixed", label: "a", content: REFERENCE_TEXT });
    const { status } = await addDocument({
      referenceId: "ref-fixed",
      label: "b",
      content: REFERENCE_TEXT,
    });

    assert.equal(status, 201);
    assert.equal(mcp.referenceDocuments.size, 1, "a duplicate document was created");
    assert.equal(mcp.referenceDocuments.get("ref-fixed")?.["label"], "b");
  });

  test("requires a label and content", async () => {
    assert.equal((await addDocument({ content: REFERENCE_TEXT })).status, 400);
    assert.equal((await addDocument({ label: "a" })).status, 400);
    assert.equal((await addDocument({ label: "  ", content: REFERENCE_TEXT })).status, 400);
  });

  test("rejects a non-string field with 400 rather than throwing", async () => {
    const { status, json } = await addDocument({ label: 42, content: REFERENCE_TEXT });
    assert.equal(status, 400);
    assert.equal(json["code"], "INVALID_REFERENCE_DOCUMENT");
  });

  test("bounds the label and the content", async () => {
    const longLabel = await addDocument({
      label: "l".repeat(MAX_REFERENCE_LABEL_CHARS + 1),
      content: REFERENCE_TEXT,
    });
    assert.equal(longLabel.status, 400);

    const longContent = await addDocument({
      label: "a",
      content: "w ".repeat(MAX_REFERENCE_CONTENT_CHARS),
    });
    assert.equal(longContent.status, 400);
  });

  test("accepts content exactly at the cap", async () => {
    const content = "w".repeat(MAX_REFERENCE_CONTENT_CHARS);
    const { status } = await addDocument({ label: "a", content });
    assert.equal(status, 201);
  });

  test("bounds the tag list and each tag", async () => {
    const tooMany = await addDocument({
      label: "a",
      content: REFERENCE_TEXT,
      tags: Array.from({ length: MAX_REFERENCE_TAGS + 1 }, (_, i) => `t${i}`),
    });
    assert.equal(tooMany.status, 400);

    const tooLong = await addDocument({
      label: "a",
      content: REFERENCE_TEXT,
      tags: ["t".repeat(MAX_REFERENCE_TAG_CHARS + 1)],
    });
    assert.equal(tooLong.status, 400);

    const nonString = await addDocument({
      label: "a",
      content: REFERENCE_TEXT,
      tags: [42],
    });
    assert.equal(nonString.status, 400);
  });

  test("lists the corpus with a preview rather than the full content", async () => {
    await addDocument({ label: "first", content: REFERENCE_TEXT, tags: ["x"] });

    const res = await app.request("/api/v1/reference-documents", {
      headers: authorizedHeaders(),
    });
    assert.equal(res.status, 200);

    const body = (await res.json()) as {
      success: boolean;
      total: number;
      data: Array<Record<string, unknown>>;
    };
    assert.equal(body.success, true);
    assert.equal(body.total, 1);

    const entry = body.data[0];
    assert.equal(entry["label"], "first");
    assert.equal(entry["charCount"], REFERENCE_TEXT.length);
    assert.deepEqual(entry["tags"], ["x"]);
    assert.ok(!("content" in entry), "the full content was echoed back");
    assert.ok(String(entry["preview"]).length <= 200);
  });

  test("deletes a document, and 404s for an unknown one", async () => {
    const { json } = await addDocument({ label: "a", content: REFERENCE_TEXT });
    const referenceId = String(json["referenceId"]);

    const deleted = await app.request(`/api/v1/reference-documents/${referenceId}`, {
      method: "DELETE",
      headers: authorizedHeaders(),
    });
    assert.equal(deleted.status, 200);
    assert.equal(mcp.referenceDocuments.size, 0);

    const again = await app.request(`/api/v1/reference-documents/${referenceId}`, {
      method: "DELETE",
      headers: authorizedHeaders(),
    });
    assert.equal(again.status, 404);
  });

  test("reports 503 when the corpus store is unreachable", async () => {
    mcp.failToolsMatching("reference");

    const post = await addDocument({ label: "a", content: REFERENCE_TEXT });
    assert.equal(post.status, 503);
    assert.equal(post.json["code"], "REFERENCE_STORE_UNAVAILABLE");

    const list = await app.request("/api/v1/reference-documents", {
      headers: authorizedHeaders(),
    });
    assert.equal(list.status, 503);
  });
});

// ═══════════════════════════════════════════════════════════════════
// The threshold gates something
// ═══════════════════════════════════════════════════════════════════

describe("exfiltration matching through ingest", () => {
  let stub: FetchStub;
  let mcp: McpStoreDouble;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetAIProvider();
    mcp = new McpStoreDouble();
    stub = installFetchStub({ mcpResponse: mcp.responder() });
    // TTL large enough that nothing expires mid-test.
    app = createApp(makeConfigWithTtl(3600));
  });

  afterEach(() => {
    stub.restore();
    resetAIProvider();
  });

  async function addReference(content: string): Promise<void> {
    const res = await app.request("/api/v1/reference-documents", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ referenceId: "ref-1", label: "ledger", content }),
    });
    assert.equal(res.status, 201);
  }

  async function ingestAndReadReport(
    sessionId: string,
    text: string,
  ): Promise<Record<string, unknown> | null> {
    const res = await app.request("/api/v1/guardian/ingest", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ events: [prosePasteEvent(sessionId, text)] }),
    });
    assert.equal(res.status, 200);

    const body = (await res.json()) as {
      riskPayload: { exfiltrationReport: Record<string, unknown> | null } | null;
    };
    assert.ok(body.riskPayload, "no risk payload was produced");
    return body.riskPayload!.exfiltrationReport;
  }

  test("a paste above the threshold produces at least one match", async () => {
    await addReference(REFERENCE_TEXT);

    const report = await ingestAndReadReport("ses-above", NEAR_COPY);

    assert.ok(report, "no exfiltration report was produced");
    const matches = report["matchedSnippets"] as Array<Record<string, unknown>>;
    assert.ok(
      matches.length >= 1,
      `expected a match for a near-copy, got ${JSON.stringify(report)}`,
    );
    assert.ok((report["overallSimilarity"] as number) >= 0.75);
    assert.equal(matches[0]["sourceLabel"], "ledger");
    assert.ok(typeof matches[0]["similarityScore"] === "number");
  });

  test("a paste below the threshold produces none, but still reports the score", async () => {
    await addReference(REFERENCE_TEXT);

    const report = await ingestAndReadReport("ses-below", HALF_OVERLAP);

    assert.ok(report, "no exfiltration report was produced");
    assert.deepEqual(report["matchedSnippets"], []);
    // Below the threshold is not the same as "no similarity": the operator can
    // still see how close it came.
    const score = report["overallSimilarity"] as number;
    assert.ok(score > 0 && score < 0.75, `expected a sub-threshold score, got ${score}`);
  });

  test("an empty corpus produces an empty report rather than failing", async () => {
    const report = await ingestAndReadReport("ses-empty-corpus", NEAR_COPY);

    assert.ok(report, "no exfiltration report was produced");
    assert.deepEqual(report["matchedSnippets"], []);
    assert.equal(report["overallSimilarity"], 0);
  });

  test("an unreachable corpus degrades to no matches, and analysis still succeeds", async () => {
    await addReference(REFERENCE_TEXT);
    mcp.failToolsMatching("reference");

    const report = await ingestAndReadReport("ses-corpus-down", NEAR_COPY);

    assert.ok(report, "analysis did not survive an unreachable corpus");
    assert.deepEqual(report["matchedSnippets"], []);
    assert.equal(report["overallSimilarity"], 0);
  });

  test("the report is computed locally, so aiCompletionLikelihood is not asserted", async () => {
    await addReference(REFERENCE_TEXT);

    const report = await ingestAndReadReport("ses-local", NEAR_COPY);

    assert.ok(report);
    // Cerberus does not attempt to determine whether content was machine
    // generated, so the field is 0 rather than a model guess.
    assert.equal(report["aiCompletionLikelihood"], 0);
  });
});

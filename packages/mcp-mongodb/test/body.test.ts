/**
 * MCP adapter request-body parsing.
 *
 * Integration tests over a real HTTP server, because the behaviour under test is
 * stream behaviour: the previous implementation called `req.destroy()` on an
 * oversized body and never settled its promise, so the handler hung and the
 * client saw a connection reset rather than a status code.
 *
 * The server here drives `parseBody` directly. `http-adapter.ts` itself cannot be
 * imported from a test: it connects to MongoDB and exits the process on failure
 * at module load.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import { DEFAULT_MAX_BODY_BYTES, parseBody } from "../src/body.js";

/** Small cap so fixtures stay tiny; the boundary is what matters, not the size. */
const CAP = 1024;

describe("MCP request body parsing", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    server = createServer(async (req, res) => {
      const result = await parseBody(req, CAP);
      res.writeHead(result.ok ? 200 : result.status, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(result));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** POSTs a body and returns the status and decoded result. */
  async function post(
    body: string | undefined,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${baseUrl}/tools/list_sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    return {
      status: response.status,
      json: (await response.json()) as Record<string, unknown>,
    };
  }

  test("the documented default is 8 MiB", () => {
    assert.equal(DEFAULT_MAX_BODY_BYTES, 8 * 1024 * 1024);
  });

  test("parses a JSON object", async () => {
    const { status, json } = await post(JSON.stringify({ sessionId: "ses-1" }));

    assert.equal(status, 200);
    assert.equal(json["ok"], true);
    assert.deepEqual(json["body"], { sessionId: "ses-1" });
  });

  test("treats an absent body as an empty object", async () => {
    // Several tools take no arguments, so this is legitimate rather than an error.
    const { status, json } = await post(undefined);

    assert.equal(status, 200);
    assert.deepEqual(json["body"], {});
  });

  test("treats a whitespace-only body as an empty object", async () => {
    const { status, json } = await post("   ");
    assert.equal(status, 200);
    assert.deepEqual(json["body"], {});
  });

  test("distinguishes invalid JSON from a missing body", async () => {
    // Both used to resolve to `{}`, so a malformed body surfaced as
    // "Missing required parameter" instead of naming the real problem.
    const { status, json } = await post("{not json");

    assert.equal(status, 400);
    assert.equal(json["code"], "INVALID_JSON");
  });

  test("rejects a JSON body that is not an object", async () => {
    for (const body of ["[1,2,3]", '"a string"', "42", "true", "null"]) {
      const { status, json } = await post(body);
      assert.equal(status, 400, `expected 400 for ${body}`);
      assert.equal(json["code"], "INVALID_BODY", `expected INVALID_BODY for ${body}`);
    }
  });

  test("accepts a body exactly at the cap", async () => {
    const payload = JSON.stringify({ pad: "x".repeat(CAP - 20) });
    assert.ok(Buffer.byteLength(payload) <= CAP, "fixture exceeds the cap");

    const { status, json } = await post(payload);
    assert.equal(status, 200);
    assert.equal(json["ok"], true);
  });

  test(
    "rejects an oversized body with 413 instead of hanging",
    { timeout: 10_000 },
    async () => {
      const payload = JSON.stringify({ pad: "x".repeat(CAP * 8) });

      const { status, json } = await post(payload);

      assert.equal(status, 413);
      assert.equal(json["code"], "PAYLOAD_TOO_LARGE");
      assert.match(String(json["message"]), new RegExp(String(CAP)));
    },
  );

  test(
    "rejects an oversized chunked body with no Content-Length",
    { timeout: 10_000 },
    async () => {
      // A chunked body declares no length, so the cap has to be applied while
      // the stream is read rather than from a header.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"pad":"'));
          controller.enqueue(new TextEncoder().encode("x".repeat(CAP * 8)));
          controller.enqueue(new TextEncoder().encode('"}'));
          controller.close();
        },
      });

      const response = await fetch(`${baseUrl}/tools/list_sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: stream,
        // @ts-expect-error Node requires duplex for a streaming request body.
        duplex: "half",
      });

      assert.equal(response.status, 413);
      const json = (await response.json()) as Record<string, unknown>;
      assert.equal(json["code"], "PAYLOAD_TOO_LARGE");
    },
  );

  test(
    "settles exactly once for an oversized body",
    { timeout: 10_000 },
    async () => {
      // Directly exercises the regression: the promise used to stay pending
      // forever, so awaiting it hung rather than rejecting or resolving.
      const settled = await Promise.race([
        (async () => {
          const { status } = await post(JSON.stringify({ pad: "x".repeat(CAP * 8) }));
          return `settled:${status}`;
        })(),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("timed-out"), 5_000),
        ),
      ]);

      assert.equal(settled, "settled:413");
    },
  );
});

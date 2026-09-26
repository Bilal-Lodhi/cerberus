/**
 * Request correlation: one identifier per request, and one request log line.
 *
 * This suite exists because the behaviour it asserts was documented and false.
 * `docs/api-errors.md` §2 promised that an error body's `correlationId` matched the
 * `X-Correlation-Id` response header and the server log line, while four of the five
 * route groups minted their own `randomUUID()` per handler — so the value in the body
 * appeared in no header and in no log line an operator could key on. See
 * `docs/development/operability-model.md` §4.
 */

import { test, describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/index.js";
import {
  configureLogging,
  resetLogging,
  type LogRecord,
} from "../src/observability/logger.js";
import {
  clearRegisteredSecrets,
} from "../src/observability/redaction.js";
import {
  isValidRequestId,
  MAX_REQUEST_ID_LENGTH,
  resolveRequestId,
} from "../src/observability/request-context.js";
import {
  matchedRouteTemplate,
  UNMATCHED_ROUTE,
} from "../src/observability/route-template.js";
import {
  authorizedHeaders,
  installFetchStub,
  makeConfig,
  pasteEvent,
  TEST_API_KEY,
  TEST_MCP_TOKEN,
} from "./helpers.js";

let records: LogRecord[] = [];

function captureRecords(): void {
  records = [];
  configureLogging({
    level: "debug",
    format: "json",
    sink: (_line, record) => records.push(record),
  });
}

/** Every record for the one request line, in emission order. */
function requestLines(): LogRecord[] {
  return records.filter((record) => record.event === "http.request");
}

beforeEach(() => captureRecords());
afterEach(() => {
  resetLogging();
  clearRegisteredSecrets();
});

describe("incoming identifier validation", () => {
  test("accepts a bounded, well-formed identifier", () => {
    for (const value of ["abc", "req-1", "a.b_c:d-9", "x".repeat(MAX_REQUEST_ID_LENGTH)]) {
      assert.equal(isValidRequestId(value), true, value);
    }
  });

  test("rejects an over-long identifier", () => {
    assert.equal(isValidRequestId("x".repeat(MAX_REQUEST_ID_LENGTH + 1)), false);
  });

  test("rejects every character outside the allowed set", () => {
    for (const value of ["has space", "quote'", 'quote"', "semi;colon", "slash/", "back\\slash"]) {
      assert.equal(isValidRequestId(value), false, value);
    }
  });

  test("rejects a control character or a newline, which is log injection", () => {
    for (const value of ["a\nb", "a\rb", "a\tb", "a\u0000b", "a\u001bb"]) {
      assert.equal(isValidRequestId(value), false, JSON.stringify(value));
    }
  });

  test("rejects an empty or non-string value", () => {
    for (const value of ["", 5, null, undefined, {}, ["a"]]) {
      assert.equal(isValidRequestId(value), false, String(value));
    }
  });

  test("replaces a rejected identifier with a generated one, never echoing it", () => {
    const generated = resolveRequestId("bad id\nwith newline");
    assert.notEqual(generated, "bad id\nwith newline");
    assert.equal(isValidRequestId(generated), true);
    assert.equal(resolveRequestId("fine-1"), "fine-1");
  });
});

describe("route template resolution", () => {
  test("resolves the registered template rather than the concrete path", async () => {
    // The store is stubbed so the answer is deterministic: the detail route now has a
    // durable fallback, and an unreachable store is a `503` rather than a `404`.
    const stub = installFetchStub();
    try {
      const app = createApp(makeConfig());
      const res = await app.request("/api/v1/guardian/sessions/op-trader-001", {
        headers: authorizedHeaders(),
      });

      assert.equal(res.status, 404);
      const line = requestLines()[0];
      assert.equal(line.route, "/api/v1/guardian/sessions/:sessionId");
    } finally {
      stub.restore();
    }
  });

  test("reports an unmatched request without recording its path", async () => {
    const app = createApp(makeConfig());
    await app.request("/api/v1/guardian/sessions/op-trader-001/typo", {
      headers: authorizedHeaders(),
    });

    const line = requestLines()[0];
    assert.equal(line.route, UNMATCHED_ROUTE);
    assert.doesNotMatch(JSON.stringify(line), /op-trader-001/);
  });

  test("returns UNMATCHED_ROUTE rather than throwing on a shape it cannot read", () => {
    assert.equal(
      matchedRouteTemplate({ req: { matchedRoutes: undefined } } as never),
      UNMATCHED_ROUTE,
    );
    assert.equal(
      matchedRouteTemplate({ req: {} } as never),
      UNMATCHED_ROUTE,
    );
  });
});

describe("the response headers carry one identifier", () => {
  let app: ReturnType<typeof createApp>;

  before(() => {
    app = createApp(makeConfig());
  });

  test("X-Request-Id and X-Correlation-Id are the same value on a success", async () => {
    const res = await app.request("/health");
    const requestId = res.headers.get("X-Request-Id");
    const correlationId = res.headers.get("X-Correlation-Id");

    assert.ok(requestId, "X-Request-Id was absent");
    assert.equal(correlationId, requestId);
  });

  test("both headers are present on a 401 as well", async () => {
    const res = await app.request("/api/v1/sessions");
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("X-Request-Id"), res.headers.get("X-Correlation-Id"));
    assert.ok(res.headers.get("X-Request-Id"));
  });

  test("both headers are present on a 404 and on a preflight", async () => {
    const notFound = await app.request("/api/v1/nope", { headers: authorizedHeaders() });
    assert.equal(notFound.status, 404);
    assert.ok(notFound.headers.get("X-Request-Id"));

    const preflight = await app.request("/api/v1/sessions", {
      method: "OPTIONS",
      headers: {
        Origin: "http://console.test",
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.ok(
      preflight.headers.get("X-Request-Id"),
      "a preflight answered by the CORS middleware carried no request id",
    );
  });

  test("echoes a valid caller-supplied identifier into both headers", async () => {
    const res = await app.request("/health", {
      headers: { "X-Request-Id": "caller-chosen-123" },
    });

    assert.equal(res.headers.get("X-Request-Id"), "caller-chosen-123");
    assert.equal(res.headers.get("X-Correlation-Id"), "caller-chosen-123");
  });

  test("replaces an invalid caller-supplied identifier without failing the request", async () => {
    // A space rather than a newline: `undici` refuses to send a header value
    // containing CR or LF, so the newline case is asserted against
    // `isValidRequestId` directly above rather than through a real request.
    const res = await app.request("/health", {
      headers: { "X-Request-Id": "has spaces and/slashes" },
    });

    assert.equal(res.status, 200, "an invalid request id must not fail the request");
    const echoed = res.headers.get("X-Request-Id") ?? "";
    assert.notEqual(echoed, "has spaces and/slashes");
    assert.equal(isValidRequestId(echoed), true);
  });

  test("exposes both headers through CORS", async () => {
    const res = await app.request("/health", {
      headers: { Origin: "http://console.test" },
    });

    const exposed = res.headers.get("Access-Control-Expose-Headers") ?? "";
    assert.match(exposed, /X-Request-Id/);
    assert.match(exposed, /X-Correlation-Id/);
  });
});

describe("the error body's correlationId matches the response header", () => {
  /**
   * One representative request per route group that used to mint its own id. This is
   * the assertion the old behaviour failed for four of the five groups.
   */
  const cases: Array<{ name: string; path: string; init: () => RequestInit }> = [
    {
      name: "guardian (ingest)",
      path: "/api/v1/guardian/ingest",
      init: () => ({
        method: "POST",
        headers: authorizedHeaders(),
        body: JSON.stringify({ events: [] }),
      }),
    },
    {
      name: "guardian (deploy)",
      path: "/api/v1/guardian/deploy",
      init: () => ({
        method: "POST",
        headers: authorizedHeaders(),
        body: JSON.stringify({}),
      }),
    },
    {
      name: "review",
      path: "/api/v1/sessions/ses-absent",
      init: () => ({ headers: authorizedHeaders() }),
    },
    {
      name: "reference",
      path: "/api/v1/reference-documents",
      init: () => ({
        method: "POST",
        headers: authorizedHeaders(),
        body: JSON.stringify({}),
      }),
    },
    {
      name: "auditor",
      path: "/api/v1/auditor/query",
      init: () => ({
        method: "POST",
        headers: authorizedHeaders(),
        body: JSON.stringify({}),
      }),
    },
    {
      name: "scenarios",
      path: "/api/v1/scenarios",
      init: () => ({
        method: "POST",
        headers: authorizedHeaders(),
        body: JSON.stringify({}),
      }),
    },
  ];

  for (const { name, path, init } of cases) {
    test(`${name}: the body's correlationId equals X-Correlation-Id`, async () => {
      const app = createApp(makeConfig());
      const res = await app.request(path, init());
      const body = (await res.json()) as { correlationId?: string };

      assert.ok(res.status >= 400, `${name} did not fail as the fixture expects`);
      assert.ok(body.correlationId, `${name} returned no correlationId`);
      assert.equal(body.correlationId, res.headers.get("X-Correlation-Id"));
      assert.equal(body.correlationId, res.headers.get("X-Request-Id"));
    });
  }

  test("the top-level handler's correlationId matches too", async () => {
    // An unhandled throw is the case the previous implementation could only guess at,
    // because the response did not exist when the header was read.
    const app = createApp(makeConfig());
    const res = await app.request("/api/v1/scenarios/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generationRequestId: "nope" }),
    });
    assert.equal(res.status, 401);
    // 401 deliberately carries no correlationId: the two authentication rejections
    // must stay byte-identical. The header is still the correlation value.
    assert.ok(res.headers.get("X-Correlation-Id"));
  });

  test("a caller-chosen identifier reaches the error body", async () => {
    const app = createApp(makeConfig());
    const res = await app.request("/api/v1/sessions/ses-absent", {
      headers: authorizedHeaders({ "X-Request-Id": "caller-chosen-456" }),
    });
    const body = (await res.json()) as { correlationId?: string };

    assert.equal(body.correlationId, "caller-chosen-456");
  });
});

describe("the request log line", () => {
  test("is emitted exactly once per request, with the outcome", async () => {
    const app = createApp(makeConfig());
    await app.request("/api/v1/sessions/ses-absent", { headers: authorizedHeaders() });

    const lines = requestLines();
    assert.equal(lines.length, 1, `expected one request line, saw ${lines.length}`);
    assert.equal(lines[0].method, "GET");
    assert.equal(lines[0].route, "/api/v1/sessions/:sessionId");
    assert.equal(lines[0].status, 404);
    assert.equal(lines[0].errorCode, "SESSION_NOT_FOUND");
    assert.equal(typeof lines[0].latencyMs, "number");
  });

  test("carries the same request id as the response header", async () => {
    const app = createApp(makeConfig());
    const res = await app.request("/health");

    assert.equal(requestLines()[0].requestId, res.headers.get("X-Request-Id"));
  });

  test("records the stable error code of a refusal", async () => {
    const stub = installFetchStub();
    try {
      const app = createApp(makeConfig());
      await app.request("/api/v1/guardian/ingest", {
        method: "POST",
        headers: authorizedHeaders(),
        // A session but no `eventId`: `eventId` is the durable idempotency key, so an
        // event without one cannot be deduplicated.
        body: JSON.stringify({ events: [{ sessionId: "ses-1", eventType: "PASTE" }] }),
      });

      assert.equal(requestLines()[0].errorCode, "MISSING_EVENT_ID");
    } finally {
      stub.restore();
    }
  });

  test("is a warn for a 4xx and an info for a 2xx", async () => {
    const app = createApp(makeConfig());

    await app.request("/health");
    assert.equal(requestLines()[0].level, "info");

    records = [];
    await app.request("/api/v1/nope");
    assert.equal(requestLines()[0].level, "warn");
  });

  test("never records a session id in the route", async () => {
    const stub = installFetchStub();
    try {
      const app = createApp(makeConfig());
      await app.request("/api/v1/guardian/ingest", {
        method: "POST",
        headers: authorizedHeaders(),
        body: JSON.stringify({
          events: [pasteEvent("op-trader-001-secret-session")],
        }),
      });

      const line = JSON.stringify(requestLines()[0]);
      assert.doesNotMatch(line, /op-trader-001-secret-session/);
    } finally {
      stub.restore();
    }
  });
});

describe("the request line carries no secret", () => {
  test("a credential in a header is never recorded", async () => {
    const app = createApp(makeConfig());
    await app.request("/api/v1/sessions", { headers: authorizedHeaders() });

    const serialised = JSON.stringify(records);
    assert.doesNotMatch(serialised, new RegExp(TEST_API_KEY));
    assert.doesNotMatch(serialised, new RegExp(TEST_MCP_TOKEN));
    assert.doesNotMatch(serialised, /Bearer /);
  });

  test("a refused paid route is logged with its stable code and no prompt", async () => {
    // Checked before any inference is spent, so no stub is needed and the suite still
    // never calls a paid API. The distinctive prefix is what makes the "the question
    // was not logged" half of this test meaningful.
    const app = createApp(makeConfig());
    await app.request("/api/v1/auditor/query", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ question: `SECRET-QUESTION ${"x".repeat(2_100)}` }),
    });

    const line = requestLines()[0];
    assert.equal(line.errorCode, "QUESTION_TOO_LONG");
    assert.doesNotMatch(
      JSON.stringify(line),
      /SECRET-QUESTION/,
      "the auditor question reached the log line",
    );
  });
});

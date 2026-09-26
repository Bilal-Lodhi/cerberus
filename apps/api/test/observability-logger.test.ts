/**
 * The structured logger: levels, formats, ambient correlation and bounds.
 *
 * The logger is the thing every other guarantee is stated against, so its own
 * behaviour is asserted directly rather than inferred from a request.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  configureLogging,
  currentLoggingConfig,
  isLevelEnabled,
  isLogFormat,
  isLogLevel,
  LOG_EVENTS,
  logger,
  resetLogging,
  type LogRecord,
} from "../src/observability/logger.js";
import {
  clearRegisteredSecrets,
  registerSecret,
} from "../src/observability/redaction.js";
import {
  runWithRequestContext,
  NO_REQUEST_ID,
} from "../src/observability/request-context.js";

let lines: string[] = [];
let records: LogRecord[] = [];

/** Captures every line and record at `debug`, the most permissive level. */
function capture(level: "debug" | "info" | "warn" | "error" = "debug"): void {
  lines = [];
  records = [];
  configureLogging({
    level,
    sink: (line, record) => {
      lines.push(line);
      records.push(record);
    },
  });
}

beforeEach(() => {
  capture();
});

afterEach(() => {
  resetLogging();
  clearRegisteredSecrets();
});

describe("level and format validation", () => {
  test("accepts exactly the documented values", () => {
    for (const level of ["debug", "info", "warn", "error"]) {
      assert.equal(isLogLevel(level), true, level);
    }
    for (const format of ["pretty", "json"]) {
      assert.equal(isLogFormat(format), true, format);
    }
  });

  test("rejects anything else, including case variants", () => {
    // Validation is case-insensitive in `loadConfig`, but the guard itself is exact:
    // the config reader lower-cases before calling it, so a raw "DEBUG" here means a
    // caller bypassed the reader.
    for (const value of ["DEBUG", "verbose", "trace", "", "info ", 5, null, undefined]) {
      assert.equal(isLogLevel(value), false, String(value));
      assert.equal(isLogFormat(value), false, String(value));
    }
  });

  test("defaults to info and pretty", () => {
    resetLogging();
    assert.deepEqual(currentLoggingConfig(), { level: "info", format: "pretty" });
  });
});

describe("level filtering", () => {
  test("emits at or above the configured level and drops the rest", () => {
    configureLogging({ level: "warn" });
    capture("warn");

    logger.debug("test.debug");
    logger.info("test.info");
    logger.warn("test.warn");
    logger.error("test.error");

    assert.deepEqual(
      records.map((record) => record.level),
      ["warn", "error"],
    );
  });

  test("a dropped level costs nothing and emits nothing", () => {
    configureLogging({ level: "error" });
    lines = [];
    records = [];

    logger.debug("test.debug", { huge: "x".repeat(1000) });
    logger.info("test.info");
    logger.warn("test.warn");

    assert.equal(lines.length, 0);
    assert.equal(records.length, 0);
  });

  test("isLevelEnabled agrees with what is emitted", () => {
    configureLogging({ level: "info" });
    assert.equal(isLevelEnabled("debug"), false);
    assert.equal(isLevelEnabled("info"), true);
    assert.equal(isLevelEnabled("error"), true);
  });
});

describe("record shape", () => {
  test("carries a timestamp, a level and a stable event name", () => {
    logger.info("http.request", { status: 200 });

    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.event, "http.request");
    assert.equal(record.level, "info");
    assert.equal(record.status, 200);
    assert.match(String(record.timestamp), /^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  test("places the request id immediately after the event name", () => {
    runWithRequestContext(
      { requestId: "req-1", method: "GET", route: "/health" },
      () => logger.info("http.request", { status: 200 }),
    );

    assert.deepEqual(Object.keys(records[0]), [
      "timestamp",
      "level",
      "event",
      "requestId",
      "status",
    ]);
  });

  test("attaches the ambient request id without being handed one", () => {
    runWithRequestContext(
      { requestId: "req-ambient", method: "POST", route: "/x" },
      () => logger.info("mcp.call", { tool: "ping" }),
    );

    assert.equal(records[0].requestId, "req-ambient");
  });

  test("an explicit request id wins over the ambient one", () => {
    runWithRequestContext(
      { requestId: "req-ambient", method: "GET", route: "/ready" },
      () => logger.info("mcp.call", { requestId: "readiness" }),
    );

    assert.equal(records[0].requestId, "readiness");
  });

  test("omits the request id entirely outside a request", () => {
    logger.info("process.startup", { port: 8080 });
    assert.equal(records[0].requestId, undefined);
    assert.equal(NO_REQUEST_ID, "-");
  });

  test("never lets a field overwrite the event name, level or timestamp", () => {
    logger.info("real.event", { event: "forged", level: "error", timestamp: "nope" });

    assert.equal(records[0].event, "real.event");
    assert.equal(records[0].level, "info");
    assert.notEqual(records[0].timestamp, "nope");
  });
});

describe("json format", () => {
  test("emits exactly one line of valid JSON per record", () => {
    capture();
    configureLogging({ format: "json" });

    logger.info("http.request", { status: 404, route: "/api/v1/nope" });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].split("\n").length, 1);
    assert.deepEqual(JSON.parse(lines[0]), records[0]);
  });

  test("a newline inside a field value cannot forge a second line", () => {
    configureLogging({ format: "json" });
    logger.info("test.event", { note: "line one\nline two" });

    assert.equal(lines[0].split("\n").length, 1);
    assert.equal(JSON.parse(lines[0]).note, "line one\\nline two");
  });
});

describe("pretty format", () => {
  test("renders one line with the level, the event and the fields", () => {
    logger.warn("http.request", { status: 429, errorCode: "RATE_LIMITED" });

    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] WARN {2}http\.request /);
    assert.match(lines[0], /status=429/);
    assert.match(lines[0], /errorCode=RATE_LIMITED/);
  });

  test("quotes a value containing whitespace and escapes a newline", () => {
    logger.info("test.event", { note: "two words", injected: "a\nb" });

    assert.match(lines[0], /note="two words"/);
    // One literal backslash-n: the value is escaped, so it cannot start a new line.
    assert.match(lines[0], /injected=a\\nb/);
    assert.equal(lines[0].split("\n").length, 1);
  });

  test("renders a nested value as JSON", () => {
    logger.info("test.event", { nested: { a: 1 } });
    assert.match(lines[0], /nested=\{"a":1\}/);
  });
});

describe("redaction is applied before serialisation", () => {
  const SECRET = "operator-key-0123456789abcdef";

  test("a registered secret never appears in either format", () => {
    registerSecret(SECRET);

    for (const format of ["pretty", "json"] as const) {
      configureLogging({ format });
      lines = [];
      logger.error("test.event", {
        reason: `credential ${SECRET} rejected`,
        authorization: `Bearer ${SECRET}`,
      });

      assert.doesNotMatch(lines[0], /operator-key-0123456789abcdef/, format);
      assert.match(lines[0], /\[redacted\]/, format);
    }
  });

  test("a credentialed URI never appears", () => {
    logger.info("mcp.failure", {
      error: "connect failed for mongodb://cerberus:hunter2@db.internal:27017/cerberus",
    });
    assert.doesNotMatch(lines[0], /hunter2/);
  });

  test("monitored content is withheld, not scrubbed", () => {
    logger.info("test.event", { currentCode: "const password = 'x';" });
    assert.doesNotMatch(lines[0], /const password/);
    assert.match(lines[0], /\[redacted:content\]/);
  });

  test("a huge payload is bounded before it is serialised", () => {
    logger.info("test.event", { body: "x".repeat(200_000) });
    assert.ok(lines[0].length < 2_000, `line was ${lines[0].length} characters`);
  });
});

describe("failure()", () => {
  test("describes an error instead of serialising it", () => {
    const error = new Error("boom");
    (error as { headers?: unknown }).headers = { authorization: "Bearer leak" };

    logger.failure("test.failure", error, { sessionId: "ses-1" });

    const record = records[0];
    assert.deepEqual(record["error"], { name: "Error", message: "boom" });
    assert.equal(record.sessionId, "ses-1");
    assert.doesNotMatch(lines[0], /Bearer leak/);
  });

  test("accepts a thrown non-Error", () => {
    logger.failure("test.failure", "just a string");
    assert.deepEqual(records[0]["error"], { name: "Error", message: "just a string" });
  });
});

describe("event names", () => {
  test("every event name is a stable dotted identifier", () => {
    for (const [key, value] of Object.entries(LOG_EVENTS)) {
      assert.match(value, /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/, `${key} = ${value}`);
    }
  });

  test("event names are unique", () => {
    const values = Object.values(LOG_EVENTS);
    assert.equal(new Set(values).size, values.length);
  });
});

/**
 * Configuration loading.
 *
 * Focused on the fail-closed validation of `SESSION_TTL_SECONDS`: the variable
 * was previously parsed and ignored, so its validation is now the control that
 * decides how long an operator may be monitored. A misconfiguration must stop
 * the process rather than silently pick a monitoring window.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { ConfigError, loadConfig } from "../src/config.js";

/** Every variable these tests touch, so the environment is restored exactly. */
const MANAGED_VARS = [
  "OPENAI_API_KEY",
  "CERBERUS_API_KEY",
  "CERBERUS_API_KEY_PREVIOUS",
  "CERBERUS_MCP_TOKEN",
  "CERBERUS_DEV_MODE",
  "NODE_ENV",
  "SESSION_TTL_SECONDS",
  "CERBERUS_MAX_BODY_BYTES",
  "CERBERUS_LOG_LEVEL",
  "CERBERUS_LOG_FORMAT",
  "CERBERUS_IDEMPOTENCY_TTL_SECONDS",
] as const;

/** Puts the environment into a minimal valid state for `loadConfig()`. */
function installMinimalEnv(saved: Map<string, string | undefined>): void {
  for (const name of MANAGED_VARS) saved.set(name, process.env[name]);

  // Dev mode keeps the two optional secrets out of the way, and NODE_ENV is
  // cleared because dev mode is refused under production.
  process.env["OPENAI_API_KEY"] = "test-openai-key";
  process.env["CERBERUS_DEV_MODE"] = "true";
  delete process.env["NODE_ENV"];
  delete process.env["SESSION_TTL_SECONDS"];
  delete process.env["CERBERUS_MAX_BODY_BYTES"];
  delete process.env["CERBERUS_API_KEY_PREVIOUS"];
  delete process.env["CERBERUS_LOG_LEVEL"];
  delete process.env["CERBERUS_LOG_FORMAT"];
  delete process.env["CERBERUS_IDEMPOTENCY_TTL_SECONDS"];
}

function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const name of MANAGED_VARS) {
    const previous = saved.get(name);
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

describe("loadConfig — SESSION_TTL_SECONDS", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => installMinimalEnv(saved));
  afterEach(() => restoreEnv(saved));

  test("defaults to 7200 seconds when unset", () => {
    assert.equal(loadConfig().security.sessionTTLSeconds, 7200);
  });

  test("honours an explicit positive value", () => {
    process.env["SESSION_TTL_SECONDS"] = "60";
    assert.equal(loadConfig().security.sessionTTLSeconds, 60);
  });

  test("tolerates surrounding whitespace", () => {
    process.env["SESSION_TTL_SECONDS"] = "  300  ";
    assert.equal(loadConfig().security.sessionTTLSeconds, 300);
  });

  test("refuses a value that is not a positive whole number of seconds", () => {
    // Zero and negatives would expire every session the moment it is created.
    // Fractions, exponents and trailing garbage would silently be read as a
    // different number than the operator wrote.
    for (const bad of ["0", "-1", "-7200", "1.5", "1e3", "abc", "7200abc"]) {
      process.env["SESSION_TTL_SECONDS"] = bad;
      assert.throws(
        () => loadConfig(),
        (error: unknown) =>
          error instanceof ConfigError && error.message.includes("SESSION_TTL_SECONDS"),
        `expected a ConfigError for SESSION_TTL_SECONDS=${JSON.stringify(bad)}`,
      );
    }
  });

  test("refuses a value that is not a safe integer", () => {
    process.env["SESSION_TTL_SECONDS"] = "99999999999999999999";
    assert.throws(
      () => loadConfig(),
      (error: unknown) =>
        error instanceof ConfigError && error.message.includes("SESSION_TTL_SECONDS"),
    );
  });

  test("the error message names the variable and the default", () => {
    process.env["SESSION_TTL_SECONDS"] = "0";
    assert.throws(
      () => loadConfig(),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes("SESSION_TTL_SECONDS") &&
        error.message.includes("7200"),
    );
  });
});

describe("loadConfig — CERBERUS_IDEMPOTENCY_TTL_SECONDS", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => installMinimalEnv(saved));
  afterEach(() => restoreEnv(saved));

  test("defaults to 24 hours when unset", () => {
    assert.equal(loadConfig().idempotency.ttlSeconds, 86_400);
  });

  test("honours an explicit value inside the bounds", () => {
    for (const value of ["60", "3600", "604800"]) {
      process.env["CERBERUS_IDEMPOTENCY_TTL_SECONDS"] = value;
      assert.equal(loadConfig().idempotency.ttlSeconds, Number(value));
    }
  });

  test("refuses a value below the floor", () => {
    // Below the floor, a claim expires before an ordinary retry arrives — so the caller's
    // key stops being recognised and a retry spends a second time, silently.
    for (const bad of ["0", "1", "59"]) {
      process.env["CERBERUS_IDEMPOTENCY_TTL_SECONDS"] = bad;
      assert.throws(
        () => loadConfig(),
        (error: unknown) =>
          error instanceof ConfigError &&
          error.message.includes("CERBERUS_IDEMPOTENCY_TTL_SECONDS") &&
          error.message.includes("between"),
        `expected a ConfigError for CERBERUS_IDEMPOTENCY_TTL_SECONDS=${bad}`,
      );
    }
  });

  test("refuses a value above the ceiling", () => {
    // Above the ceiling, a collection of caller-supplied keys outlives its usefulness.
    for (const bad of ["604801", "9999999"]) {
      process.env["CERBERUS_IDEMPOTENCY_TTL_SECONDS"] = bad;
      assert.throws(
        () => loadConfig(),
        (error: unknown) =>
          error instanceof ConfigError &&
          error.message.includes("CERBERUS_IDEMPOTENCY_TTL_SECONDS"),
        `expected a ConfigError for CERBERUS_IDEMPOTENCY_TTL_SECONDS=${bad}`,
      );
    }
  });

  test("refuses a value that is not a whole number of seconds", () => {
    for (const bad of ["1.5", "86400s", "1e5", "abc", "-1", "  "]) {
      process.env["CERBERUS_IDEMPOTENCY_TTL_SECONDS"] = bad;
      if (bad.trim().length === 0) {
        // An all-whitespace value reads as unset, which takes the default rather than
        // failing — the same rule every other setting follows.
        assert.equal(loadConfig().idempotency.ttlSeconds, 86_400);
        continue;
      }
      assert.throws(
        () => loadConfig(),
        (error: unknown) =>
          error instanceof ConfigError &&
          error.message.includes("CERBERUS_IDEMPOTENCY_TTL_SECONDS"),
        `expected a ConfigError for CERBERUS_IDEMPOTENCY_TTL_SECONDS=${JSON.stringify(bad)}`,
      );
    }
  });

  test("the parsed value is actually consumed, not merely validated", () => {
    // A variable that is parsed and then read by nothing is the failure the configuration
    // census exists to catch. This asserts the value reaches the config object the route
    // uses to compute a claim's `expiresAt`.
    process.env["CERBERUS_IDEMPOTENCY_TTL_SECONDS"] = "120";
    assert.equal(loadConfig().idempotency.ttlSeconds, 120);
  });
});

describe("loadConfig — CERBERUS_MAX_BODY_BYTES", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => installMinimalEnv(saved));
  afterEach(() => restoreEnv(saved));

  test("defaults to 8 MiB when unset", () => {
    assert.equal(loadConfig().security.maxRequestBodyBytes, 8 * 1024 * 1024);
  });

  test("honours an explicit value", () => {
    process.env["CERBERUS_MAX_BODY_BYTES"] = "1024";
    assert.equal(loadConfig().security.maxRequestBodyBytes, 1024);
  });

  test("refuses a value that is not a positive whole number of bytes", () => {
    // A zero or negative cap would refuse every request with a body, and a
    // fractional or suffixed value would silently mean something else.
    for (const bad of ["0", "-1", "1.5", "8e6", "8388608abc", "abc"]) {
      process.env["CERBERUS_MAX_BODY_BYTES"] = bad;
      assert.throws(
        () => loadConfig(),
        (error: unknown) =>
          error instanceof ConfigError &&
          error.message.includes("CERBERUS_MAX_BODY_BYTES"),
        `expected a ConfigError for CERBERUS_MAX_BODY_BYTES=${JSON.stringify(bad)}`,
      );
    }
  });
});

describe("loadConfig — CERBERUS_API_KEY_PREVIOUS", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => installMinimalEnv(saved));
  afterEach(() => restoreEnv(saved));

  test("is absent when unset", () => {
    assert.equal(loadConfig().auth.previousApiKey, undefined);
  });

  test("is carried through when set alongside a current key", () => {
    process.env["CERBERUS_API_KEY"] = "current-key";
    process.env["CERBERUS_API_KEY_PREVIOUS"] = "retired-key";

    const config = loadConfig();
    assert.equal(config.auth.apiKey, "current-key");
    assert.equal(config.auth.previousApiKey, "retired-key");
  });

  test("refuses to be the only key", () => {
    // Accepting a "previous" key with no current key would leave a deployment
    // authenticating against the credential it is trying to retire.
    process.env["CERBERUS_API_KEY_PREVIOUS"] = "retired-key";

    assert.throws(
      () => loadConfig(),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes("CERBERUS_API_KEY_PREVIOUS"),
    );
  });

  test("an overlap equal to the current key is accepted but warned about", () => {
    // Not an error: it is a no-op rather than a misconfiguration. The warning is
    // what tells an operator the rotation is already finished.
    process.env["CERBERUS_API_KEY"] = "same-key";
    process.env["CERBERUS_API_KEY_PREVIOUS"] = "same-key";

    const config = loadConfig();
    assert.equal(config.auth.previousApiKey, "same-key");
  });
});

describe("loadConfig — structured logging", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => installMinimalEnv(saved));
  afterEach(() => restoreEnv(saved));

  test("defaults to info and pretty", () => {
    // `pretty` is the default because the common case is one developer reading a
    // terminal; `json` is what a log shipper consumes.
    assert.deepEqual(loadConfig().log, { level: "info", format: "pretty" });
  });

  test("honours an explicit level and format, case-insensitively", () => {
    process.env["CERBERUS_LOG_LEVEL"] = "DEBUG";
    process.env["CERBERUS_LOG_FORMAT"] = "JSON";

    assert.deepEqual(loadConfig().log, { level: "debug", format: "json" });
  });

  test("tolerates surrounding whitespace", () => {
    process.env["CERBERUS_LOG_LEVEL"] = "  warn  ";
    assert.equal(loadConfig().log.level, "warn");
  });

  test("refuses an unusable level rather than silently falling back", () => {
    // A typo in a logging control must not quietly change what is recorded — the same
    // reasoning that makes SESSION_TTL_SECONDS and CERBERUS_MAX_BODY_BYTES fail closed.
    process.env["CERBERUS_LOG_LEVEL"] = "verbose";

    assert.throws(
      () => loadConfig(),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes("CERBERUS_LOG_LEVEL") &&
        error.message.includes("verbose"),
    );
  });

  test("refuses an unusable format", () => {
    process.env["CERBERUS_LOG_FORMAT"] = "xml";

    assert.throws(
      () => loadConfig(),
      (error: unknown) =>
        error instanceof ConfigError && error.message.includes("CERBERUS_LOG_FORMAT"),
    );
  });
});


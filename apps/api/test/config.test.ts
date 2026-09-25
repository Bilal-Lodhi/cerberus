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
  "CERBERUS_MCP_TOKEN",
  "CERBERUS_DEV_MODE",
  "NODE_ENV",
  "SESSION_TTL_SECONDS",
] as const;

describe("loadConfig — SESSION_TTL_SECONDS", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of MANAGED_VARS) saved.set(name, process.env[name]);

    // Minimal valid environment. Dev mode keeps the two optional secrets out of
    // the way so the TTL is the only variable under test, and NODE_ENV is
    // cleared because dev mode is refused under production.
    process.env["OPENAI_API_KEY"] = "test-openai-key";
    process.env["CERBERUS_DEV_MODE"] = "true";
    delete process.env["NODE_ENV"];
    delete process.env["SESSION_TTL_SECONDS"];
  });

  afterEach(() => {
    for (const name of MANAGED_VARS) {
      const previous = saved.get(name);
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

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

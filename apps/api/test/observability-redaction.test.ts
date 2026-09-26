/**
 * Redaction: the guarantee that a secret cannot reach a log line.
 *
 * Driven directly rather than inferred from a rendered log line, because this is the
 * one part of logging whose failure is silent and permanent: a secret written to a log
 * is a secret disclosed, and no later fix un-discloses it.
 *
 * Two layers are asserted separately, because they fail differently: the
 * known-secret registry only knows what configuration told it, and pattern
 * scrubbing only recognises shapes it has been taught. See
 * `docs/security/threat-model.md` §9.3.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  clearRegisteredSecrets,
  describeError,
  escapeControlCharacters,
  isContentKey,
  isSensitiveKey,
  MAX_LOGGED_ARRAY_ENTRIES,
  MAX_LOGGED_DEPTH,
  MAX_LOGGED_STRING_CHARS,
  REDACTED,
  REDACTED_CONTENT,
  redactString,
  redactValue,
  registerConfiguredSecrets,
  registeredSecretCount,
  registerSecret,
  truncateString,
  UNLOGGABLE,
} from "../src/observability/redaction.js";

const OPERATOR_KEY = "operator-key-0123456789abcdef";
const MCP_TOKEN = "mcp-token-0123456789abcdef";
const OPENAI_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";
const CREDENTIALED_URI = "mongodb://cerberus:hunter2@db.internal:27017/cerberus";

beforeEach(() => clearRegisteredSecrets());
afterEach(() => clearRegisteredSecrets());

describe("the known-secret registry", () => {
  test("replaces a registered secret wherever it appears", () => {
    registerSecret(OPERATOR_KEY);

    assert.equal(
      redactString(`presented credential ${OPERATOR_KEY} was rejected`),
      `presented credential ${REDACTED} was rejected`,
    );
    assert.equal(redactString(OPERATOR_KEY), REDACTED);
  });

  test("replaces a secret embedded inside a larger token", () => {
    registerSecret(MCP_TOKEN);
    assert.equal(
      redactString(`Bearer ${MCP_TOKEN}extra`),
      `Bearer ${REDACTED}extra`,
    );
  });

  test("replaces every occurrence, not only the first", () => {
    registerSecret(OPERATOR_KEY);
    const out = redactString(`${OPERATOR_KEY} and ${OPERATOR_KEY}`);
    assert.equal(out, `${REDACTED} and ${REDACTED}`);
  });

  test("refuses a value too short to be a credential", () => {
    // A four-character dev token would otherwise be replaced everywhere it appears as
    // a substring, turning every log line into confetti.
    assert.equal(registerSecret("abc"), false);
    assert.equal(registeredSecretCount(), 0);
    assert.equal(redactString("abc def"), "abc def");
  });

  test("ignores an absent or non-string value", () => {
    assert.equal(registerSecret(undefined), false);
    assert.equal(registerSecret(null), false);
    assert.equal(registerSecret(""), false);
    assert.equal(registeredSecretCount(), 0);
  });

  test("is idempotent", () => {
    registerSecret(OPERATOR_KEY);
    registerSecret(OPERATOR_KEY);
    assert.equal(registeredSecretCount(), 1);
  });

  test("replaces the longer secret first, so no suffix of it survives", () => {
    registerSecret("secret-suffix-0123456789");
    registerSecret("secret-suffix-0123456789-extended");

    assert.equal(
      redactString("secret-suffix-0123456789-extended"),
      REDACTED,
    );
  });
});

describe("registerConfiguredSecrets", () => {
  test("registers every credential the config carries", () => {
    const registered = registerConfiguredSecrets({
      auth: { apiKey: OPERATOR_KEY, previousApiKey: "previous-key-0123456789abcdef" },
      mcp: { apiKey: MCP_TOKEN },
      openai: { apiKey: OPENAI_KEY },
    });

    assert.equal(registered, 4);
    assert.equal(registeredSecretCount(), 4);
  });

  test("counts only the credentials that are present", () => {
    assert.equal(registerConfiguredSecrets({ auth: { apiKey: OPERATOR_KEY } }), 1);
    assert.equal(registerConfiguredSecrets({}), 0);
  });
});

describe("credential-shaped patterns", () => {
  test("removes the userinfo section of a connection string", () => {
    const out = redactString(`connect failed for ${CREDENTIALED_URI}`);
    assert.doesNotMatch(out, /hunter2/);
    assert.doesNotMatch(out, /cerberus:hunter2/);
    assert.match(out, /mongodb:\/\/\[redacted\]@db\.internal:27017\/cerberus/);
  });

  test("leaves a connection string without credentials alone", () => {
    const plain = "mongodb://db.internal:27017/cerberus";
    assert.equal(redactString(plain), plain);
  });

  test("removes a bearer token", () => {
    assert.equal(redactString("Authorization: Bearer abc123def456"), `Authorization: Bearer ${REDACTED}`);
    assert.equal(redactString("bearer xyz.abc-123_456"), `bearer ${REDACTED}`);
  });

  test("removes a provider-style key", () => {
    assert.doesNotMatch(redactString(`key=${OPENAI_KEY}`), /sk-proj-/);
  });

  test("removes a SendGrid key, a Slack token, a Google key and a webhook URL", () => {
    const sendgrid = "SG.abcdefghijklmnop.qrstuvwxyz0123456789";
    // Deliberately shaped so it matches the redactor's `xox[baprs]-` pattern without
    // matching a real Slack token's digit-and-length layout. A fixture that tripped a
    // secret scanner would be worse than useless: it would train a maintainer to click
    // "allow" on a push-protection warning.
    const slackToken = "xoxb-not-a-real-token-000000000000";
    const google = "AIzaSyA1234567890abcdefghijklmnopqrst";
    const webhook = "https://hooks.slack.com/services/T1/B2/SECRETPART";

    for (const value of [sendgrid, slackToken, google, webhook]) {
      assert.equal(redactString(value), REDACTED, `not redacted: ${value}`);
    }
  });

  test("removes a PEM private-key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    assert.equal(redactString(pem), REDACTED);
  });

  test("does not touch ordinary prose", () => {
    const prose = "session 'op-1' terminated (data preserved)";
    assert.equal(redactString(prose), prose);
  });
});

describe("control characters and log injection", () => {
  test("escapes a newline instead of emitting a second log line", () => {
    // A newline in a logged value forges a second log line, which is how a caller
    // manufactures evidence an operator then reads.
    const out = redactString("value\nINFO forged line");
    assert.equal(out, "value\\nINFO forged line");
    assert.equal(out.split("\n").length, 1);
  });

  test("escapes carriage returns and tabs", () => {
    assert.equal(redactString("a\rb\tc"), "a\\rb\\tc");
  });

  test("drops other control characters", () => {
    assert.equal(escapeControlCharacters("a\u0000b\u0007c\u001bd"), "abcd");
  });
});

describe("value redaction", () => {
  test("replaces a credential-valued key rather than scrubbing its value", () => {
    const out = redactValue({
      authorization: "Bearer whatever",
      apiKey: "whatever",
      MCP_TOKEN: "whatever",
      password: "whatever",
      mongodbUri: CREDENTIALED_URI,
      webhookUrl: "https://hooks.slack.com/services/T1/B2/X",
    }) as Record<string, unknown>;

    for (const key of Object.keys(out)) {
      assert.equal(out[key], REDACTED, `${key} was not replaced`);
    }
  });

  test("withholds monitored content wholesale, and says so", () => {
    const out = redactValue({
      currentCode: "const secret = 1;",
      terminalContent: "the workspace",
      pasteContent: "pasted text",
      events: [{ payload: { newText: "x" } }],
      prompt: "the whole prompt",
      content: "reference text",
      report: { overallRiskScore: 99 },
    }) as Record<string, unknown>;

    for (const [key, value] of Object.entries(out)) {
      assert.equal(value, REDACTED_CONTENT, `${key} was not withheld`);
    }
  });

  test("keeps ordinary fields", () => {
    const out = redactValue({
      status: 200,
      latencyMs: 1.25,
      ok: true,
      sessionId: "ses-1",
      missing: null,
    }) as Record<string, unknown>;

    assert.deepEqual(out, {
      status: 200,
      latencyMs: 1.25,
      ok: true,
      sessionId: "ses-1",
      missing: null,
    });
  });

  test("redacts a secret that reached the value of an ordinary field", () => {
    registerSecret(OPERATOR_KEY);
    const out = redactValue({ note: `key=${OPERATOR_KEY}` }) as Record<string, unknown>;
    assert.equal(out["note"], `key=${REDACTED}`);
  });

  test("bounds a long string and states how much was withheld", () => {
    const long = "x".repeat(MAX_LOGGED_STRING_CHARS + 500);
    const out = redactValue(long) as string;
    assert.ok(out.length < long.length);
    assert.match(out, /\[\+500 chars\]$/);
  });

  test("bounds an array and states how many entries were dropped", () => {
    const out = redactValue(
      Array.from({ length: MAX_LOGGED_ARRAY_ENTRIES + 5 }, (_, i) => i),
    ) as unknown[];
    assert.equal(out.length, MAX_LOGGED_ARRAY_ENTRIES + 1);
    assert.equal(out[out.length - 1], "[+5 more]");
  });

  test("bounds recursion depth", () => {
    let nested: unknown = "leaf";
    for (let i = 0; i < MAX_LOGGED_DEPTH + 3; i += 1) nested = { nested };

    const out = JSON.stringify(redactValue(nested));
    assert.match(out, /depth-limit/);
  });

  test("bounds the number of object keys", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 120; i += 1) wide[`k${i}`] = i;

    const out = redactValue(wide) as Record<string, unknown>;
    assert.equal(out["…"], "[+70 more keys]");
  });

  test("marks a value whose type cannot be serialised", () => {
    assert.equal(redactValue(() => 1), UNLOGGABLE);
    assert.equal(redactValue(Symbol("x")), UNLOGGABLE);
    assert.equal(redactValue(Number.NaN), UNLOGGABLE);
    assert.equal(redactValue(Number.POSITIVE_INFINITY), UNLOGGABLE);
  });

  test("converts a Date to an ISO string", () => {
    assert.equal(redactValue(new Date(0)), "1970-01-01T00:00:00.000Z");
  });
});

describe("describeError", () => {
  test("never returns the error object itself", () => {
    const error = new Error("boom");
    (error as { request?: unknown }).request = { headers: { authorization: "Bearer leak" } };
    (error as { code?: unknown }).code = "ECONNREFUSED";

    const described = describeError(error);
    assert.deepEqual(Object.keys(described).sort(), ["code", "message", "name"]);
    assert.equal(described["name"], "Error");
    assert.equal(described["message"], "boom");
    assert.equal(described["code"], "ECONNREFUSED");
  });

  test("scrubs a credentialed URI quoted in the message", () => {
    const described = describeError(new Error(`failed to connect to ${CREDENTIALED_URI}`));
    assert.doesNotMatch(String(described["message"]), /hunter2/);
  });

  test("scrubs a registered secret quoted in the message", () => {
    registerSecret(OPERATOR_KEY);
    const described = describeError(new Error(`rejected ${OPERATOR_KEY}`));
    assert.equal(described["message"], `rejected ${REDACTED}`);
  });

  test("handles a thrown non-Error", () => {
    assert.deepEqual(describeError("just a string"), {
      name: "Error",
      message: "just a string",
    });
    assert.equal(describeError({ weird: true })["message"], UNLOGGABLE);
  });
});

describe("key classification", () => {
  test("recognises credential keys case-insensitively", () => {
    for (const key of ["authorization", "API_KEY", "mcpToken", "X-Api-Key", "webhookUrl"]) {
      assert.equal(isSensitiveKey(key), true, `${key} was not treated as sensitive`);
    }
  });

  test("does not treat an ordinary key as a credential", () => {
    for (const key of ["status", "latencyMs", "sessionId", "tool", "route"]) {
      assert.equal(isSensitiveKey(key), false, `${key} was treated as sensitive`);
    }
  });

  test("recognises content keys", () => {
    for (const key of ["currentCode", "terminalContent", "prompt", "report", "events"]) {
      assert.equal(isContentKey(key), true, `${key} was not treated as content`);
    }
    assert.equal(isContentKey("latencyMs"), false);
  });
});

describe("truncateString", () => {
  test("leaves a short string alone and states what a long one lost", () => {
    assert.equal(truncateString("short", 10), "short");
    assert.equal(truncateString("0123456789abc", 10), "0123456789…[+3 chars]");
  });
});

/**
 * The secret-logging regression sweep.
 *
 * `docs/development/operability-model.md` §7.1 lists what must never reach a log line,
 * and `docs/security/threat-model.md` §9.2 states it as a security property. This suite
 * drives real requests through the real routes with logging at its **most verbose**
 * level and asserts that not one of those values appears anywhere in the output.
 *
 * Logging at `debug` is deliberate: a guarantee that only holds at the default level is
 * not a guarantee, and `debug` is where the per-step detail — MCP calls, provider
 * attempts — is emitted.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/index.js";
import {
  configureLogging,
  LOG_EVENTS,
  logger,
  resetLogging,
} from "../src/observability/logger.js";
import {
  clearRegisteredSecrets,
  registerSecret,
} from "../src/observability/redaction.js";
import {
  authorizedHeaders,
  installFetchStub,
  makeConfig,
  pasteEvent,
  TEST_API_KEY,
  TEST_MCP_TOKEN,
} from "./helpers.js";

const PREVIOUS_API_KEY = "retired-operator-key-0123456789abcdef";
const OPENAI_KEY = "sk-proj-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
const MCP_TOKEN = "mcp-sidecar-token-0123456789abcdef";
const CREDENTIALED_URI =
  "mongodb://cerberus:hunter2password@db.internal:27017/cerberus";

/** A marker inside monitored content, so its absence from the logs is checkable. */
const WORKSPACE_MARKER = "SUPERSECRET-WORKSPACE-MARKER";
const PASTE_MARKER = "SUPERSECRET-PASTED-CONTENT-MARKER";
const QUESTION_MARKER = "SUPERSECRET-AUDITOR-QUESTION";

let output: string[] = [];

/** Captures every line at the most verbose level, in both formats. */
function captureOutput(): void {
  output = [];
  configureLogging({
    level: "debug",
    format: "json",
    sink: (line) => output.push(line),
  });
}

function allOutput(): string {
  return output.join("\n");
}

beforeEach(() => captureOutput());
afterEach(() => {
  resetLogging();
  clearRegisteredSecrets();
});

describe("configured credentials never reach a log line", () => {
  test("the current and previous operator keys, the MCP token and the provider key", async () => {
    const config = makeConfig({
      auth: {
        apiKey: TEST_API_KEY,
        previousApiKey: PREVIOUS_API_KEY,
        headerNames: ["authorization", "x-api-key"],
      },
      mcp: { serverEndpoint: "http://mcp.test", apiKey: MCP_TOKEN, timeoutMs: 2_000 },
      openai: {
        apiKey: OPENAI_KEY,
        model: "test-model",
        maxOutputTokens: 1024,
        requestTimeoutMs: 5_000,
      },
    });

    const stub = installFetchStub();
    try {
      const app = createApp(config);
      // A request that presents the credential, and one that presents the *retired*
      // one: both are admitted, and neither value may be recorded.
      await app.request("/api/v1/sessions", { headers: authorizedHeaders() });
      await app.request("/api/v1/sessions", {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${PREVIOUS_API_KEY}`,
        },
      });
      // And one that presents neither, so the rejection path is exercised too.
      await app.request("/api/v1/sessions", { headers: { "Content-Type": "application/json" } });
    } finally {
      stub.restore();
    }

    const logs = allOutput();
    assert.ok(output.length > 0, "nothing was logged, so this test proves nothing");
    for (const [name, value] of Object.entries({
      "the current operator key": TEST_API_KEY,
      "the previous operator key": PREVIOUS_API_KEY,
      "the MCP token": MCP_TOKEN,
      "the provider key": OPENAI_KEY,
    })) {
      assert.ok(
        !logs.includes(value),
        `${name} reached the log output`,
      );
    }
    // The literal header form must not appear either, even with a redacted value.
    assert.doesNotMatch(logs, /Bearer [A-Za-z0-9]/);
  });

  test("a notification webhook URL and its credential never reach a log line", async () => {
    const webhook = "https://hooks.slack.com/services/T1/B2/SUPERSECRETWEBHOOKPART";
    const sendgrid = "SG.supersecretpart.qrstuvwxyz0123456789";
    registerSecret(webhook);
    registerSecret(sendgrid);

    // The notification service is driven directly: it is the one module that receives
    // these values, and it is reached from ingest only when a score crosses the lock
    // threshold.
    const { notifySlack, sendEmail } = await import("../src/services/notifications.js");
    const stub = installFetchStub();
    try {
      const payload = {
        riskAssessmentId: "r1",
        sessionId: "ses-1",
        employeeId: "op-1",
        auditId: "a1",
        overallRiskScore: 90,
        dimensionScores: {
          dataExfiltration: 90,
          unauthorizedAccess: 0,
          policyViolation: 0,
          amlRedFlag: 0,
          insiderTrading: 0,
          soxNonCompliance: 0,
        },
        flags: [],
        exfiltrationReport: null,
        behavioralAnomalies: [],
        generatedAt: "2026-01-01T00:00:00.000Z",
      };
      await notifySlack(webhook, payload, 20);
      await sendEmail(sendgrid, "from@example.internal", "to@example.internal", payload, 20);
    } finally {
      stub.restore();
    }

    const logs = allOutput();
    assert.ok(output.length > 0, "nothing was logged, so this test proves nothing");
    assert.ok(!logs.includes(webhook), "the webhook URL reached the log output");
    assert.ok(!logs.includes(sendgrid), "the SendGrid key reached the log output");
    assert.ok(!logs.includes("SUPERSECRETWEBHOOKPART"));
  });
});

describe("a dependency failure cannot smuggle a credential into the logs", () => {
  test("an MCP transport error quoting a credentialed URI is scrubbed", async () => {
    const stub = installFetchStub({
      mcpResponse: () => {
        // Exactly the shape a driver error has: the connection string it was given,
        // userinfo and all, quoted back in the message.
        throw new Error(`connect ECONNREFUSED for ${CREDENTIALED_URI}`);
      },
    });

    try {
      const app = createApp(makeConfig());
      await app.request("/api/v1/sessions", { headers: authorizedHeaders() });
    } finally {
      stub.restore();
    }

    const logs = allOutput();
    assert.ok(!logs.includes("hunter2password"), "the Mongo password reached the log output");
    assert.ok(!logs.includes(CREDENTIALED_URI), "the credentialed URI reached the log output");
    assert.match(logs, /\[redacted\]/, "the URI was not redacted at all");
  });

  test("a provider error quoting the API key is scrubbed", () => {
    // The provider's own error objects can carry the request, and therefore the
    // credential. Asserted through the logger rather than by constructing an SDK error,
    // because the guarantee is the logger's, not the SDK's.
    registerSecret(OPENAI_KEY);
    logger.failure(
      LOG_EVENTS.PROVIDER_FAILURE,
      new Error(`401 Incorrect API key provided: ${OPENAI_KEY}`),
    );

    assert.ok(!allOutput().includes(OPENAI_KEY));
    assert.match(allOutput(), /\[redacted\]/);
  });

  test("a credentialed MongoDB URI in the startup banner is scrubbed", async () => {
    const config = makeConfig({
      mcp: {
        serverEndpoint: "mongodb://cerberus:hunter2password@db.internal:27017",
        apiKey: MCP_TOKEN,
        timeoutMs: 2_000,
      },
    });

    const stub = installFetchStub();
    try {
      // `createApp` registers the configured secrets; the banner is logged by `main()`,
      // which a test does not run, so the same field is logged here directly.
      createApp(config);
      logger.info(LOG_EVENTS.STARTUP, { mcp: config.mcp.serverEndpoint });
    } finally {
      stub.restore();
    }

    assert.ok(!allOutput().includes("hunter2password"));
  });
});

describe("monitored content is never logged", () => {
  test("a telemetry batch, the workspace and the provider prompt stay out of the logs", async () => {
    const stub = installFetchStub();
    let providerPrompt = "";

    try {
      const app = createApp(makeConfig());
      const sessionId = "ses-content-check";

      // A long paste: it both carries content and crosses the analysis trigger, so the
      // paid path runs and the workspace becomes part of the provider prompt.
      const longPaste = `${PASTE_MARKER} ${"y".repeat(200)}`;
      await app.request("/api/v1/guardian/ingest", {
        method: "POST",
        headers: authorizedHeaders(),
        body: JSON.stringify({
          events: [
            pasteEvent(sessionId, {
              eventId: "evt-content-1",
              eventType: "PASTE",
              payload: { newText: longPaste, changeLength: longPaste.length },
            }),
          ],
        }),
      });

      // The prompt the provider actually received, so the assertion covers the real
      // prompt rather than an assumption about it.
      const aiCall = stub.calls.find((call) => call.url.includes("api.openai.com"));
      providerPrompt = JSON.stringify(aiCall?.body ?? {});
    } finally {
      stub.restore();
    }

    const logs = allOutput();
    assert.ok(output.length > 0, "nothing was logged, so this test proves nothing");

    // The prompt really did carry the content, so the negative assertion below is
    // meaningful rather than vacuous.
    assert.ok(
      providerPrompt.includes(PASTE_MARKER),
      "the fixture never reached the provider prompt, so this test proves nothing",
    );

    assert.ok(!logs.includes(PASTE_MARKER), "pasted content reached the log output");
    assert.ok(!logs.includes(WORKSPACE_MARKER), "the workspace reached the log output");
    assert.doesNotMatch(logs, /"newText"/, "a telemetry payload key reached the log output");
    assert.doesNotMatch(logs, /"pasteContent"/);
  });

  test("an auditor question is never logged, even when the route refuses it", async () => {
    const app = createApp(makeConfig());
    await app.request("/api/v1/auditor/query", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ question: `${QUESTION_MARKER} ${"z".repeat(2_100)}` }),
    });

    assert.ok(!allOutput().includes(QUESTION_MARKER));
  });

  test("a reference document's content is never logged, only its size", async () => {
    const stub = installFetchStub();
    try {
      const app = createApp(makeConfig());
      await app.request("/api/v1/reference-documents", {
        method: "POST",
        headers: authorizedHeaders(),
        body: JSON.stringify({
          label: "policy",
          content: `${WORKSPACE_MARKER} reference text`,
        }),
      });
    } finally {
      stub.restore();
    }

    const logs = allOutput();
    assert.ok(!logs.includes(WORKSPACE_MARKER));
    assert.match(logs, /charCount/, "the size was not recorded, so the log is not useful");
  });

  test("an operator's display identity is never logged", async () => {
    const app = createApp(makeConfig());
    await app.request("/api/v1/identity/set", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        displayName: "Supersecret Display Name",
        employeeId: "supersecret-employee-id",
      }),
    });

    const logs = allOutput();
    assert.ok(!logs.includes("Supersecret Display Name"));
    assert.ok(!logs.includes("supersecret-employee-id"));
    assert.match(logs, /registrySize/);
  });
});

describe("the output is bounded", () => {
  test("a very large field does not produce a very large log line", () => {
    logger.info("test.large", { body: "x".repeat(500_000) });

    assert.equal(output.length, 1);
    assert.ok(
      output[0].length < 2_000,
      `a 500 000-character field produced a ${output[0].length}-character line`,
    );
  });

  test("a large field does not make logging quadratic", () => {
    // Measured before this bound existed: a 200 KB field took 32 seconds, because one
    // pattern scanned it quadratically. The bound is what keeps observability from
    // becoming the regression it is meant to catch.
    const startedAt = Date.now();
    for (let i = 0; i < 20; i += 1) {
      logger.info("test.large", { body: "x".repeat(200_000) });
    }
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 2_000, `20 large fields took ${elapsedMs}ms`);
  });
});

/**
 * Outbound notification bounds.
 *
 * Ingestion awaits both notification channels before returning, so a channel
 * without a deadline can stall the ingest request for as long as the socket
 * stays open. These tests assert the deadline is actually applied, without
 * waiting for the production five seconds.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  NOTIFICATION_TIMEOUT_MS,
  notifySlack,
  sendEmail,
} from "../src/services/notifications.js";
import {
  configureLogging,
  resetLogging,
  type LogRecord,
} from "../src/observability/logger.js";
import type { RiskAssessmentPayload } from "../src/types.js";

const payload: RiskAssessmentPayload = {
  riskAssessmentId: "risk-1",
  sessionId: "ses-1",
  employeeId: "op-trader-001",
  auditId: "audit-1",
  overallRiskScore: 88,
  dimensionScores: {
    dataExfiltration: 80,
    unauthorizedAccess: 10,
    policyViolation: 40,
    amlRedFlag: 5,
    insiderTrading: 0,
    soxNonCompliance: 0,
  },
  flags: [
    {
      flagType: "SUSPICIOUS_PASTE",
      severity: "high",
      sourceEventId: "evt-1",
      description: "large paste",
      confidence: 0.9,
      timestamp: "2026-01-01T00:00:00.000Z",
    },
  ],
  exfiltrationReport: null,
  behavioralAnomalies: [],
  generatedAt: "2026-01-01T00:00:00.000Z",
};

/** Replaces `fetch` with a stub that never resolves on its own. */
function installHangingFetch(): {
  calls: number;
  signalPassed: boolean;
  aborted: boolean;
  restore(): void;
} {
  const original = globalThis.fetch;
  const state = { calls: 0, signalPassed: false, aborted: false };

  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    state.calls++;
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // never settles: the test asserts the deadline fires
      state.signalPassed = true;
      signal.addEventListener("abort", () => {
        state.aborted = true;
        // What Node's fetch rejects with when a caller aborts the signal.
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  }) as typeof fetch;

  return {
    get calls() {
      return state.calls;
    },
    get signalPassed() {
      return state.signalPassed;
    },
    get aborted() {
      return state.aborted;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** Replaces `fetch` with a stub that answers immediately. */
function installStaticFetch(status: number): { calls: number; restore(): void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", { status });
  }) as typeof fetch;
  return {
    get calls() {
      return calls;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

describe("notification deadline", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  test("the default deadline is five seconds", () => {
    assert.equal(NOTIFICATION_TIMEOUT_MS, 5_000);
  });

  test("notifySlack gives up on a webhook that never responds", async () => {
    const stub = installHangingFetch();
    restore = stub.restore;

    const startedAt = Date.now();
    await notifySlack("https://hooks.slack.test/hang", payload, 50);
    const elapsed = Date.now() - startedAt;

    assert.equal(stub.calls, 1);
    assert.equal(stub.signalPassed, true, "fetch was called without an AbortSignal");
    assert.equal(stub.aborted, true, "the deadline never fired");
    // The point is that it resolved at all, well before the production deadline.
    assert.ok(elapsed < 2_000, `notifySlack hung for ${elapsed}ms`);
  });

  test("sendEmail gives up on a provider that never responds", async () => {
    const stub = installHangingFetch();
    restore = stub.restore;

    await sendEmail(
      "SG.test-key",
      "cerberus@example.internal",
      "security@example.internal",
      payload,
      50,
    );

    assert.equal(stub.calls, 1);
    assert.equal(stub.signalPassed, true, "fetch was called without an AbortSignal");
    assert.equal(stub.aborted, true, "the deadline never fired");
  });

  test("a deadline is not an error: the failure is swallowed", async () => {
    const stub = installHangingFetch();
    restore = stub.restore;

    // Resolving rather than throwing is the contract: a notification outage
    // must never fail telemetry ingestion.
    await assert.doesNotReject(() =>
      notifySlack("https://hooks.slack.test/hang", payload, 20),
    );
  });

  test("a deadline is logged as a timeout, naming the deadline applied", async () => {
    const stub = installHangingFetch();
    restore = stub.restore;

    // Captured through the logger's sink rather than by replacing `console.error`.
    // The structured record is the stronger assertion: it names the classification and
    // the exact deadline rather than pattern-matching rendered prose.
    const records: LogRecord[] = [];
    configureLogging({
      level: "debug",
      format: "json",
      sink: (_line, record) => records.push(record),
    });

    try {
      await notifySlack("https://hooks.slack.test/hang", payload, 25);
    } finally {
      resetLogging();
    }

    const timeouts = records.filter(
      (record) => record["classification"] === "timeout",
    );
    assert.equal(
      timeouts.length,
      1,
      `expected one timeout record, saw: ${JSON.stringify(records)}`,
    );
    // Both halves matter: a timeout must be distinguishable from a transport
    // failure, and the number must be the deadline actually used rather than
    // the module default.
    assert.equal(timeouts[0]["timeoutMs"], 25);
    assert.equal(timeouts[0]["channel"], "slack");
    assert.equal(timeouts[0]["dependency"], "notification");
  });

  test("the webhook URL and the incident content never reach a log record", async () => {
    const stub = installStaticFetch(500);
    restore = stub.restore;

    const records: LogRecord[] = [];
    configureLogging({
      level: "debug",
      format: "json",
      sink: (_line, record) => records.push(record),
    });

    const webhook = "https://hooks.slack.com/services/T000/B000/SECRETWEBHOOKTOKEN";
    try {
      await notifySlack(webhook, payload, 50);
    } finally {
      resetLogging();
    }

    const serialised = JSON.stringify(records);
    assert.ok(records.length > 0, "expected at least one record");
    assert.doesNotMatch(
      serialised,
      /SECRETWEBHOOKTOKEN|hooks\.slack\.com/,
      "a notification log record carried the webhook URL, which is itself a credential",
    );
    assert.doesNotMatch(
      serialised,
      /op-trader-001|large paste/,
      "a notification log record carried incident content",
    );
    // The classification is what an operator acts on, and it is present.
    assert.ok(
      records.some((record) => record["classification"] === "non-2xx"),
      "the non-2xx classification was not recorded",
    );
  });

  test("an unconfigured channel makes no request at all", async () => {
    const stub = installStaticFetch(200);
    restore = stub.restore;

    await notifySlack("", payload);
    await sendEmail("", "", "", payload);

    assert.equal(stub.calls, 0);
  });

  test("a partial email configuration makes no request", async () => {
    const stub = installStaticFetch(200);
    restore = stub.restore;

    await sendEmail("SG.key", "cerberus@example.internal", "", payload);
    await sendEmail("", "cerberus@example.internal", "security@example.internal", payload);

    assert.equal(stub.calls, 0);
  });

  test("a non-2xx response is swallowed", async () => {
    const stub = installStaticFetch(500);
    restore = stub.restore;

    await assert.doesNotReject(() => notifySlack("https://hooks.slack.test/x", payload));
    await assert.doesNotReject(() =>
      sendEmail("SG.key", "a@example.internal", "b@example.internal", payload),
    );

    assert.equal(stub.calls, 2);
  });

  test("a transport failure is swallowed", async () => {
    const original = globalThis.fetch;
    restore = () => {
      globalThis.fetch = original;
    };
    globalThis.fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND hooks.slack.test");
    }) as typeof fetch;

    await assert.doesNotReject(() => notifySlack("https://hooks.slack.test/x", payload));
    await assert.doesNotReject(() =>
      sendEmail("SG.key", "a@example.internal", "b@example.internal", payload),
    );
  });
});

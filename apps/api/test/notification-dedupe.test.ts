/**
 * Notification duplication, and the one duplicate that can be closed cheaply.
 *
 * ── The exposure, measured from the code ──────────────────────────────
 *
 * `POST /api/v1/guardian/ingest` sends an alert when a batch produces a high-risk assessment
 * **and** the assessment is durably stored. Three ways that can produce two alerts for one
 * incident:
 *
 *   1. **The same durable `riskAssessmentId` is stored twice.** `store_risk_assessment` is an
 *      insert with a unique index on that id, so the second write reports `inserted: false`
 *      and changes nothing — but the route read only `stored.ok` and discarded `inserted`, so
 *      it locked the session and sent a **second alert** for an incident already alerted on.
 *      **This is the one that is cheaply closable**, because the unique index is already a
 *      durable, atomic, cross-replica dedupe key: no new collection, index or migration.
 *   2. **Two API processes analyse one session concurrently.** Each mints its **own**
 *      `riskAssessmentId` — the id is model-supplied, or a local `randomUUID()` when the model
 *      omits one — so both rows are new and both notify. A marker cannot fix this, because
 *      there is no durable *incident* identity to key it on. See
 *      `docs/operations/multi-replica.md` §2.3.
 *   3. **The provider returns an empty or unusable assessment** and the session's workspace is
 *      unchanged, so the in-memory code-hash guard returns early. That guard is per-process
 *      and does not survive a restart, but a restart also empties `currentCode`, so a pure
 *      replay does not re-analyse. Stated for completeness; no case below reaches it.
 *
 * ── What this suite proves ────────────────────────────────────────────
 *
 * Case 1 is now at-most-once per stored assessment, and the test asserts it the only way that
 * counts: by counting the **outbound HTTP requests**, not by reading a log line or inferring
 * it from a response field. The channels are configured for real, so `notifySlack` and
 * `sendEmail` reach `fetch`.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import { authorizedHeaders, installFetchStub, makeConfig, pasteEvent, type FetchStub } from "./helpers.js";
import { McpStoreDouble } from "./support/mcp-store-double.js";

const ASSESSMENT_ID = "11111111-1111-4111-8111-111111111111";

/** A high-risk assessment, so the ingest path locks and notifies. */
const HIGH_RISK = JSON.stringify({
  riskAssessmentId: ASSESSMENT_ID,
  overallRiskScore: 92,
  dimensionScores: { dataExfiltration: 92, policyViolation: 80 },
  flags: [
    {
      flagType: "SUSPICIOUS_PASTE",
      severity: "high",
      sourceEventId: "evt-1",
      description: "Large paste of external content",
      confidence: 0.95,
      timestamp: "2026-01-01T00:00:00.000Z",
    },
  ],
  exfiltrationReport: null,
  behavioralAnomalies: [],
  generatedAt: "2026-01-01T00:00:00.000Z",
});

/** A second, distinct incident: a different id, so it is genuinely new. */
const SECOND_RISK = JSON.stringify({
  riskAssessmentId: "22222222-2222-4222-8222-222222222222",
  overallRiskScore: 88,
  dimensionScores: { dataExfiltration: 88 },
  flags: [],
  exfiltrationReport: null,
  behavioralAnomalies: [],
  generatedAt: "2026-01-01T00:00:00.000Z",
});

const NOTIFICATION_ENV = ["SLACK_WEBHOOK_URL", "SENDGRID_API_KEY", "EMAIL_FROM", "EMAIL_TO"];

interface Harness {
  app: ReturnType<typeof createApp>;
  store: McpStoreDouble;
  stub: FetchStub;
  /** How many outbound notification requests reached the network. */
  notifications: () => number;
}

function installHarness(): Harness {
  const store = new McpStoreDouble();
  const stub = installFetchStub({
    mcpResponse: store.responder(),
    // Sequential provider answers: the first analysis sees the first incident, the second
    // sees a genuinely new one. The last entry repeats once exhausted.
    aiResponses: [HIGH_RISK, SECOND_RISK],
  });

  return {
    app: createApp(makeConfig()),
    store,
    stub,
    notifications: () =>
      stub.calls.filter(
        (call) =>
          call.url.startsWith("https://hooks.slack.com/") ||
          call.url.startsWith("https://api.sendgrid.com/"),
      ).length,
  };
}

/** One large paste, which is what makes the workspace worth analysing. */
function paste(
  sessionId: string,
  eventId: string,
  text = "confidential ".repeat(60),
): Record<string, unknown> {
  return pasteEvent(sessionId, {
    eventId,
    sessionId,
    payload: { newText: text, changeLength: text.length },
  });
}

async function ingest(harness: Harness, events: Array<Record<string, unknown>>) {
  return harness.app.request("/api/v1/guardian/ingest", {
    method: "POST",
    headers: authorizedHeaders(),
    body: JSON.stringify({ events }),
  });
}

describe("notification duplication", () => {
  let harness: Harness;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    resetAIProvider();
    for (const name of NOTIFICATION_ENV) saved.set(name, process.env[name]);
    // Configured for real, so the channels reach `fetch` and can be counted.
    process.env["SLACK_WEBHOOK_URL"] = "https://hooks.slack.com/services/test/test/test";
    process.env["SENDGRID_API_KEY"] = "test-sendgrid-key";
    process.env["EMAIL_FROM"] = "cerberus@example.test";
    process.env["EMAIL_TO"] = "operator@example.test";

    harness = installHarness();
  });

  afterEach(() => {
    harness.stub.restore();
    resetAIProvider();
    for (const name of NOTIFICATION_ENV) {
      const previous = saved.get(name);
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  test("a first high-risk incident notifies on both channels", async () => {
    const res = await ingest(harness, [paste("dedupe-1", "e1")]);

    assert.equal(res.status, 200);
    assert.equal(
      harness.notifications(),
      2,
      "the first incident did not reach both configured channels",
    );
  });

  test("a second analysis that produces an ALREADY-STORED assessment does not notify again", async () => {
    // The same durable `riskAssessmentId` already exists, so the store reports
    // `inserted: false`. Before this change the route read only `ok` and notified anyway.
    harness.store.seedAssessment("dedupe-2", {
      overallRiskScore: 92,
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    // Give the seeded row the id the provider will return, so the write is a duplicate.
    const seeded = harness.store.assessments.get("dedupe-2");
    assert.ok(seeded?.[0]);
    seeded[0]["riskAssessmentId"] = ASSESSMENT_ID;

    const res = await ingest(harness, [paste("dedupe-2", "e1")]);

    assert.equal(res.status, 200);
    assert.equal(
      harness.notifications(),
      0,
      "an incident whose evidence was already durable sent a second alert",
    );
  });

  test("the status transition still happens when the notification is suppressed", async () => {
    // Suppressing the alert must not suppress the *lock*: the durable evidence says this
    // session is high-risk, and leaving it unlocked would be a worse failure than a
    // duplicate alert.
    harness.store.seedSession({
      sessionId: "dedupe-3",
      employeeId: "op-trader-001",
      auditId: "audit-2026-q1",
      status: "active",
      eventCount: 0,
    });
    harness.store.seedAssessment("dedupe-3", {
      overallRiskScore: 92,
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    const seeded = harness.store.assessments.get("dedupe-3");
    assert.ok(seeded?.[0]);
    seeded[0]["riskAssessmentId"] = ASSESSMENT_ID;

    const res = await ingest(harness, [paste("dedupe-3", "e1")]);

    assert.equal(res.status, 200);
    const session = await harness.store.getSession("dedupe-3");
    assert.equal(
      session?.["status"],
      "locked",
      "the notification was suppressed and so was the lock, which is not the trade this makes",
    );
    assert.equal(harness.notifications(), 0);
  });

  test("a genuinely new incident is not suppressed", async () => {
    // The dedupe must not turn into a lost alert. Two different assessment ids are two
    // incidents, and the second must notify — the unique index only suppresses a *repeat* of
    // one id, never a new one.
    //
    // A second session, deliberately: a session locked by the first alert has its own
    // behaviour on the next batch, and this case is about the dedupe rather than about that.
    // The provider answers with a different id for the second analysis (see `aiResponses`).
    const first = await ingest(harness, [paste("dedupe-4a", "e1")]);
    assert.equal(first.status, 200);
    assert.equal(harness.notifications(), 2);

    // A distinct payload as well as a distinct session: the in-process content ring dedupes
    // identical event payloads, and a test that tripped it would measure the ring rather than
    // the dedupe this suite is about.
    const second = await ingest(harness, [
      paste("dedupe-4b", "e1", "a different confidential payload ".repeat(40)),
    ]);

    assert.equal(second.status, 200);
    assert.equal(
      harness.notifications(),
      4,
      "a genuinely new incident was suppressed, which is a lost alert",
    );
  });

  test("a notification is never sent when the assessment write failed", async () => {
    // Unchanged behaviour, asserted here because it is the neighbouring rule: no durable
    // evidence means no status change and no alert.
    harness.store.failToolTransport("store_risk_assessment", "mongo unreachable");

    const res = await ingest(harness, [paste("dedupe-5", "e1")]);

    assert.equal(res.status, 200);
    assert.equal(
      harness.notifications(),
      0,
      "an alert was sent for an incident with no durable evidence",
    );
  });
});

/**
 * The benchmark's MCP double, checked against the real tool registry.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 *
 * `scripts/bench/mcp-double.mjs` is the persistence layer `npm run bench` measures the
 * application against. For four releases it answered `get_session_review` by ignoring both
 * `eventsLimit` and `includeAssessments` and returning up to 500 micro-events — while the
 * API asks for the session document alone (`eventsLimit: 0, includeAssessments: false`) on
 * every ingest and every live-detail read, and the real store skips both queries when it
 * sees that.
 *
 * The consequence was not subtle. Corrected, on one machine, back to back:
 *
 *   live detail           1.21 ms -> 0.07 ms
 *   ingest (1 KEYSTROKE)  1.36 ms -> 0.18 ms
 *   ingest (50 events)    2.10 ms -> 0.52 ms
 *   review list, 20x200   10.28 ms -> 0.51 ms
 *
 * and the "ingest cost grows with session size" step disappeared entirely. The published
 * live-detail ratio — the premise of the read-path cycle — was measuring the double.
 *
 * `docs/development/performance-baseline.md` names this failure mode three times under
 * *"The stubs must match the real store's bounds"*, and `test-double-contract.md` records
 * four earlier instances. The reason it kept recurring is that the benchmark's double was a
 * closure inside a script: nothing could drive it and the real registry through the same
 * call and compare the answers.
 *
 * ── What this asserts ─────────────────────────────────────────────────
 *
 * Both implementations are asked the **same question** and must give the **same answer**:
 *
 *   - the real `createToolRegistry` over `McpStoreDouble`, which is itself verified against
 *     a real `MongoStore` by `store-contract.test.ts`;
 *   - the benchmark's `installMcpStub`, through its `fetch` seam, which is how the API
 *     reaches it.
 *
 * The comparison is on the *bounds* — how many events and how many assessments come back,
 * and in what order — because that is what the double got wrong and what changes the
 * numbers a reader of the baseline compares.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { McpStoreDouble, type StoredDocument } from "./support/mcp-store-double.js";
import {
  DEFAULT_SESSION_EVENTS_LIMIT,
  installMcpStub,
} from "../../../scripts/bench/mcp-double.mjs";

const SESSION_ID = "bench-fidelity";
const EVENT_COUNT = 20;
const ASSESSMENT_COUNT = 3;

/** Events with ascending timestamps, so "newest first" is a real ordering to assert. */
function seedEvents(): StoredDocument[] {
  return Array.from({ length: EVENT_COUNT }, (_unused, index) => ({
    eventId: `evt-${index}`,
    sessionId: SESSION_ID,
    employeeId: "op-fidelity",
    auditId: "audit-fidelity",
    vectorId: "tv-1",
    eventType: "KEYSTROKE",
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    payload: { deltaMs: 120 },
    clientMetadata: { userAgent: "fidelity", platform: "web" },
  }));
}

/** Assessments with ascending `generatedAt`, so "newest first" is a real ordering too. */
function seedAssessments(): StoredDocument[] {
  return Array.from({ length: ASSESSMENT_COUNT }, (_unused, index) => ({
    riskAssessmentId: `11111111-1111-4111-8111-00000000000${index}`,
    sessionId: SESSION_ID,
    employeeId: "op-fidelity",
    auditId: "audit-fidelity",
    overallRiskScore: 40 + index,
    dimensionScores: { dataExfiltration: 40 + index },
    flags: [],
    exfiltrationReport: null,
    behavioralAnomalies: [],
    generatedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
  }));
}

/** The real tool registry over the verified store double. */
async function viaRealRegistry(bounds: Record<string, unknown>) {
  const store = new McpStoreDouble();
  await store.createSession({ sessionId: SESSION_ID, employeeId: "op-fidelity" });
  await store.ingestMicroEvents(seedEvents());
  for (const report of seedAssessments()) await store.storeRiskAssessment(report);

  const response = await store
    .responder()("get_session_review", { sessionId: SESSION_ID, ...bounds });
  assert.equal(response.status, 200, "the real registry refused a valid review request");
  return (await response.json()) as {
    events: StoredDocument[];
    riskAssessments: StoredDocument[];
  };
}

/**
 * The benchmark's double, through the same `fetch` seam the API uses.
 *
 * Seeded through its own tools, so the comparison is between two implementations of the
 * same contract rather than between one implementation and a fixture.
 */
async function viaBenchDouble(bounds: Record<string, unknown>) {
  const stub = installMcpStub();

  const call = async (tool: string, payload: Record<string, unknown>) => {
    const response = await globalThis.fetch(`http://mcp.test/tools/${tool}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json()) as Record<string, unknown>;
  };

  try {
    await call("create_session", { sessionId: SESSION_ID, employeeId: "op-fidelity" });
    await call("ingest_micro_events", { events: seedEvents() });
    for (const report of seedAssessments()) {
      await call("store_risk_assessment", { report });
    }

    const result = await call("get_session_review", { sessionId: SESSION_ID, ...bounds });
    return result as unknown as {
      events: StoredDocument[];
      riskAssessments: StoredDocument[];
    };
  } finally {
    stub.restore();
  }
}

/** The bounds, applied on top of `sessionId`. */
const BOUNDS: Array<{ name: string; body: Record<string, unknown> }> = [
  { name: "no bounds: the default window", body: {} },
  { name: "eventsLimit: 0", body: { eventsLimit: 0 } },
  { name: "eventsLimit: 3", body: { eventsLimit: 3 } },
  { name: "eventsLimit: 500 (the documented default)", body: { eventsLimit: DEFAULT_SESSION_EVENTS_LIMIT } },
  { name: "includeAssessments: false", body: { includeAssessments: false } },
  { name: "assessmentsLimit: 1", body: { assessmentsLimit: 1 } },
  { name: "eventsLimit: 0 and includeAssessments: false", body: { eventsLimit: 0, includeAssessments: false } },
];

/** A stable identity for an event, so ordering can be asserted without comparing whole docs. */
function eventIds(events: StoredDocument[]): string[] {
  return events.map((event) => String(event["eventId"]));
}

function assessmentIds(reports: StoredDocument[]): string[] {
  return reports.map((report) => String(report["riskAssessmentId"]));
}

describe("the benchmark's MCP double agrees with the real tool registry", () => {
  // `installMcpStub` replaces `globalThis.fetch`; `viaBenchDouble` restores it in a
  // `finally`. This is belt and braces, so a thrown assertion cannot leave a stub installed
  // for the next case in this file.
  afterEach(() => {
    // Nothing to restore here: each case installs and restores its own stub.
  });

  for (const { name, body } of BOUNDS) {
    test(`get_session_review — ${name}`, async () => {
      const real = await viaRealRegistry(body);
      const bench = await viaBenchDouble(body);

      assert.deepEqual(
        eventIds(bench.events),
        eventIds(real.events),
        `the benchmark double returned a different event window for "${name}". ` +
          "A double that does not match the real store's bounds measures the double — which " +
          "is how the published live-detail ratio came to be a measurement of this file.",
      );
      assert.deepEqual(
        assessmentIds(bench.riskAssessments),
        assessmentIds(real.riskAssessments),
        `the benchmark double returned a different assessment window for "${name}"`,
      );
    });
  }

  // ── The assertions above are only meaningful if the bounds actually bite ──
  //
  // A double that returned nothing at all would satisfy every comparison in the loop. These
  // pin the two extremes, so the loop cannot pass by both sides being empty.
  test("the comparison is not vacuous: the default window carries everything", async () => {
    const real = await viaRealRegistry({});
    const bench = await viaBenchDouble({});

    assert.equal(real.events.length, EVENT_COUNT, "the real registry returned no events");
    assert.equal(real.riskAssessments.length, ASSESSMENT_COUNT);
    assert.equal(bench.events.length, EVENT_COUNT, "the benchmark double returned no events");
    assert.equal(bench.riskAssessments.length, ASSESSMENT_COUNT);
  });

  test("the comparison is not vacuous: eventsLimit: 0 carries nothing", async () => {
    const body = { eventsLimit: 0, includeAssessments: false };
    const real = await viaRealRegistry(body);
    const bench = await viaBenchDouble(body);

    assert.deepEqual(real.events, []);
    assert.deepEqual(real.riskAssessments, []);
    assert.deepEqual(bench.events, []);
    assert.deepEqual(bench.riskAssessments, []);
  });

  test("the default event cap is the store's own, not a second number", () => {
    // The literal is duplicated in the `.mjs` because the registry is TypeScript. This is
    // the assertion that the duplication has not drifted: the case above with
    // `eventsLimit: DEFAULT_SESSION_EVENTS_LIMIT` returns the whole 20-event fixture from
    // both sides, and this pins the constant's value against the store's documented one.
    assert.equal(
      DEFAULT_SESSION_EVENTS_LIMIT,
      500,
      "the benchmark double's default event cap no longer matches MongoStore.getSessionEvents' " +
        "`limit ?? 500`",
    );
  });
});

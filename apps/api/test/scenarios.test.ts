/**
 * Threat scenario authoring tests.
 *
 * Covers the deterministic content pre-filter, severity-mix normalisation,
 * the fail-closed classifier gate, and the persistence call using the renamed
 * MCP tool.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/index.js";
import { resetAIProvider } from "../src/ai/provider.js";
import {
  evaluateVerdict,
  normalizeSeverityMix,
  runPreFilter,
} from "../src/routes/scenarios.js";
import { applySafePipeline } from "../src/routes/auditor.js";
import {
  authorizedHeaders,
  installFetchStub,
  makeConfig,
  type FetchStub,
} from "./helpers.js";

describe("runPreFilter", () => {
  test("rejects empty input", () => {
    const result = runPreFilter("   ");
    assert.equal(result.passed, false);
    assert.deepEqual(result.flags, ["EMPTY_INPUT"]);
  });

  test("rejects a bare greeting", () => {
    const result = runPreFilter("hello");
    assert.equal(result.passed, false);
    assert.deepEqual(result.flags, ["GREETING_ONLY"]);
  });

  test("rejects a two-character fragment", () => {
    const result = runPreFilter("ab");
    assert.equal(result.passed, false);
    assert.ok(result.flags.includes("GIBBERISH"));
  });

  test("rejects keyboard mashing", () => {
    const result = runPreFilter("aaaaaaaaaaaaaaaaaaaa");
    assert.equal(result.passed, false);
    assert.ok(result.flags.includes("GIBBERISH"));
  });

  test("rejects profanity", () => {
    const result = runPreFilter("this is fucking nonsense for the ledger");
    assert.equal(result.passed, false);
    assert.ok(result.flags.includes("PROFANITY"));
  });

  test("accepts a substantive scenario request", () => {
    const result = runPreFilter(
      "Author threat scenarios covering SWIFT gateway token injection and AML red flags",
    );
    assert.equal(result.passed, true);
    assert.deepEqual(result.flags, []);
  });
});

describe("normalizeSeverityMix", () => {
  test("returns defaults for a missing mix", () => {
    const mix = normalizeSeverityMix(undefined);
    const total = mix.low + mix.medium + mix.high + mix.critical;
    assert.ok(Math.abs(total - 1) < 1e-9);
  });

  test("normalises weights that do not sum to one", () => {
    const mix = normalizeSeverityMix({ low: 2, medium: 2, high: 0, critical: 0 });
    assert.equal(mix.low, 0.5);
    assert.equal(mix.medium, 0.5);
    assert.equal(mix.high, 0);
  });

  test("falls back to defaults when every weight is zero", () => {
    const mix = normalizeSeverityMix({ low: 0, medium: 0, high: 0, critical: 0 });
    assert.ok(mix.medium > 0);
  });

  test("ignores negative and non-numeric weights", () => {
    const mix = normalizeSeverityMix({ low: -5, medium: "high", high: 1, critical: 1 });
    assert.equal(mix.low, 0);
    assert.equal(mix.medium, 0);
    assert.equal(mix.high, 0.5);
  });

  test("rejects an Assessment-era difficulty mix shape", () => {
    // beginner/intermediate/advanced are not severity weights and must be ignored.
    const mix = normalizeSeverityMix({ beginner: 0.5, intermediate: 0.3, advanced: 0.2 });
    assert.ok(Math.abs(mix.low + mix.medium + mix.high + mix.critical - 1) < 1e-9);
    assert.notEqual(mix.low, 0.5);
  });

  test("leaves an already-normalised client mix unchanged", () => {
    // The exact shape the console sends for its default slider positions
    // (30% routine / 50% elevated / 20% severe, split 60/40).
    const mix = normalizeSeverityMix({ low: 0.3, medium: 0.5, high: 0.12, critical: 0.08 });
    assert.equal(mix.low, 0.3);
    assert.equal(mix.medium, 0.5);
    assert.equal(mix.high, 0.12);
    assert.equal(mix.critical, 0.08);
  });

  test("is idempotent for a client mix", () => {
    const once = normalizeSeverityMix({ low: 0.3, medium: 0.3, high: 0.3, critical: 0.1 });
    const twice = normalizeSeverityMix(once);
    for (const key of ["low", "medium", "high", "critical"] as const) {
      assert.ok(
        Math.abs(twice[key] - once[key]) < 1e-12,
        `${key} drifted on re-normalisation: ${once[key]} -> ${twice[key]}`,
      );
    }
  });

  test("preserves a high/critical-only mix from the console's severe slider", () => {
    // routine = 0, elevated = 0, severe = 1 -> the console sends 0.6 / 0.4.
    const mix = normalizeSeverityMix({ low: 0, medium: 0, high: 0.6, critical: 0.4 });
    assert.equal(mix.low, 0);
    assert.equal(mix.medium, 0);
    assert.equal(mix.high, 0.6);
    assert.equal(mix.critical, 0.4);
  });

  test("ignores NaN and Infinity weights", () => {
    const mix = normalizeSeverityMix({
      low: Number.NaN,
      medium: Number.POSITIVE_INFINITY,
      high: 1,
      critical: 1,
    });
    assert.equal(mix.low, 0);
    assert.equal(mix.medium, 0);
    assert.equal(mix.high, 0.5);
    assert.equal(mix.critical, 0.5);
  });
});

describe("evaluateVerdict", () => {
  const base = {
    isInputMeaningful: true,
    isScenarioRelated: true,
    isAppropriate: true,
    contentFlags: [] as string[],
    confidence: 0.9,
    detectedDomain: "financial_services",
  };

  test("admits a fully valid verdict", () => {
    assert.equal(evaluateVerdict(base), null);
  });

  test("rejects inappropriate content first", () => {
    const reason = evaluateVerdict({
      ...base,
      isAppropriate: false,
      isScenarioRelated: false,
      contentFlags: ["PROFANITY"],
    });
    assert.match(reason!, /isAppropriate=false/);
  });

  test("rejects meaningless input", () => {
    assert.match(evaluateVerdict({ ...base, isInputMeaningful: false })!, /isInputMeaningful/);
  });

  test("rejects unrelated input", () => {
    assert.match(evaluateVerdict({ ...base, isScenarioRelated: false })!, /isScenarioRelated/);
  });

  test("rejects low confidence", () => {
    assert.match(evaluateVerdict({ ...base, confidence: 0.5 })!, /confidence/);
  });

  test("rejects an empty detected domain", () => {
    assert.match(evaluateVerdict({ ...base, detectedDomain: "" })!, /detectedDomain/);
  });
});

describe("applySafePipeline", () => {
  const records = [
    { sessionId: "a", overallRiskScore: 90 },
    { sessionId: "b", overallRiskScore: 10 },
    { sessionId: "c", overallRiskScore: 50 },
  ];

  test("applies $match", () => {
    const out = applySafePipeline(records, [{ $match: { sessionId: "b" } }]);
    assert.deepEqual(out.map((r) => r.sessionId), ["b"]);
  });

  test("applies numeric comparison operators", () => {
    const out = applySafePipeline(records, [{ $match: { overallRiskScore: { $gt: 40 } } }]);
    assert.deepEqual(out.map((r) => r.sessionId), ["a", "c"]);
  });

  test("applies $sort", () => {
    const out = applySafePipeline(records, [{ $sort: { overallRiskScore: -1 } }]);
    assert.deepEqual(out.map((r) => r.sessionId), ["a", "c", "b"]);
  });

  test("applies $limit", () => {
    const out = applySafePipeline(records, [{ $limit: 2 }]);
    assert.equal(out.length, 2);
  });

  test("ignores unknown stages rather than executing them", () => {
    const out = applySafePipeline(records, [{ $out: "evil_collection" }]);
    assert.equal(out.length, 3);
  });

  test("ignores a non-array pipeline", () => {
    assert.equal(applySafePipeline(records, "drop everything").length, 3);
  });

  test("does not mutate the input records", () => {
    const input = [...records];
    applySafePipeline(input, [{ $sort: { overallRiskScore: 1 } }]);
    assert.equal(input[0].sessionId, "a");
  });
});

describe("POST /api/v1/scenarios", () => {
  let stub: FetchStub;
  let app: ReturnType<typeof createApp>;

  const classifierAccept = JSON.stringify({
    isInputMeaningful: true,
    isScenarioRelated: true,
    isAppropriate: true,
    contentFlags: [],
    reason: "valid",
    confidence: 0.95,
    detectedDomain: "financial_services",
  });

  const matrixResponse = JSON.stringify({
    metadata: { matrixId: "matrix-1", generatedAt: "2026-01-01T00:00:00.000Z" },
    targetSystems: [{ systemId: "ts-1", name: "Core Trading Ledger" }],
    regulatoryMandates: [{ mandateId: "aml-001", name: "AML" }],
    threatVectors: [{ vectorId: "tv-1", title: "Exfil", severity: "high" }],
    penetrationScenarios: [{ scenarioId: "ps-1", vectorId: "tv-1" }],
  });

  beforeEach(() => {
    resetAIProvider();
    app = createApp(makeConfig());
  });

  afterEach(() => {
    stub.restore();
    resetAIProvider();
  });

  test("rejects a greeting before any AI call is made", async () => {
    stub = installFetchStub();

    const res = await app.request("/api/v1/scenarios", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ prompt: "hello", roleContext: "core-trading-ledger" }),
    });

    assert.equal(res.status, 422);
    assert.equal(stub.calls.length, 0, "the AI was called despite a pre-filter rejection");
  });

  test("validates the vector count", async () => {
    stub = installFetchStub();

    const res = await app.request("/api/v1/scenarios", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        prompt: "Author scenarios for the SWIFT gateway",
        roleContext: "swift-gateway",
        vectorCount: 99,
      }),
    });

    assert.equal(res.status, 400);
  });

  test("authors and persists a scenario matrix end to end", async () => {
    stub = installFetchStub({
      mcpResponse: () => ({ success: true, mongoDocumentId: "scenario-doc" }),
      // Call 1 is the classifier gate; call 2 is the matrix author.
      aiResponses: [classifierAccept, matrixResponse],
    });

    const res = await app.request("/api/v1/scenarios", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        prompt: "Author threat scenarios for the SWIFT gateway covering token injection",
        roleContext: "swift-gateway",
        vectorCount: 3,
        severityMix: { low: 1, medium: 1, high: 1, critical: 1 },
      }),
    });

    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      success: boolean;
      matrix: { metadata: { matrixId: string; promptFingerprint: string }; threatVectors: unknown[] };
      persisted: boolean;
    };

    assert.equal(body.success, true);
    assert.equal(body.matrix.metadata.matrixId, "matrix-1");
    assert.equal(body.matrix.threatVectors.length, 1);
    assert.equal(body.matrix.metadata.promptFingerprint.length, 64, "expected a SHA-256 hex digest");
    assert.equal(body.persisted, true);

    assert.ok(
      stub.mcpTools.includes("store_threat_scenario"),
      `expected store_threat_scenario, saw: ${stub.mcpTools.join(", ")}`,
    );
    assert.ok(!stub.mcpTools.includes("store_test_suite"));
  });

  test("forwards the normalised severity mix into the generation prompt", async () => {
    stub = installFetchStub({
      mcpResponse: () => ({ success: true, mongoDocumentId: "scenario-doc" }),
      // Call 1 is the classifier gate; call 2 is the matrix author.
      aiResponses: [classifierAccept, matrixResponse],
    });

    const res = await app.request("/api/v1/scenarios", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        prompt: "Author threat scenarios for the SWIFT gateway covering token injection",
        roleContext: "swift-gateway",
        vectorCount: 3,
        // The exact shape the console sends for 30% routine / 50% elevated /
        // 20% severe, split 60/40 across high and critical.
        severityMix: { low: 0.3, medium: 0.5, high: 0.12, critical: 0.08 },
      }),
    });

    assert.equal(res.status, 201);

    const aiCalls = stub.calls.filter((call) => call.url.includes("api.openai.com"));
    assert.equal(aiCalls.length, 2, "expected a classifier call and a generation call");

    const generation = aiCalls[1].body as {
      messages: Array<{ role: string; content: string }>;
    };
    const system = generation.messages.find((m) => m.role === "system")?.content ?? "";

    // The distribution reaches the model from the structured field, stated once
    // and authoritatively -- not restated as prose in the user prompt.
    assert.match(system, /Severity distribution/);
    assert.match(system, /30% low/);
    assert.match(system, /50% medium/);
    assert.match(system, /12% high/);
    assert.match(system, /8% critical/);
  });

  test("uses the documented default mix when the client sends none", async () => {
    stub = installFetchStub({
      mcpResponse: () => ({ success: true, mongoDocumentId: "scenario-doc" }),
      aiResponses: [classifierAccept, matrixResponse],
    });

    const res = await app.request("/api/v1/scenarios", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        prompt: "Author threat scenarios for the SWIFT gateway covering token injection",
        roleContext: "swift-gateway",
        vectorCount: 3,
      }),
    });

    assert.equal(res.status, 201);

    const aiCalls = stub.calls.filter((call) => call.url.includes("api.openai.com"));
    const generation = aiCalls[1].body as {
      messages: Array<{ role: string; content: string }>;
    };
    const system = generation.messages.find((m) => m.role === "system")?.content ?? "";

    assert.match(system, /25% low/);
    assert.match(system, /35% medium/);
    assert.match(system, /25% high/);
    assert.match(system, /15% critical/);
  });

  test("rejects a request the classifier marks inappropriate", async () => {
    stub = installFetchStub({
      aiResponses: [
        JSON.stringify({
          isInputMeaningful: true,
          isScenarioRelated: true,
          isAppropriate: false,
          contentFlags: ["HATE_SPEECH"],
          reason: "prohibited content",
          confidence: 0.99,
          detectedDomain: "unknown",
        }),
      ],
    });

    const res = await app.request("/api/v1/scenarios", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        prompt: "Author threat scenarios for the SWIFT gateway covering token injection",
        roleContext: "swift-gateway",
      }),
    });

    assert.equal(res.status, 422);
    const body = (await res.json()) as { contentFlags: string[] };
    assert.deepEqual(body.contentFlags, ["HATE_SPEECH"]);
    assert.ok(!stub.mcpTools.includes("store_threat_scenario"));
  });

  test("fails closed when the classifier is unavailable", async () => {
    stub = installFetchStub({ mcpResponse: () => ({ success: true }) });
    stub.restore();
    stub = installFetchStub({ mcpResponse: () => ({ success: true }) });
    globalThis.fetch = (async () => {
      throw new Error("openai unreachable");
    }) as typeof fetch;

    const res = await app.request("/api/v1/scenarios", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({
        prompt: "Author threat scenarios for the SWIFT gateway covering token injection",
        roleContext: "swift-gateway",
      }),
    });

    assert.equal(res.status, 503);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "CLASSIFIER_UNAVAILABLE");
  });
});

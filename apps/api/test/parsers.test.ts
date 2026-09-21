/**
 * AI response parser tests — deterministic fixtures, no network.
 *
 * These pin the defensive behaviour that the provider depends on: markdown
 * fences, trailing commas, prose-wrapped JSON, wrong types and partial
 * payloads must all degrade into a valid Cerberus contract rather than throw.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ANTI_EXFILTRATION_THRESHOLDS,
  extractJsonObject,
  parseJsonLoose,
  parseRecommendedActions,
  parseRiskAssessment,
  parseScenarioClassifierVerdict,
  parseThreatScenarioMatrix,
  repairJson,
  safeArray,
  safeStringArray,
  stripMarkdownFences,
} from "../src/ai/parsers.js";

const GENERATED_AT = "2026-01-01T00:00:00.000Z";

describe("JSON recovery primitives", () => {
  test("strips ```json fences", () => {
    assert.equal(stripMarkdownFences('```json\n{"a":1}\n```'), '{"a":1}');
  });

  test("strips bare ``` fences", () => {
    assert.equal(stripMarkdownFences('```\n{"a":1}\n```'), '{"a":1}');
  });

  test("leaves unfenced text alone", () => {
    assert.equal(stripMarkdownFences('{"a":1}'), '{"a":1}');
  });

  test("repairs trailing commas", () => {
    assert.equal(repairJson('{"a":1,}'), '{"a":1}');
    assert.equal(repairJson('[1,2,]'), '[1,2]');
  });

  test("repairs control characters", () => {
    assert.equal(repairJson('{"a":"b\u0007c"}'), '{"a":"bc"}');
  });

  test("extracts a balanced object from surrounding prose", () => {
    const text = 'Here you go:\n{"a":{"b":1}}\nHope that helps!';
    assert.equal(extractJsonObject(text), '{"a":{"b":1}}');
  });

  test("ignores braces inside string literals", () => {
    const text = '{"note":"use { and } carefully","n":1}';
    assert.equal(extractJsonObject(text), text);
  });

  test("returns an empty string when no brace is present", () => {
    assert.equal(extractJsonObject("no json here"), "");
  });

  test("parseJsonLoose handles fenced and prose-wrapped output", () => {
    assert.deepEqual(parseJsonLoose('```json\n{"ok":true}\n```'), { ok: true });
    assert.deepEqual(parseJsonLoose('Answer: {"ok":true} — done'), { ok: true });
  });

  test("parseJsonLoose throws a descriptive error on unrecoverable input", () => {
    assert.throws(() => parseJsonLoose("not json at all"), /Failed to parse JSON response/);
  });

  test("parseJsonLoose recovers a truncated object body", () => {
    // A stray brace with no closer still yields the outer object attempt.
    assert.throws(() => parseJsonLoose("prefix {"), /Failed to parse JSON response/);
  });
});

describe("coercion helpers", () => {
  test("safeArray only accepts arrays", () => {
    assert.deepEqual(safeArray([{ a: 1 }]), [{ a: 1 }]);
    assert.deepEqual(safeArray("nope"), []);
    assert.deepEqual(safeArray(undefined), []);
  });

  test("safeStringArray filters non-strings", () => {
    assert.deepEqual(safeStringArray(["a", 1, null, "b"]), ["a", "b"]);
    assert.deepEqual(safeStringArray("nope"), []);
  });
});

describe("parseRiskAssessment", () => {
  test("parses a complete payload", () => {
    const payload = parseRiskAssessment(
      JSON.stringify({
        riskAssessmentId: "risk-1",
        sessionId: "ses-1",
        employeeId: "op-1",
        auditId: "audit-1",
        overallRiskScore: 77,
        dimensionScores: { dataExfiltration: 70, policyViolation: 30 },
        flags: [
          {
            flagType: "SUSPICIOUS_PASTE",
            severity: "high",
            sourceEventId: "evt-1",
            description: "large paste",
            confidence: 0.8,
            timestamp: GENERATED_AT,
          },
        ],
        exfiltrationReport: { overallSimilarity: 0.9, matchedSnippets: [], aiCompletionLikelihood: 0.7 },
        behavioralAnomalies: [{ anomalyType: "PASTE_BURST", metricValue: 9, threshold: 5 }],
        generatedAt: GENERATED_AT,
      }),
      GENERATED_AT,
    );

    assert.equal(payload.riskAssessmentId, "risk-1");
    assert.equal(payload.overallRiskScore, 77);
    assert.equal(payload.dimensionScores.dataExfiltration, 70);
    assert.equal(payload.dimensionScores.insiderTrading, 0);
    assert.equal(payload.flags.length, 1);
    assert.equal(payload.flags[0].severity, "high");
    assert.equal(payload.exfiltrationReport?.overallSimilarity, 0.9);
    assert.equal(payload.behavioralAnomalies.length, 1);
  });

  test("fills defaults for a partial payload instead of throwing", () => {
    const payload = parseRiskAssessment("{}", GENERATED_AT);

    assert.equal(payload.overallRiskScore, 0);
    assert.equal(payload.employeeId, "");
    assert.deepEqual(payload.flags, []);
    assert.equal(payload.exfiltrationReport, null);
    assert.equal(payload.generatedAt, GENERATED_AT);
    assert.match(payload.riskAssessmentId, /^[0-9a-f-]{36}$/);
  });

  test("coerces an unknown flag severity to medium", () => {
    const payload = parseRiskAssessment(
      JSON.stringify({ flags: [{ flagType: "X", severity: "apocalyptic" }] }),
      GENERATED_AT,
    );
    assert.equal(payload.flags[0].severity, "medium");
  });

  test("falls back to flagType when description is absent", () => {
    const payload = parseRiskAssessment(
      JSON.stringify({ flags: [{ flagType: "DEV_TOOLS" }] }),
      GENERATED_AT,
    );
    assert.equal(payload.flags[0].description, "DEV_TOOLS");
  });

  test("recovers a fenced payload", () => {
    const payload = parseRiskAssessment(
      '```json\n{"overallRiskScore": 42}\n```',
      GENERATED_AT,
    );
    assert.equal(payload.overallRiskScore, 42);
  });

  test("treats a non-numeric score as zero", () => {
    const payload = parseRiskAssessment(
      JSON.stringify({ overallRiskScore: "high" }),
      GENERATED_AT,
    );
    assert.equal(payload.overallRiskScore, 0);
  });

  test("returns a zeroed payload for completely unparseable text", () => {
    const payload = parseRiskAssessment("the model refused to answer", GENERATED_AT);
    assert.equal(payload.overallRiskScore, 0);
    assert.deepEqual(payload.flags, []);
    assert.equal(payload.exfiltrationReport, null);
    assert.equal(payload.generatedAt, GENERATED_AT);
  });
});

describe("parseThreatScenarioMatrix", () => {
  const fullMatrix = JSON.stringify({
    metadata: { matrixId: "matrix-1", generatedAt: GENERATED_AT, promptFingerprint: "abc" },
    targetSystems: [
      {
        systemId: "ts-1",
        name: "Core Trading Ledger",
        criticalityLevel: "tier-1",
        requiredMandateIds: ["aml-001"],
        description: "ledger",
        examples: ["ledger"],
      },
    ],
    regulatoryMandates: [
      { mandateId: "aml-001", name: "AML", description: "d", weight: 0.4, subMandates: [], regulationCode: "AML" },
    ],
    threatVectors: [
      {
        vectorId: "tv-1",
        vectorType: "data_exfiltration",
        title: "Exfil",
        description: "d",
        targetSystemId: "ts-1",
        workspaceSeed: "seed code",
        severity: "critical",
        mandateId: "aml-001",
        investigationTimeMinutes: 600,
        riskScore: 90,
      },
    ],
    penetrationScenarios: [
      {
        scenarioId: "ps-1",
        vectorId: "tv-1",
        mandateIds: ["aml-001"],
        scoringFormula: { type: "weighted_sum", weights: { "aml-001": 1 } },
        antiExfiltrationThresholds: { maxPasteEvents: 3 },
        description: "d",
      },
    ],
  });

  test("parses a complete matrix", () => {
    const matrix = parseThreatScenarioMatrix(fullMatrix, "test-model", GENERATED_AT);

    assert.equal(matrix.metadata.matrixId, "matrix-1");
    assert.equal(matrix.metadata.modelVersion, "test-model");
    assert.equal(matrix.targetSystems.length, 1);
    assert.equal(matrix.targetSystems[0].criticalityLevel, "tier-1");
    assert.equal(matrix.regulatoryMandates.length, 1);
    assert.equal(matrix.threatVectors.length, 1);
    assert.equal(matrix.threatVectors[0].workspaceSeed, "seed code");
    assert.equal(matrix.penetrationScenarios.length, 1);
  });

  test("merges partial thresholds over the defaults", () => {
    const matrix = parseThreatScenarioMatrix(fullMatrix, "m", GENERATED_AT);
    const thresholds = matrix.penetrationScenarios[0].antiExfiltrationThresholds;

    assert.equal(thresholds.maxPasteEvents, 3);
    assert.equal(
      thresholds.dataLeakageSimilarityThreshold,
      DEFAULT_ANTI_EXFILTRATION_THRESHOLDS.dataLeakageSimilarityThreshold,
    );
  });

  test("accepts snake_case alternates defensively", () => {
    const matrix = parseThreatScenarioMatrix(
      JSON.stringify({
        metadata: { matrixId: "m2" },
        target_systems: [{ systemId: "s", name: "S" }],
        regulatory_mandates: [],
        threat_vectors: [{ vectorId: "v", title: "V" }],
        penetration_scenarios: [],
      }),
      "m",
      GENERATED_AT,
    );

    assert.equal(matrix.targetSystems.length, 1);
    assert.equal(matrix.threatVectors.length, 1);
  });

  test("coerces an unknown vector type and severity", () => {
    const matrix = parseThreatScenarioMatrix(
      JSON.stringify({
        threatVectors: [{ vectorId: "v", vectorType: "nonsense", severity: "extreme" }],
      }),
      "m",
      GENERATED_AT,
    );

    assert.equal(matrix.threatVectors[0].vectorType, "data_exfiltration");
    assert.equal(matrix.threatVectors[0].severity, "medium");
  });

  test("replaces a string subMandates with an empty array", () => {
    const matrix = parseThreatScenarioMatrix(
      JSON.stringify({
        regulatoryMandates: [{ mandateId: "m", name: "M", subMandates: "Req 3.4" }],
      }),
      "m",
      GENERATED_AT,
    );

    assert.deepEqual(matrix.regulatoryMandates[0].subMandates, []);
  });

  test("returns an empty but valid matrix for an empty object", () => {
    const matrix = parseThreatScenarioMatrix("{}", "m", GENERATED_AT);

    assert.deepEqual(matrix.threatVectors, []);
    assert.deepEqual(matrix.targetSystems, []);
    assert.equal(matrix.metadata.modelVersion, "m");
    assert.match(matrix.metadata.matrixId, /^[0-9a-f-]{36}$/);
  });

  test("returns an empty but valid matrix for unparseable text", () => {
    const matrix = parseThreatScenarioMatrix("not json", "m", GENERATED_AT);
    assert.deepEqual(matrix.threatVectors, []);
    assert.equal(matrix.metadata.modelVersion, "m");
  });

  test("derives totalTokens when only the parts are supplied", () => {
    const matrix = parseThreatScenarioMatrix(
      JSON.stringify({ metadata: { promptTokens: 10, completionTokens: 5 } }),
      "m",
      GENERATED_AT,
    );
    assert.equal(matrix.metadata.tokenUsage.totalTokens, 15);
  });
});

describe("parseScenarioClassifierVerdict", () => {
  test("parses a clean verdict", () => {
    const verdict = parseScenarioClassifierVerdict(
      JSON.stringify({
        isInputMeaningful: true,
        isScenarioRelated: true,
        isAppropriate: true,
        contentFlags: [],
        reason: "ok",
        confidence: 0.9,
        detectedDomain: "financial_services",
      }),
    );

    assert.equal(verdict.isScenarioRelated, true);
    assert.equal(verdict.confidence, 0.9);
    assert.equal(verdict.detectedDomain, "financial_services");
  });

  test("fails closed when the response cannot be parsed", () => {
    const verdict = parseScenarioClassifierVerdict("utterly unparseable");

    assert.equal(verdict.isAppropriate, false);
    assert.equal(verdict.isScenarioRelated, false);
    assert.deepEqual(verdict.contentFlags, ["PARSE_ERROR"]);
  });

  test("accepts the snake_case domain alternate", () => {
    const verdict = parseScenarioClassifierVerdict(
      JSON.stringify({ detected_domain: "healthcare" }),
    );
    assert.equal(verdict.detectedDomain, "healthcare");
  });

  test("defaults isAppropriate to true when absent", () => {
    const verdict = parseScenarioClassifierVerdict(JSON.stringify({ reason: "ok" }));
    assert.equal(verdict.isAppropriate, true);
  });
});

describe("parseRecommendedActions", () => {
  test("reads an actions array", () => {
    assert.deepEqual(
      parseRecommendedActions(JSON.stringify({ actions: ["a", "b", "c", "d"] })),
      ["a", "b", "c"],
    );
  });

  test("reads the recommendedActions alternate", () => {
    assert.deepEqual(
      parseRecommendedActions(JSON.stringify({ recommendedActions: ["x"] })),
      ["x"],
    );
  });

  test("returns an empty array on unparseable input", () => {
    assert.deepEqual(parseRecommendedActions("nope"), []);
  });
});

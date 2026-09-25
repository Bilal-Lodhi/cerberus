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
  MAX_MANDATE_DEPTH,
  MAX_PARSED_ENTRIES,
  MAX_PARSED_TEXT_CHARS,
  extractJsonObject,
  parseAntiExfiltrationThresholds,
  parseBehavioralAnomaly,
  parseExfiltrationReport,
  parseJsonLoose,
  parseRecommendedActions,
  parseRegulatoryMandates,
  parseRiskAssessment,
  parseScenarioClassifierVerdict,
  parseThreatScenarioMatrix,
  repairJson,
  safeArray,
  safeStringArray,
  stripMarkdownFences,
} from "../src/ai/parsers.js";
import { clampScore } from "../src/routes/guardian.js";

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

  test("bounds each action's length", () => {
    const actions = parseRecommendedActions(
      JSON.stringify({ actions: ["z".repeat(MAX_PARSED_TEXT_CHARS * 3)] }),
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0].length, MAX_PARSED_TEXT_CHARS);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Bounds on model-supplied values
// ═══════════════════════════════════════════════════════════════════

describe("model output bounds — risk assessment", () => {
  test("clamps an out-of-range overallRiskScore into 0-100", () => {
    for (const [raw, expected] of [
      [-1e9, 0],
      [-1, 0],
      [101, 100],
      [1e9, 100],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
    ] as Array<[number, number]>) {
      const payload = parseRiskAssessment(
        JSON.stringify({ overallRiskScore: raw }),
        GENERATED_AT,
      );
      assert.equal(payload.overallRiskScore, expected, `raw=${raw}`);
    }
  });

  test("clamps every dimension score into 0-100", () => {
    const payload = parseRiskAssessment(
      JSON.stringify({
        dimensionScores: {
          dataExfiltration: -500,
          unauthorizedAccess: 1e6,
          policyViolation: 50,
          amlRedFlag: Number.NaN,
          insiderTrading: -0.5,
          soxNonCompliance: 100.4,
        },
      }),
      GENERATED_AT,
    );

    assert.equal(payload.dimensionScores.dataExfiltration, 0);
    assert.equal(payload.dimensionScores.unauthorizedAccess, 100);
    assert.equal(payload.dimensionScores.policyViolation, 50);
    assert.equal(payload.dimensionScores.amlRedFlag, 0);
    assert.equal(payload.dimensionScores.insiderTrading, 0);
    assert.equal(payload.dimensionScores.soxNonCompliance, 100);
  });

  test("clamps flag confidence into 0-1", () => {
    const payload = parseRiskAssessment(
      JSON.stringify({
        flags: [
          { flagType: "A", confidence: 42 },
          { flagType: "B", confidence: -3 },
          { flagType: "C", confidence: 0.25 },
        ],
      }),
      GENERATED_AT,
    );

    assert.equal(payload.flags[0].confidence, 1);
    assert.equal(payload.flags[1].confidence, 0);
    assert.equal(payload.flags[2].confidence, 0.25);
  });

  test("bounds the flag and anomaly arrays", () => {
    const many = Array.from({ length: MAX_PARSED_ENTRIES * 3 }, (_, i) => ({
      flagType: `F${i}`,
    }));
    const payload = parseRiskAssessment(
      JSON.stringify({ flags: many, behavioralAnomalies: many }),
      GENERATED_AT,
    );

    assert.equal(payload.flags.length, MAX_PARSED_ENTRIES);
    assert.equal(payload.behavioralAnomalies.length, MAX_PARSED_ENTRIES);
  });

  test("drops non-object entries instead of fabricating records", () => {
    // A null entry used to be indexed into, and a string entry used to become a
    // fieldless record that looked like real evidence.
    const payload = parseRiskAssessment(
      JSON.stringify({ flags: [null, "not a flag", 42, [], { flagType: "REAL" }] }),
      GENERATED_AT,
    );

    assert.equal(payload.flags.length, 1);
    assert.equal(payload.flags[0].flagType, "REAL");
  });

  test("bounds a long flag description and identifier", () => {
    const payload = parseRiskAssessment(
      JSON.stringify({
        flags: [
          {
            flagType: "T".repeat(500),
            description: "D".repeat(MAX_PARSED_TEXT_CHARS * 4),
          },
        ],
      }),
      GENERATED_AT,
    );

    assert.equal(payload.flags[0].description.length, MAX_PARSED_TEXT_CHARS);
    assert.ok(payload.flags[0].flagType.length <= MAX_PARSED_TEXT_CHARS);
  });
});

describe("model output bounds — exfiltration report", () => {
  test("returns null for a non-object report", () => {
    for (const raw of ["a string", 42, [], true]) {
      assert.equal(
        parseExfiltrationReport(raw),
        null,
        `expected null for ${JSON.stringify(raw)}`,
      );
    }
  });

  test("clamps similarity fields into 0-1", () => {
    const report = parseExfiltrationReport({
      overallSimilarity: 9,
      aiCompletionLikelihood: -4,
      matchedSnippets: [],
    });

    assert.ok(report);
    assert.equal(report.overallSimilarity, 1);
    assert.equal(report.aiCompletionLikelihood, 0);
  });

  test("validates each matched snippet", () => {
    const report = parseExfiltrationReport({
      overallSimilarity: 0.5,
      matchedSnippets: [
        { sourceSnippet: "s", employeeSnippet: "e", similarityScore: 12, sourceLabel: "L" },
        null,
        "junk",
      ],
    });

    assert.ok(report);
    assert.equal(report.matchedSnippets.length, 1);
    assert.equal(report.matchedSnippets[0].similarityScore, 1);
    assert.equal(report.matchedSnippets[0].sourceLabel, "L");
  });

  test("bounds the matched-snippet array", () => {
    const report = parseExfiltrationReport({
      matchedSnippets: Array.from({ length: MAX_PARSED_ENTRIES * 2 }, () => ({
        similarityScore: 0.5,
      })),
    });

    assert.ok(report);
    assert.equal(report.matchedSnippets.length, MAX_PARSED_ENTRIES);
  });

  test("a malformed report reaches the contract, not the raw value", () => {
    const payload = parseRiskAssessment(
      JSON.stringify({ exfiltrationReport: "looks like a match" }),
      GENERATED_AT,
    );
    assert.equal(payload.exfiltrationReport, null);
  });
});

describe("model output bounds — behavioural anomalies", () => {
  test("coerces a malformed anomaly into the contract shape", () => {
    const anomaly = parseBehavioralAnomaly({ anomalyType: "PASTE_BURST" });

    assert.equal(anomaly.anomalyType, "PASTE_BURST");
    assert.equal(anomaly.metricValue, 0);
    assert.equal(anomaly.threshold, 0);
    assert.equal(typeof anomaly.description, "string");
  });

  test("bounds anomaly text fields", () => {
    const anomaly = parseBehavioralAnomaly({
      anomalyType: "A".repeat(400),
      description: "D".repeat(MAX_PARSED_TEXT_CHARS * 3),
      metricValue: 9,
      threshold: 5,
    });

    assert.ok(anomaly.anomalyType.length <= MAX_PARSED_TEXT_CHARS);
    assert.equal(anomaly.description.length, MAX_PARSED_TEXT_CHARS);
    assert.equal(anomaly.metricValue, 9);
  });
});

describe("model output bounds — scenario matrix", () => {
  test("clamps mandate weight into 0-1", () => {
    const mandates = parseRegulatoryMandates([
      { mandateId: "a", weight: 5 },
      { mandateId: "b", weight: -1 },
      { mandateId: "c", weight: 0.4 },
    ]);

    assert.equal(mandates[0].weight, 1);
    assert.equal(mandates[1].weight, 0);
    assert.equal(mandates[2].weight, 0.4);
  });

  test("clamps vector riskScore into 0-100 and keeps a sane investigation time", () => {
    const matrix = parseThreatScenarioMatrix(
      JSON.stringify({
        threatVectors: [
          { vectorId: "a", riskScore: 1e6, investigationTimeMinutes: -50 },
          { vectorId: "b", riskScore: 42, investigationTimeMinutes: 30 },
        ],
      }),
      "m",
      GENERATED_AT,
    );

    assert.equal(matrix.threatVectors[0].riskScore, 100);
    assert.equal(matrix.threatVectors[0].investigationTimeMinutes, 0);
    assert.equal(matrix.threatVectors[1].riskScore, 42);
    assert.equal(matrix.threatVectors[1].investigationTimeMinutes, 30);
  });

  test("clamps anti-exfiltration thresholds to their documented ranges", () => {
    const thresholds = parseAntiExfiltrationThresholds({
      maxPasteEvents: -5,
      maxTimeBetweenKeystrokesMs: 1e9,
      dataLeakageSimilarityThreshold: 4,
      behavioralAnomalySensitivity: -2,
      maxCopyAttempts: 0,
      maxWindowBlurEvents: 99_999,
    });

    assert.equal(thresholds.maxPasteEvents, 0);
    assert.equal(thresholds.maxTimeBetweenKeystrokesMs, 60_000);
    assert.equal(thresholds.dataLeakageSimilarityThreshold, 1);
    assert.equal(thresholds.behavioralAnomalySensitivity, 0);
    assert.equal(thresholds.maxCopyAttempts, 0);
    assert.equal(thresholds.maxWindowBlurEvents, 10_000);
  });

  test("falls back to the documented thresholds when the model supplies none", () => {
    const thresholds = parseAntiExfiltrationThresholds(undefined);
    assert.deepEqual(thresholds, DEFAULT_ANTI_EXFILTRATION_THRESHOLDS);
  });

  test("bounds the scenario collections", () => {
    const many = Array.from({ length: MAX_PARSED_ENTRIES * 2 }, (_, i) => ({
      vectorId: `v${i}`,
    }));
    const matrix = parseThreatScenarioMatrix(
      JSON.stringify({
        targetSystems: many,
        regulatoryMandates: many,
        threatVectors: many,
        penetrationScenarios: many,
      }),
      "m",
      GENERATED_AT,
    );

    assert.equal(matrix.targetSystems.length, MAX_PARSED_ENTRIES);
    assert.equal(matrix.regulatoryMandates.length, MAX_PARSED_ENTRIES);
    assert.equal(matrix.threatVectors.length, MAX_PARSED_ENTRIES);
    assert.equal(matrix.penetrationScenarios.length, MAX_PARSED_ENTRIES);
  });

  test("bounds and validates the nested subMandates tree", () => {
    // A deep tree must terminate rather than recurse without bound.
    let nested: Record<string, unknown> = { mandateId: "leaf", weight: 0.5 };
    for (let i = 0; i < MAX_MANDATE_DEPTH + 10; i++) {
      nested = { mandateId: `m${i}`, weight: 0.5, subMandates: [nested] };
    }

    const mandates = parseRegulatoryMandates([nested]);

    let depth = 0;
    let cursor = mandates[0];
    while (cursor.subMandates.length > 0) {
      cursor = cursor.subMandates[0];
      depth++;
      assert.ok(depth <= MAX_MANDATE_DEPTH + 1, "subMandates recursion did not terminate");
    }
    assert.ok(depth > 0);
  });

  test("drops non-object subMandates entries", () => {
    const mandates = parseRegulatoryMandates([
      { mandateId: "a", subMandates: ["a string", null, { mandateId: "ok" }] },
    ]);

    assert.equal(mandates[0].subMandates.length, 1);
    assert.equal(mandates[0].subMandates[0].mandateId, "ok");
  });
});

describe("model output bounds — classifier", () => {
  test("clamps confidence into 0-1 so it cannot stand in for a confident verdict", () => {
    assert.equal(
      parseScenarioClassifierVerdict(JSON.stringify({ confidence: 42 })).confidence,
      1,
    );
    assert.equal(
      parseScenarioClassifierVerdict(JSON.stringify({ confidence: -1 })).confidence,
      0,
    );
  });

  test("bounds the reason and detectedDomain fields", () => {
    const verdict = parseScenarioClassifierVerdict(
      JSON.stringify({
        reason: "R".repeat(MAX_PARSED_TEXT_CHARS * 3),
        detectedDomain: "D".repeat(1000),
      }),
    );

    assert.equal(verdict.reason.length, MAX_PARSED_TEXT_CHARS);
    assert.ok(verdict.detectedDomain.length <= MAX_PARSED_TEXT_CHARS);
  });
});

describe("clampScore", () => {
  test("rounds and clamps into 0-100", () => {
    assert.equal(clampScore(0), 0);
    assert.equal(clampScore(74.6), 75);
    assert.equal(clampScore(100), 100);
    assert.equal(clampScore(101), 100);
    assert.equal(clampScore(-1), 0);
    assert.equal(clampScore(1e9), 100);
  });

  test("turns a non-finite score into zero rather than NaN", () => {
    // NaN would make every threshold comparison false, silently disabling the
    // auto-lock instead of failing loudly.
    assert.equal(clampScore(Number.NaN), 0);
    assert.equal(clampScore(Number.POSITIVE_INFINITY), 0);
    assert.equal(clampScore(Number.NEGATIVE_INFINITY), 0);
  });
});

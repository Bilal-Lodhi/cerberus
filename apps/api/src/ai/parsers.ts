/**
 * Defensive structured-output parsers for AI responses.
 *
 * These functions are pure: they take raw model text (or a decoded object)
 * and return a validated Cerberus contract. They are deliberately isolated
 * from the provider so they can be exercised with deterministic fixtures
 * without any network access.
 *
 * Parsing strategy, in order:
 *   1. strip markdown fences
 *   2. JSON.parse
 *   3. repair common LLM JSON quirks (trailing commas, control characters)
 *   4. extract the first balanced JSON object from surrounding prose
 */

import { randomUUID } from "node:crypto";
import type {
  AntiExfiltrationThresholds,
  BehavioralAnomaly,
  ExfiltrationReport,
  PenetrationScenario,
  RegulatoryMandate,
  RiskAssessmentPayload,
  RiskDimensionScores,
  RiskFlag,
  TargetSystem,
  ThreatScenarioMatrix,
  ThreatVector,
  TokenUsageStats,
} from "../types.js";

// ═══════════════════════════════════════════════════════════════════
// Primitive coercions
// ═══════════════════════════════════════════════════════════════════

export function safeArray(raw: unknown): Array<Record<string, unknown>> {
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
}

export function safeStringArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? (raw.filter((entry) => typeof entry === "string") as string[])
    : [];
}

function num(raw: unknown, fallback = 0): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

function str(raw: unknown, fallback = ""): string {
  return typeof raw === "string" ? raw : fallback;
}

function bool(raw: unknown, fallback = false): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

// ═══════════════════════════════════════════════════════════════════
// JSON recovery
// ═══════════════════════════════════════════════════════════════════

export function stripMarkdownFences(text: string): string {
  let result = text.trim();
  result = result.replace(/^```(?:json)?\s*\n?/i, "");
  result = result.replace(/\n?```\s*$/, "");
  return result.trim();
}

/**
 * Lightweight JSON repair for common LLM output quirks:
 * trailing commas and unescaped control characters.
 */
export function repairJson(text: string): string {
  return text
    .replace(/,(\s*[}\]])/g, "$1")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

/**
 * Extracts the first complete JSON object (balanced braces) from text that
 * may contain surrounding noise or markdown. String literals and escapes are
 * honoured so braces inside strings do not confuse the depth counter.
 *
 * Returns an empty string when the text contains no JSON object at all, so
 * callers can distinguish "recovered" from "nothing to recover".
 */
export function extractJsonObject(text: string): string {
  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) return "";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.substring(firstBrace, i + 1);
    }
  }
  return "";
}

/**
 * Decodes a JSON object from raw model text using the recovery ladder.
 * Throws a descriptive error when every stage fails — callers that must not
 * fail (risk parsing) catch it, callers that must fail closed (the content
 * classifier) let it propagate.
 */
export function parseJsonLoose(rawText: string): Record<string, unknown> {
  const trimmed = stripMarkdownFences(rawText);

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch (primaryError) {
    const primaryMessage =
      primaryError instanceof Error ? primaryError.message : String(primaryError);
    try {
      return JSON.parse(repairJson(trimmed)) as Record<string, unknown>;
    } catch {
      const extracted = extractJsonObject(trimmed);
      if (extracted.length === 0) {
        throw new Error(
          `Failed to parse JSON response: no JSON object found (${primaryMessage})`,
        );
      }
      try {
        return JSON.parse(extracted) as Record<string, unknown>;
      } catch {
        throw new Error(`Failed to parse JSON response: ${primaryMessage}`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Risk assessment
// ═══════════════════════════════════════════════════════════════════

const EMPTY_DIMENSIONS: RiskDimensionScores = {
  dataExfiltration: 0,
  unauthorizedAccess: 0,
  policyViolation: 0,
  amlRedFlag: 0,
  insiderTrading: 0,
  soxNonCompliance: 0,
};

export function parseRiskDimensions(raw: unknown): RiskDimensionScores {
  const dims = (raw ?? {}) as Record<string, unknown>;
  return {
    dataExfiltration: num(dims["dataExfiltration"], 0),
    unauthorizedAccess: num(dims["unauthorizedAccess"], 0),
    policyViolation: num(dims["policyViolation"], 0),
    amlRedFlag: num(dims["amlRedFlag"], 0),
    insiderTrading: num(dims["insiderTrading"], 0),
    soxNonCompliance: num(dims["soxNonCompliance"], 0),
  };
}

export function parseRiskFlag(raw: Record<string, unknown>): RiskFlag {
  const severity = str(raw["severity"], "medium");
  const validSeverity = (["low", "medium", "high", "critical"] as const).includes(
    severity as "low" | "medium" | "high" | "critical",
  )
    ? (severity as RiskFlag["severity"])
    : "medium";

  return {
    flagType: str(raw["flagType"], "unknown"),
    severity: validSeverity,
    sourceEventId: str(raw["sourceEventId"]),
    description: str(raw["description"], str(raw["flagType"], "")),
    confidence: num(raw["confidence"], 1),
    timestamp: str(raw["timestamp"]),
  };
}

/**
 * Parses a risk-assessment payload from raw model text.
 * Every field is coerced and an unparseable response yields a zeroed payload
 * rather than throwing: a formatting failure must not take down ingestion.
 */
export function parseRiskAssessment(
  rawText: string,
  fallbackGeneratedAt: string,
): RiskAssessmentPayload {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonLoose(rawText);
  } catch {
    parsed = {};
  }

  const rawFlags = safeArray(parsed["flags"]);
  const rawAnomalies = safeArray(parsed["behavioralAnomalies"]);

  const exfiltrationRaw = parsed["exfiltrationReport"];
  const exfiltrationReport =
    exfiltrationRaw && typeof exfiltrationRaw === "object"
      ? (exfiltrationRaw as ExfiltrationReport)
      : null;

  return {
    riskAssessmentId: str(parsed["riskAssessmentId"]) || randomUUID(),
    sessionId: str(parsed["sessionId"]),
    employeeId: str(parsed["employeeId"]),
    auditId: str(parsed["auditId"]),
    overallRiskScore: num(parsed["overallRiskScore"], 0),
    dimensionScores: parseRiskDimensions(parsed["dimensionScores"]),
    flags: rawFlags.map(parseRiskFlag),
    exfiltrationReport,
    behavioralAnomalies: rawAnomalies as unknown as BehavioralAnomaly[],
    generatedAt: str(parsed["generatedAt"]) || fallbackGeneratedAt,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Threat scenario matrix
// ═══════════════════════════════════════════════════════════════════

export const DEFAULT_ANTI_EXFILTRATION_THRESHOLDS: AntiExfiltrationThresholds = {
  maxPasteEvents: 5,
  maxTimeBetweenKeystrokesMs: 80,
  dataLeakageSimilarityThreshold: 0.75,
  behavioralAnomalySensitivity: 0.5,
  maxCopyAttempts: 3,
  maxWindowBlurEvents: 5,
};

const VALID_CRITICALITY = ["low", "medium", "high", "critical", "tier-1"] as const;
const VALID_SEVERITY = ["low", "medium", "high", "critical"] as const;
const VALID_VECTOR_TYPES = [
  "token_injection",
  "transfer_interception",
  "data_exfiltration",
  "privilege_escalation",
] as const;

function oneOf<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = str(raw);
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Parses a threat scenario matrix from raw model text.
 *
 * The model is instructed to emit camelCase keys, but snake_case alternates
 * are accepted defensively so a formatting drift degrades gracefully instead
 * of producing an empty matrix.
 */
export function parseThreatScenarioMatrix(
  rawText: string,
  modelVersion: string,
  fallbackGeneratedAt: string,
): ThreatScenarioMatrix {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonLoose(rawText);
  } catch {
    parsed = {};
  }

  const metadata = (parsed["metadata"] ?? {}) as Record<string, unknown>;

  const tokenUsage: TokenUsageStats = {
    promptTokens: num(metadata["promptTokens"], 0),
    completionTokens: num(metadata["completionTokens"], 0),
    totalTokens:
      num(metadata["totalTokens"], 0) ||
      num(metadata["promptTokens"], 0) + num(metadata["completionTokens"], 0),
  };

  const matrixId = str(metadata["matrixId"]) || randomUUID();

  const targetSystemsRaw =
    safeArray(parsed["targetSystems"]).length > 0
      ? safeArray(parsed["targetSystems"])
      : safeArray(parsed["target_systems"]);

  const regulatoryMandatesRaw =
    safeArray(parsed["regulatoryMandates"]).length > 0
      ? safeArray(parsed["regulatoryMandates"])
      : safeArray(parsed["regulatory_mandates"]);

  const threatVectorsRaw =
    safeArray(parsed["threatVectors"]).length > 0
      ? safeArray(parsed["threatVectors"])
      : safeArray(parsed["threat_vectors"]);

  const penetrationScenariosRaw =
    safeArray(parsed["penetrationScenarios"]).length > 0
      ? safeArray(parsed["penetrationScenarios"])
      : safeArray(parsed["penetration_scenarios"]);

  const targetSystems: TargetSystem[] = targetSystemsRaw.map((ts) => ({
    systemId: str(ts["systemId"]) || randomUUID(),
    name: str(ts["name"], "Unnamed System"),
    criticalityLevel: oneOf(ts["criticalityLevel"], VALID_CRITICALITY, "medium"),
    requiredMandateIds: safeStringArray(ts["requiredMandateIds"]),
    description: str(ts["description"]),
    examples: safeStringArray(ts["examples"]),
  }));

  const regulatoryMandates: RegulatoryMandate[] = regulatoryMandatesRaw.map((rm) => ({
    mandateId: str(rm["mandateId"]) || randomUUID(),
    name: str(rm["name"], "Unnamed Mandate"),
    description: str(rm["description"]),
    weight: num(rm["weight"], 0),
    // SAFETY: subMandates must be an array. A string here would crash the
    // Flutter console's `List<dynamic>` cast, so non-arrays become [].
    subMandates: safeArray(
      rm["subMandates"] ?? rm["sub_mandates"],
    ) as unknown as RegulatoryMandate[],
    regulationCode: str(rm["regulationCode"] ?? rm["regulation_code"]),
  }));

  const threatVectors: ThreatVector[] = threatVectorsRaw.map((tv) => ({
    vectorId: str(tv["vectorId"]) || randomUUID(),
    vectorType: oneOf(tv["vectorType"], VALID_VECTOR_TYPES, "data_exfiltration"),
    title: str(tv["title"], "Untitled Threat Vector"),
    description: str(tv["description"]),
    targetSystemId: str(tv["targetSystemId"]),
    exploitScenario: typeof tv["exploitScenario"] === "string" ? tv["exploitScenario"] : undefined,
    workspaceSeed: typeof tv["workspaceSeed"] === "string" ? tv["workspaceSeed"] : undefined,
    detectionRules: Array.isArray(tv["detectionRules"])
      ? (tv["detectionRules"] as ThreatVector["detectionRules"])
      : undefined,
    expectedRemediation:
      typeof tv["expectedRemediation"] === "string" ? tv["expectedRemediation"] : undefined,
    severity: oneOf(tv["severity"], VALID_SEVERITY, "medium"),
    mandateId: str(tv["mandateId"]),
    investigationTimeMinutes: num(tv["investigationTimeMinutes"], 600),
    riskScore: num(tv["riskScore"], 50),
  }));

  const penetrationScenarios: PenetrationScenario[] = penetrationScenariosRaw.map((ps) => {
    const thresholdsRaw = ps["antiExfiltrationThresholds"] ?? ps["anti_exfiltration_thresholds"];
    const thresholds =
      thresholdsRaw && typeof thresholdsRaw === "object"
        ? (thresholdsRaw as Partial<AntiExfiltrationThresholds>)
        : {};

    const scoringFormula =
      ps["scoringFormula"] && typeof ps["scoringFormula"] === "object"
        ? (ps["scoringFormula"] as PenetrationScenario["scoringFormula"])
        : { type: "weighted_sum" as const, weights: {} };

    return {
      scenarioId: str(ps["scenarioId"]) || randomUUID(),
      vectorId: str(ps["vectorId"]),
      mandateIds: safeStringArray(ps["mandateIds"]),
      scoringFormula,
      antiExfiltrationThresholds: {
        ...DEFAULT_ANTI_EXFILTRATION_THRESHOLDS,
        ...thresholds,
      },
      description: str(ps["description"]),
      exploitCode: typeof ps["exploitCode"] === "string" ? ps["exploitCode"] : undefined,
    };
  });

  return {
    metadata: {
      matrixId,
      generatedAt: str(metadata["generatedAt"]) || fallbackGeneratedAt,
      modelVersion,
      promptFingerprint: str(metadata["promptFingerprint"]),
      tokenUsage,
    },
    targetSystems,
    regulatoryMandates,
    threatVectors,
    penetrationScenarios,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Scenario request classifier
// ═══════════════════════════════════════════════════════════════════

export interface ScenarioClassifierVerdict {
  isInputMeaningful: boolean;
  isScenarioRelated: boolean;
  isAppropriate: boolean;
  contentFlags: string[];
  reason: string;
  confidence: number;
  detectedDomain: string;
}

/**
 * Parses the classifier verdict. A parse failure is treated as a rejection
 * (fail-closed) so malformed model output can never admit a request.
 */
export function parseScenarioClassifierVerdict(
  rawText: string,
): ScenarioClassifierVerdict {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonLoose(rawText);
  } catch {
    return {
      isInputMeaningful: false,
      isScenarioRelated: false,
      isAppropriate: false,
      contentFlags: ["PARSE_ERROR"],
      reason:
        "Unable to parse the threat-scenario classifier response. " +
        "The prompt could not be validated for content appropriateness or relevance.",
      confidence: 0.99,
      detectedDomain: "",
    };
  }

  return {
    isInputMeaningful: bool(parsed["isInputMeaningful"], false),
    isScenarioRelated: bool(parsed["isScenarioRelated"], false),
    isAppropriate: bool(parsed["isAppropriate"], true),
    contentFlags: safeStringArray(parsed["contentFlags"]),
    reason: str(parsed["reason"], "Unable to determine compliance relevance."),
    confidence: num(parsed["confidence"], 0.99),
    detectedDomain: str(parsed["detectedDomain"] ?? parsed["detected_domain"]),
  };
}

/** Parses `{ actions: string[] }` from a recommended-actions response. */
export function parseRecommendedActions(rawText: string): string[] {
  try {
    const parsed = parseJsonLoose(rawText);
    const actions = parsed["actions"] ?? parsed["recommendedActions"];
    return safeStringArray(actions).slice(0, 3);
  } catch {
    return [];
  }
}

export { EMPTY_DIMENSIONS };

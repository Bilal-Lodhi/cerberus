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
  ExfiltrationMatch,
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
// Bounds on model-supplied values
// ═══════════════════════════════════════════════════════════════════

/**
 * Upper bound on any model-supplied array.
 *
 * A well-formed response can still be arbitrarily large, and every entry becomes
 * a persisted document, a console row and a line in the review timeline.
 */
export const MAX_PARSED_ENTRIES = 50;

/** Upper bound on a model-supplied free-text field, in characters. */
export const MAX_PARSED_TEXT_CHARS = 2_000;

/** Upper bound on a model-supplied identifier or enum-like field. */
export const MAX_PARSED_ID_CHARS = 200;

/** Depth limit for the self-referential `subMandates` tree. */
export const MAX_MANDATE_DEPTH = 5;

/**
 * Clamps a model-supplied number into its documented range.
 *
 * `num()` already rejects `NaN` and infinities, but finiteness is not range: the
 * contract says `overallRiskScore` is 0-100 and `confidence` is 0-1, and a
 * well-formed `-1e9` or `1e9` would corrupt every downstream comparison —
 * thresholds, sorting, the auto-lock decision — without ever looking malformed.
 */
function clamp(raw: unknown, min: number, max: number, fallback = 0): number {
  const value = num(raw, fallback);
  return Math.min(Math.max(value, min), max);
}

/** Bounds a model-supplied string, keeping the leading characters. */
function bounded(raw: unknown, fallback: string, maxChars: number): string {
  const value = str(raw, fallback);
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

/**
 * Bounds a model-supplied array, keeping the leading entries.
 *
 * Non-object entries are dropped rather than coerced. Every consumer of this
 * indexes into the entries, so a `null`, string or nested array would either
 * throw (`null["field"]`) or fabricate a fieldless record that looks like real
 * evidence. Dropping them keeps the "malformed structure never escapes the
 * parser" property honest.
 */
function boundedArray(raw: unknown, maxEntries: number): Array<Record<string, unknown>> {
  const entries = safeArray(raw).filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
  return entries.length > maxEntries ? entries.slice(0, maxEntries) : entries;
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
  // Each dimension is documented as 0-100. Clamped rather than merely coerced,
  // so an out-of-range model value cannot distort the console's bar rendering
  // or any threshold comparison.
  return {
    dataExfiltration: clamp(dims["dataExfiltration"], 0, 100),
    unauthorizedAccess: clamp(dims["unauthorizedAccess"], 0, 100),
    policyViolation: clamp(dims["policyViolation"], 0, 100),
    amlRedFlag: clamp(dims["amlRedFlag"], 0, 100),
    insiderTrading: clamp(dims["insiderTrading"], 0, 100),
    soxNonCompliance: clamp(dims["soxNonCompliance"], 0, 100),
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
    flagType: bounded(raw["flagType"], "unknown", MAX_PARSED_ID_CHARS),
    severity: validSeverity,
    sourceEventId: bounded(raw["sourceEventId"], "", MAX_PARSED_ID_CHARS),
    description: bounded(
      raw["description"],
      bounded(raw["flagType"], "", MAX_PARSED_ID_CHARS),
      MAX_PARSED_TEXT_CHARS,
    ),
    // Documented as 0-1. The fallback is 1, matching the previous default.
    confidence: clamp(raw["confidence"], 0, 1, 1),
    timestamp: bounded(raw["timestamp"], "", MAX_PARSED_ID_CHARS),
  };
}

/**
 * Parses one exfiltration match, validating its structure.
 *
 * Previously the whole `exfiltrationReport` was cast to its contract type, so a
 * malformed entry reached the console and the review timeline untouched.
 */
export function parseExfiltrationMatch(raw: Record<string, unknown>): ExfiltrationMatch {
  return {
    sourceSnippet: bounded(raw["sourceSnippet"], "", MAX_PARSED_TEXT_CHARS),
    employeeSnippet: bounded(raw["employeeSnippet"], "", MAX_PARSED_TEXT_CHARS),
    similarityScore: clamp(raw["similarityScore"], 0, 1),
    sourceLabel: bounded(raw["sourceLabel"], "unknown", MAX_PARSED_ID_CHARS),
  };
}

/**
 * Parses an `ExfiltrationReport`, or returns null when the model supplied
 * something that is not an object.
 */
export function parseExfiltrationReport(raw: unknown): ExfiltrationReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const source = raw as Record<string, unknown>;
  return {
    overallSimilarity: clamp(source["overallSimilarity"], 0, 1),
    matchedSnippets: boundedArray(
      source["matchedSnippets"],
      MAX_PARSED_ENTRIES,
    ).map(parseExfiltrationMatch),
    aiCompletionLikelihood: clamp(source["aiCompletionLikelihood"], 0, 1),
  };
}

/**
 * Parses one behavioural anomaly, validating its structure.
 *
 * `metricValue` and `threshold` have no documented range because they carry
 * whichever metric the anomaly describes, so they are only required to be
 * finite — which `num()` already guarantees.
 */
export function parseBehavioralAnomaly(raw: Record<string, unknown>): BehavioralAnomaly {
  return {
    anomalyType: bounded(raw["anomalyType"], "unknown", MAX_PARSED_ID_CHARS),
    description: bounded(raw["description"], "", MAX_PARSED_TEXT_CHARS),
    evidenceWindowStart: bounded(raw["evidenceWindowStart"], "", MAX_PARSED_ID_CHARS),
    evidenceWindowEnd: bounded(raw["evidenceWindowEnd"], "", MAX_PARSED_ID_CHARS),
    metricValue: num(raw["metricValue"], 0),
    threshold: num(raw["threshold"], 0),
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

  return {
    riskAssessmentId: bounded(str(parsed["riskAssessmentId"]) || randomUUID(), "", MAX_PARSED_ID_CHARS),
    sessionId: bounded(parsed["sessionId"], "", MAX_PARSED_ID_CHARS),
    employeeId: bounded(parsed["employeeId"], "", MAX_PARSED_ID_CHARS),
    auditId: bounded(parsed["auditId"], "", MAX_PARSED_ID_CHARS),
    // Documented as 0-100. Clamped here as well as in guardian.ts, because the
    // parser is the single boundary every consumer reads from.
    overallRiskScore: clamp(parsed["overallRiskScore"], 0, 100),
    dimensionScores: parseRiskDimensions(parsed["dimensionScores"]),
    flags: boundedArray(parsed["flags"], MAX_PARSED_ENTRIES).map(parseRiskFlag),
    exfiltrationReport: parseExfiltrationReport(parsed["exfiltrationReport"]),
    behavioralAnomalies: boundedArray(
      parsed["behavioralAnomalies"],
      MAX_PARSED_ENTRIES,
    ).map(parseBehavioralAnomaly),
    generatedAt: bounded(parsed["generatedAt"], fallbackGeneratedAt, MAX_PARSED_ID_CHARS) ||
      fallbackGeneratedAt,
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
 * Parses a regulatory-mandate list, including its self-referential
 * `subMandates` tree.
 *
 * Recursive with a depth limit, so a deeply nested or cyclic-looking model
 * response cannot recurse without bound. Every numeric field is clamped to the
 * range the contract documents.
 */
export function parseRegulatoryMandates(
  raw: unknown,
  depth = 0,
): RegulatoryMandate[] {
  if (depth > MAX_MANDATE_DEPTH) return [];

  return boundedArray(raw, MAX_PARSED_ENTRIES).map((rm) => ({
    mandateId: bounded(str(rm["mandateId"]) || randomUUID(), "", MAX_PARSED_ID_CHARS),
    name: bounded(rm["name"], "Unnamed Mandate", MAX_PARSED_TEXT_CHARS),
    description: bounded(rm["description"], "", MAX_PARSED_TEXT_CHARS),
    // Documented as 0-1: a mandate's contribution to the compliance score.
    weight: clamp(rm["weight"], 0, 1),
    // SAFETY: subMandates must be an array of objects. A string here would crash
    // the Flutter console's `List<dynamic>` cast, so non-arrays become [].
    subMandates: parseRegulatoryMandates(rm["subMandates"] ?? rm["sub_mandates"], depth + 1),
    regulationCode: bounded(rm["regulationCode"] ?? rm["regulation_code"], "", MAX_PARSED_ID_CHARS),
  }));
}

/** Clamps a model-supplied anti-exfiltration threshold set to its documented ranges. */
export function parseAntiExfiltrationThresholds(
  raw: unknown,
): AntiExfiltrationThresholds {
  const thresholds =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  return {
    maxPasteEvents: clamp(
      thresholds["maxPasteEvents"],
      0,
      10_000,
      DEFAULT_ANTI_EXFILTRATION_THRESHOLDS.maxPasteEvents,
    ),
    maxTimeBetweenKeystrokesMs: clamp(
      thresholds["maxTimeBetweenKeystrokesMs"],
      0,
      60_000,
      DEFAULT_ANTI_EXFILTRATION_THRESHOLDS.maxTimeBetweenKeystrokesMs,
    ),
    // Documented as a 0-1 similarity.
    dataLeakageSimilarityThreshold: clamp(
      thresholds["dataLeakageSimilarityThreshold"],
      0,
      1,
      DEFAULT_ANTI_EXFILTRATION_THRESHOLDS.dataLeakageSimilarityThreshold,
    ),
    behavioralAnomalySensitivity: clamp(
      thresholds["behavioralAnomalySensitivity"],
      0,
      1,
      DEFAULT_ANTI_EXFILTRATION_THRESHOLDS.behavioralAnomalySensitivity,
    ),
    maxCopyAttempts: clamp(
      thresholds["maxCopyAttempts"],
      0,
      10_000,
      DEFAULT_ANTI_EXFILTRATION_THRESHOLDS.maxCopyAttempts,
    ),
    maxWindowBlurEvents: clamp(
      thresholds["maxWindowBlurEvents"],
      0,
      10_000,
      DEFAULT_ANTI_EXFILTRATION_THRESHOLDS.maxWindowBlurEvents,
    ),
  };
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
    promptTokens: clamp(metadata["promptTokens"], 0, Number.MAX_SAFE_INTEGER),
    completionTokens: clamp(metadata["completionTokens"], 0, Number.MAX_SAFE_INTEGER),
    totalTokens:
      clamp(metadata["totalTokens"], 0, Number.MAX_SAFE_INTEGER) ||
      clamp(metadata["promptTokens"], 0, Number.MAX_SAFE_INTEGER) +
        clamp(metadata["completionTokens"], 0, Number.MAX_SAFE_INTEGER),
  };

  const matrixId = bounded(str(metadata["matrixId"]) || randomUUID(), "", MAX_PARSED_ID_CHARS);

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

  // Every collection is bounded. `vectorCount` is capped at 25 by the request
  // contract, so a ceiling of 50 cannot truncate a response the API itself
  // asked for, while still bounding what one model reply can create.
  const targetSystems: TargetSystem[] = boundedArray(
    targetSystemsRaw,
    MAX_PARSED_ENTRIES,
  ).map((ts) => ({
    systemId: bounded(str(ts["systemId"]) || randomUUID(), "", MAX_PARSED_ID_CHARS),
    name: bounded(ts["name"], "Unnamed System", MAX_PARSED_TEXT_CHARS),
    criticalityLevel: oneOf(ts["criticalityLevel"], VALID_CRITICALITY, "medium"),
    requiredMandateIds: safeStringArray(ts["requiredMandateIds"]).slice(
      0,
      MAX_PARSED_ENTRIES,
    ),
    description: bounded(ts["description"], "", MAX_PARSED_TEXT_CHARS),
    examples: safeStringArray(ts["examples"]).slice(0, MAX_PARSED_ENTRIES),
  }));

  const regulatoryMandates: RegulatoryMandate[] = parseRegulatoryMandates(
    regulatoryMandatesRaw,
  );

  const threatVectors: ThreatVector[] = boundedArray(
    threatVectorsRaw,
    MAX_PARSED_ENTRIES,
  ).map((tv) => ({
    vectorId: bounded(str(tv["vectorId"]) || randomUUID(), "", MAX_PARSED_ID_CHARS),
    vectorType: oneOf(tv["vectorType"], VALID_VECTOR_TYPES, "data_exfiltration"),
    title: bounded(tv["title"], "Untitled Threat Vector", MAX_PARSED_TEXT_CHARS),
    description: bounded(tv["description"], "", MAX_PARSED_TEXT_CHARS),
    targetSystemId: bounded(tv["targetSystemId"], "", MAX_PARSED_ID_CHARS),
    exploitScenario:
      typeof tv["exploitScenario"] === "string"
        ? bounded(tv["exploitScenario"], "", MAX_PARSED_TEXT_CHARS)
        : undefined,
    workspaceSeed:
      typeof tv["workspaceSeed"] === "string"
        ? bounded(tv["workspaceSeed"], "", MAX_PARSED_TEXT_CHARS)
        : undefined,
    detectionRules: Array.isArray(tv["detectionRules"])
      ? (boundedArray(
          tv["detectionRules"],
          MAX_PARSED_ENTRIES,
        ) as unknown as ThreatVector["detectionRules"])
      : undefined,
    expectedRemediation:
      typeof tv["expectedRemediation"] === "string"
        ? bounded(tv["expectedRemediation"], "", MAX_PARSED_TEXT_CHARS)
        : undefined,
    severity: oneOf(tv["severity"], VALID_SEVERITY, "medium"),
    mandateId: bounded(tv["mandateId"], "", MAX_PARSED_ID_CHARS),
    // Documented as a positive minute count with a default of 600.
    investigationTimeMinutes: clamp(tv["investigationTimeMinutes"], 0, 100_000, 600),
    // Documented as 0-100.
    riskScore: clamp(tv["riskScore"], 0, 100, 50),
  }));

  const penetrationScenarios: PenetrationScenario[] = boundedArray(
    penetrationScenariosRaw,
    MAX_PARSED_ENTRIES,
  ).map((ps) => {
    const scoringFormula =
      ps["scoringFormula"] && typeof ps["scoringFormula"] === "object"
        ? (ps["scoringFormula"] as PenetrationScenario["scoringFormula"])
        : { type: "weighted_sum" as const, weights: {} };

    return {
      scenarioId: bounded(str(ps["scenarioId"]) || randomUUID(), "", MAX_PARSED_ID_CHARS),
      vectorId: bounded(ps["vectorId"], "", MAX_PARSED_ID_CHARS),
      mandateIds: safeStringArray(ps["mandateIds"]).slice(0, MAX_PARSED_ENTRIES),
      scoringFormula,
      // Clamped field by field over the documented defaults, rather than spread
      // raw: a model-supplied threshold outside its range would otherwise be
      // persisted and shown to the operator as if it were valid.
      antiExfiltrationThresholds: parseAntiExfiltrationThresholds(
        ps["antiExfiltrationThresholds"] ?? ps["anti_exfiltration_thresholds"],
      ),
      description: bounded(ps["description"], "", MAX_PARSED_TEXT_CHARS),
      exploitCode:
        typeof ps["exploitCode"] === "string"
          ? bounded(ps["exploitCode"], "", MAX_PARSED_TEXT_CHARS)
          : undefined,
    };
  });

  return {
    metadata: {
      matrixId,
      generatedAt:
        bounded(metadata["generatedAt"], "", MAX_PARSED_ID_CHARS) || fallbackGeneratedAt,
      modelVersion,
      promptFingerprint: bounded(metadata["promptFingerprint"], "", MAX_PARSED_ID_CHARS),
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
    contentFlags: safeStringArray(parsed["contentFlags"]).slice(0, MAX_PARSED_ENTRIES),
    reason: bounded(
      parsed["reason"],
      "Unable to determine compliance relevance.",
      MAX_PARSED_TEXT_CHARS,
    ),
    // Documented as 0-1. `evaluateVerdict()` rejects below 0.75, so an
    // out-of-range value must not be able to stand in for a confident verdict.
    confidence: clamp(parsed["confidence"], 0, 1, 0.99),
    detectedDomain: bounded(
      parsed["detectedDomain"] ?? parsed["detected_domain"],
      "",
      MAX_PARSED_ID_CHARS,
    ),
  };
}

/**
 * Parses `{ actions: string[] }` from a recommended-actions response.
 *
 * Capped at three actions, each length-bounded: these strings are rendered in
 * the console notification and emailed to a third party.
 */
export function parseRecommendedActions(rawText: string): string[] {
  try {
    const parsed = parseJsonLoose(rawText);
    const actions = parsed["actions"] ?? parsed["recommendedActions"];
    return safeStringArray(actions)
      .slice(0, 3)
      .map((action) => (action.length > MAX_PARSED_TEXT_CHARS
        ? action.slice(0, MAX_PARSED_TEXT_CHARS)
        : action));
  } catch {
    return [];
  }
}

export { EMPTY_DIMENSIONS };

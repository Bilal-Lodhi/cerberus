/**
 * Cerberus AI provider boundary.
 *
 * There is exactly ONE inference path in this codebase: the OpenAI Chat
 * Completions API through the official `openai` Node SDK. Every AI-backed
 * feature (risk analysis, threat-scenario authoring, request classification,
 * auditor queries, incident recommendations) goes through this class.
 *
 * Design notes:
 *   - All model output is treated as untrusted text and handed to the pure
 *     parsers in ./parsers.ts. The provider never assumes well-formed JSON.
 *   - Retries use exponential backoff with jitter and never retry
 *     authentication or quota failures.
 *   - No secret material is ever logged.
 */

import OpenAI from "openai";
import type { AppConfig, OpenAIConfig } from "../config.js";
import { toISOStringLocal } from "../utils/time.js";
import type {
  RiskAssessmentPayload,
  SeverityMix,
  ThreatScenarioMatrix,
} from "../types.js";
import {
  parseRecommendedActions,
  parseRiskAssessment,
  parseScenarioClassifierVerdict,
  parseThreatScenarioMatrix,
  type ScenarioClassifierVerdict,
} from "./parsers.js";

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export class AIProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIProviderError";
  }
}

/** Errors that must never be retried — retrying cannot fix them. */
function isFatal(message: string): boolean {
  return (
    message.includes("401") ||
    message.includes("403") ||
    message.includes("invalid_api_key") ||
    message.includes("insufficient_quota")
  );
}

export class OpenAIProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly temperature: number;

  constructor(config: AppConfig) {
    if (!config.openai.apiKey) {
      throw new AIProviderError(
        "OPENAI_API_KEY is not set. Unable to initialize the Cerberus AI provider.",
      );
    }

    const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: config.openai.apiKey,
      maxRetries: 0, // retries are handled here so backoff is observable
      timeout: config.openai.requestTimeoutMs,
    };
    if (config.openai.baseUrl) {
      clientOptions.baseURL = config.openai.baseUrl;
    }

    this.client = new OpenAI(clientOptions);
    this.model = config.openai.model;
    this.maxOutputTokens = config.openai.maxOutputTokens;
    this.temperature = config.openai.temperature;

    console.log(
      `[ai] OpenAI provider ready → model="${this.model}" ` +
        `maxOutputTokens=${this.maxOutputTokens} temperature=${this.temperature} ` +
        `timeout=${config.openai.requestTimeoutMs}ms`,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // Low-level completion primitives
  // ═══════════════════════════════════════════════════════════════

  /**
   * Single chat completion. Requests `response_format: json_object`; if the
   * model returns empty text, retries once without the format constraint
   * (some models refuse to emit JSON for certain prompts).
   */
  private async complete(
    systemPrompt: string,
    userPrompt: string,
    options: CompletionOptions & { jsonMode: boolean },
  ): Promise<string> {
    const signal = options.signal;
    if (signal?.aborted) throw new AIProviderError("Operation cancelled");

    const temperature = options.temperature ?? this.temperature;
    const maxTokens = options.maxTokens ?? this.maxOutputTokens;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new AIProviderError("Operation cancelled");

      try {
        const request: Record<string, unknown> = {
          model: this.model,
          temperature,
          max_completion_tokens: maxTokens,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        };
        if (options.jsonMode) {
          request["response_format"] = { type: "json_object" };
        }

        const startedAt = Date.now();
        const completion = await this.client.chat.completions.create(
          request as never,
          { signal },
        );
        const text = completion.choices[0]?.message?.content ?? "";

        console.log(
          `[ai] attempt ${attempt}/${MAX_ATTEMPTS} ok — ` +
            `elapsed=${Date.now() - startedAt}ms chars=${text.length}`,
        );

        if (text.trim().length > 0) return text;

        // Empty response: retry once without the JSON-mode constraint.
        if (options.jsonMode) {
          const fallback = await this.client.chat.completions.create(
            {
              model: this.model,
              temperature,
              max_completion_tokens: maxTokens,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
              ],
            } as never,
            { signal },
          );
          const fallbackText = fallback.choices[0]?.message?.content ?? "";
          if (fallbackText.trim().length > 0) return fallbackText;
        }

        lastError = new AIProviderError("Model returned an empty response");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = error instanceof Error ? error : new AIProviderError(message);
        console.error(`[ai] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${message}`);

        if (isFatal(message)) throw lastError;
      }

      if (attempt < MAX_ATTEMPTS) {
        const delay = BASE_BACKOFF_MS * Math.pow(2, attempt - 1) + Math.random() * 500;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new AIProviderError(
      `OpenAI request failed after ${MAX_ATTEMPTS} attempts. ` +
        `Last error: ${lastError?.message ?? "unknown"}`,
    );
  }

  /** JSON-mode completion. Returns raw model text for the caller to parse. */
  async completeJson(
    systemPrompt: string,
    userPrompt: string,
    options: CompletionOptions = {},
  ): Promise<string> {
    return this.complete(systemPrompt, userPrompt, { ...options, jsonMode: true });
  }

  /** Plain-text completion. */
  async completeText(
    systemPrompt: string,
    userPrompt: string,
    options: CompletionOptions = {},
  ): Promise<string> {
    return this.complete(systemPrompt, userPrompt, { ...options, jsonMode: false });
  }

  // ═══════════════════════════════════════════════════════════════
  // Feature: live risk analysis (Cerberus core)
  // ═══════════════════════════════════════════════════════════════

  async analyzeRisk(
    currentCode: string,
    pasteContents: string[],
    keystrokeMetrics: { avgDeltaMs: number; maxDeltaMs: number; minDeltaMs: number },
    referenceCompletions: string[],
  ): Promise<RiskAssessmentPayload> {
    const system = buildRiskSystemPrompt();
    const user = buildRiskUserPrompt(
      currentCode,
      pasteContents,
      keystrokeMetrics,
      referenceCompletions,
    );

    const raw = await this.completeJson(system, user);
    const payload = parseRiskAssessment(raw, toISOStringLocal());

    console.log(
      `[ai] risk analysis parsed — score=${payload.overallRiskScore} ` +
        `flags=${payload.flags.length} anomalies=${payload.behavioralAnomalies.length}`,
    );
    return payload;
  }

  async recommendIncidentActions(payload: RiskAssessmentPayload): Promise<string[]> {
    try {
      const raw = await this.completeJson(
        "You are a financial security incident-response expert. Return JSON with an " +
          "actions array containing exactly 3 specific, actionable steps.",
        `Given this risk assessment (JSON), suggest 3 specific, actionable steps for a security team:\n` +
          JSON.stringify(payload),
        { temperature: 0.1, maxTokens: 1000 },
      );
      return parseRecommendedActions(raw);
    } catch (error) {
      console.error(
        "[ai] recommended-actions generation failed:",
        error instanceof Error ? error.message : String(error),
      );
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Feature: threat scenario authoring
  // ═══════════════════════════════════════════════════════════════

  async classifyScenarioRequest(
    prompt: string,
    roleContext: string,
    signal?: AbortSignal,
  ): Promise<ScenarioClassifierVerdict> {
    const raw = await this.completeJson(
      buildClassifierSystemPrompt(),
      buildClassifierUserPrompt(prompt, roleContext),
      { signal },
    );
    const verdict = parseScenarioClassifierVerdict(raw);
    console.log(
      `[ai] classifier verdict — scenarioRelated=${verdict.isScenarioRelated} ` +
        `appropriate=${verdict.isAppropriate} confidence=${verdict.confidence}`,
    );
    return verdict;
  }

  async authorThreatScenarioMatrix(
    prompt: string,
    roleContext: string,
    vectorCount: number,
    severityMix: SeverityMix,
    signal?: AbortSignal,
  ): Promise<ThreatScenarioMatrix> {
    const raw = await this.completeJson(
      buildScenarioSystemPrompt(vectorCount, severityMix),
      buildScenarioUserPrompt(prompt, roleContext, vectorCount),
      { signal },
    );
    const matrix = parseThreatScenarioMatrix(raw, this.model, toISOStringLocal());
    console.log(
      `[ai] scenario matrix parsed — vectors=${matrix.threatVectors.length} ` +
        `mandates=${matrix.regulatoryMandates.length} systems=${matrix.targetSystems.length}`,
    );
    return matrix;
  }

  // ═══════════════════════════════════════════════════════════════
  // Feature: natural-language auditor
  // ═══════════════════════════════════════════════════════════════

  async toMongoPipeline(question: string): Promise<unknown> {
    const raw = await this.completeJson(
      "You are a MongoDB expert. Convert the question into a MongoDB aggregation " +
        "pipeline. Return JSON with a pipeline array of stages for the sessions collection.",
      question,
      { temperature: 0, maxTokens: 2000 },
    );
    try {
      const parsed = JSON.parse(raw) as { pipeline?: unknown };
      return parsed.pipeline;
    } catch {
      return [];
    }
  }

  async summarizeSessionRecords(question: string, results: unknown): Promise<string> {
    return this.completeText(
      "Summarize these session records in plain English, highlighting the most " +
        "important risks, employees, and actions taken. Max 3 paragraphs.",
      JSON.stringify({ question, results }),
      { temperature: 0.2, maxTokens: 1200 },
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// Process-wide singleton
// ═══════════════════════════════════════════════════════════════════

let singleton: OpenAIProvider | null = null;

export function getAIProvider(config: AppConfig): OpenAIProvider {
  if (!singleton) {
    singleton = new OpenAIProvider(config);
  }
  return singleton;
}

/** Test seam: drop the cached provider. */
export function resetAIProvider(): void {
  singleton = null;
}

// ═══════════════════════════════════════════════════════════════════
// Prompt builders
// ═══════════════════════════════════════════════════════════════════

function buildClassifierSystemPrompt(): string {
  return `You are an automated Chief Information Security Officer (CISO) agent specialised in banking regulation and financial-services compliance. Classify the incoming request to determine whether it is appropriate, meaningful, and related to threat-scenario or compliance-audit authoring.

You are the sole gatekeeper with three duties:

1. CONTENT APPROPRIATENESS — Reject any input containing profanity, hate speech, harassment, sexually explicit content, violent threats, keyboard mashing, or casual greetings.
2. INPUT MEANINGFULNESS — The input must form coherent sentences with clear intent.
3. COMPLIANCE RELEVANCE — Valid prompts describe monitored systems (Core Trading Ledger, SWIFT Gateway, HFT Desk), regulatory mandates (AML, SOX, GDPR, FINRA), threat vectors (token injection, transfer interception, data exfiltration), or insider-threat scenarios.

Respond strictly with a single JSON object:
{
  "isInputMeaningful": boolean,
  "isScenarioRelated": boolean,
  "isAppropriate": boolean,
  "contentFlags": ["PROFANITY" | "VULGARITY" | "HATE_SPEECH" | "SEXUALLY_EXPLICIT" | "GIBBERISH" | "KEYBOARD_MASHING" | "OFF_TOPIC" | "GREETING_ONLY" | "EMPTY_INPUT"],
  "reason": "string explaining the verdict",
  "confidence": number (0-1),
  "detectedDomain": "string (e.g. financial_services, healthcare, unknown)"
}

CRITICAL: If contentFlags contains PROFANITY, VULGARITY, HATE_SPEECH, SEXUALLY_EXPLICIT, GIBBERISH or KEYBOARD_MASHING then isAppropriate MUST be false.
Never include markdown fences or extra text — raw JSON only.`;
}

function buildClassifierUserPrompt(prompt: string, roleContext: string): string {
  return `Classify the following request for Cerberus content appropriateness and compliance relevance.

REQUEST: "${prompt}"
TARGET SYSTEM CONTEXT: "${roleContext}"

First check for inappropriate content, then determine whether this describes a valid financial-compliance or insider-threat scenario request.`;
}

function buildScenarioSystemPrompt(
  vectorCount: number,
  severityMix: SeverityMix,
): string {
  return `You are an automated Chief Information Security Officer (CISO) agent specialised in banking regulation. When an operator requests a threat scenario set, you generate a strictly structured JSON profile of monitored systems, regulatory mandates, threat vectors and penetration scenarios for the Cerberus platform.

Generate a complete profile with EXACTLY ${vectorCount} threat vectors.

Your output MUST be rigorous JSON following this schema:

{
  "metadata": {
    "matrixId": "uuid",
    "generatedAt": "ISO-8601 string",
    "promptTokens": number,
    "completionTokens": number,
    "totalTokens": number,
    "promptFingerprint": "string"
  },
  "targetSystems": [
    {
      "systemId": "string (e.g. ts-core-ledger)",
      "name": "string (e.g. Core Trading Ledger)",
      "criticalityLevel": "tier-1" | "critical" | "high" | "medium" | "low",
      "requiredMandateIds": ["string mandate IDs"],
      "description": "string",
      "examples": ["string examples"]
    }
  ],
  "regulatoryMandates": [
    {
      "mandateId": "string (e.g. aml-001)",
      "name": "string (e.g. Anti-Money Laundering [AML])",
      "description": "string",
      "weight": number (0-1),
      "subMandates": [],
      "regulationCode": "string (e.g. AML, SOX, GDPR, FINRA)"
    }
  ],
  "threatVectors": [
    {
      "vectorId": "string (e.g. tv-token-inject-001)",
      "vectorType": "token_injection" | "transfer_interception" | "data_exfiltration" | "privilege_escalation",
      "title": "string",
      "description": "string (detailed threat scenario)",
      "targetSystemId": "string (references a systemId from targetSystems)",
      "exploitScenario": "string (how an attacker would execute this)",
      "workspaceSeed": "string (realistic banking code placed in the monitored terminal workspace)",
      "detectionRules": [
        {
          "ruleId": "string",
          "signalPattern": "string (telemetry pattern the rule matches)",
          "expectedSignal": "string (expected telemetry verdict when matched)",
          "isBaseline": boolean,
          "evaluationWindowMs": number
        }
      ],
      "expectedRemediation": "string",
      "severity": "low" | "medium" | "high" | "critical",
      "mandateId": "string (references a mandateId from regulatoryMandates)",
      "investigationTimeMinutes": number,
      "riskScore": number (0-100)
    }
  ],
  "penetrationScenarios": [
    {
      "scenarioId": "string",
      "vectorId": "string (references threat vector)",
      "mandateIds": ["string mandate IDs"],
      "scoringFormula": { "type": "weighted_sum" | "all_or_nothing" | "partial_credit", "weights": {} },
      "antiExfiltrationThresholds": {
        "maxPasteEvents": number,
        "maxTimeBetweenKeystrokesMs": number,
        "dataLeakageSimilarityThreshold": number (0-1),
        "behavioralAnomalySensitivity": number (0-1),
        "maxCopyAttempts": number,
        "maxWindowBlurEvents": number
      },
      "description": "string",
      "exploitCode": "string (simulated exploit or transaction wrapper)"
    }
  ]
}

CRITICAL RULES:
1. Use financial-domain terminology — Core Trading Ledger, SWIFT Gateway, HFT Desk, etc.
2. Include a realistic workspaceSeed in each threat vector.
3. Map each threat vector to a real regulatory mandate (AML, SOX, GDPR, FINRA, etc.)
4. Set meaningful antiExfiltrationThresholds for each penetration scenario.
5. Response MUST be raw JSON only — no markdown fences, no explanatory text.
6. Severity distribution: ~${Math.round(severityMix.low * 100)}% low, ~${Math.round(severityMix.medium * 100)}% medium, ~${Math.round(severityMix.high * 100)}% high, ~${Math.round(severityMix.critical * 100)}% critical.`;
}

function buildScenarioUserPrompt(
  prompt: string,
  roleContext: string,
  vectorCount: number,
): string {
  return `Generate a Cerberus threat scenario profile with the following parameters:

REQUEST: "${prompt}"
TARGET SYSTEM CONTEXT: "${roleContext}"
THREAT VECTOR COUNT: ${vectorCount}

Produce the full JSON matrix now.`;
}

function buildRiskSystemPrompt(): string {
  return `You are the Cerberus Guardian — an automated CISO agent monitoring a LIVE employee terminal session for insider-threat and data-exfiltration indicators.

Your task: analyse the provided telemetry and determine whether the employee is exhibiting data-exfiltration behaviour.

Look for:
1. Unauthorized paste events (content copied from external sources)
2. Content similarity with known model completions (assisted-generation signals)
3. Suspicious keystroke patterns (bursts of typing followed by long pauses)
4. Behavioural anomalies indicating external tool usage

Respond STRICTLY with a single JSON object:
{
  "riskAssessmentId": "uuid",
  "sessionId": "string",
  "employeeId": "string",
  "auditId": "string",
  "overallRiskScore": number (0-100),
  "dimensionScores": {
    "dataExfiltration": number (0-100),
    "unauthorizedAccess": number (0-100),
    "policyViolation": number (0-100),
    "amlRedFlag": number (0-100),
    "insiderTrading": number (0-100),
    "soxNonCompliance": number (0-100)
  },
  "flags": [
    {
      "flagType": "string (e.g. HIGH_SIMILARITY, SUSPICIOUS_PASTE, ANOMALOUS_KEYSTROKE_PATTERN)",
      "severity": "low" | "medium" | "high" | "critical",
      "sourceEventId": "string",
      "description": "string (detailed explanation of the anomaly)",
      "confidence": number (0-1),
      "timestamp": "ISO-8601 string"
    }
  ],
  "exfiltrationReport": {
    "overallSimilarity": number (0-1),
    "matchedSnippets": [
      {
        "sourceSnippet": "string (the known reference)",
        "employeeSnippet": "string (the employee's suspicious content)",
        "similarityScore": number,
        "sourceLabel": "string (e.g. gpt-5.6-completion, external-llm-service)"
      }
    ],
    "aiCompletionLikelihood": number (0-1)
  },
  "behavioralAnomalies": [
    {
      "anomalyType": "string",
      "description": "string",
      "evidenceWindowStart": "ISO-8601",
      "evidenceWindowEnd": "ISO-8601",
      "metricValue": number,
      "threshold": number
    }
  ],
  "generatedAt": "ISO-8601 string"
}

CRITICAL: Raw JSON only. No markdown fences, no explanatory text.`;
}

function buildRiskUserPrompt(
  currentCode: string,
  pasteContents: string[],
  keystrokeMetrics: { avgDeltaMs: number; maxDeltaMs: number; minDeltaMs: number },
  referenceCompletions: string[],
): string {
  const truncatedCode =
    currentCode.length > 8000
      ? currentCode.substring(0, 8000) + "\n... [TRUNCATED]"
      : currentCode;

  const pasteStr =
    pasteContents.length > 0
      ? pasteContents
          .map((p, i) => `PASTE ${i + 1}: """${p.substring(0, 2000)}"""`)
          .join("\n\n")
      : "No paste events detected.";

  const refStr =
    referenceCompletions.length > 0
      ? referenceCompletions
          .map((r, i) => `REFERENCE ${i + 1}: """${r.substring(0, 2000)}"""`)
          .join("\n\n")
      : "No reference completions available.";

  return `Analyse this LIVE employee terminal session for insider-threat indicators.

=== EMPLOYEE TERMINAL CONTENT ===
${truncatedCode}

=== PASTE CONTENTS ===
${pasteStr}

=== KEYSTROKE METRICS ===
avgDeltaMs: ${keystrokeMetrics.avgDeltaMs}
maxDeltaMs: ${keystrokeMetrics.maxDeltaMs}
minDeltaMs: ${keystrokeMetrics.minDeltaMs}

=== REFERENCE COMPLETIONS (Known model outputs) ===
${refStr}

Determine the risk level and produce the JSON risk assessment payload.`;
}

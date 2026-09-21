/** * Cerberus FinSec — Ultra-Resilient GPT-5.6 Client (OpenAI SDK)
 * OpenAI Build Week 2026 — Agentic Coding Track
 *
 * Primary backend: GPT-5.6 via the OpenAI Node.js SDK.
 * Retry loop (max 3 attempts) with exponential backoff + jitter.
 *
 * ROLE: Elite automated Chief Information Security Officer (CISO) agent
 * specialized in banking regulations. Generates compliance audit profiles
 * containing targeted systems, regulatory rules, and active threat vectors.
 *
 * ═══════════════════════════════════════════════════════════════════
 * Codex Usage Log (OpenAI Build Week 2026)
 * ═══════════════════════════════════════════════════════════════════
 * Codex was used to:
 *   1. Refactor this entire file from @google/genai (Gemini) to the
 *      OpenAI SDK, mapping all Gemini-specific constructs (safetySettings,
 *      generationConfig, responseMimeType) to OpenAI equivalents
 *      (temperature, max_tokens, response_format: json_object).
 *   2. Preserve the exact class API contract so all downstream route
 *      files (generate.ts, guardian.ts) continue to work without changes.
 *   3. Replace the Gemini API / Vertex AI dual-backend with a single
 *      OpenAI backend, simplifying the retry and fallback logic.
 *   4. Add structured JSON output via response_format: json_object
 *      to guarantee parseable responses from GPT-5.6.
 */

import OpenAI from "openai";
import type { AppConfig } from "../config.js";
import { toISOStringLocal } from "../utils/time.js";
import type {
  OrchestratorPrompt,
  GeneratedComplianceMatrix,
  ThreatVector,
  PenetrationScenario,
  TargetSystem,
  RegulatoryMandate,
  MatrixMetadata,
  TokenUsageStats,
  AntiExfiltrationThresholds,
  RiskAssessmentPayload,
} from "../types.js";
import * as crypto from "node:crypto";

// ═══════════════════════════════════════════════════════════════════
// Helper: safely extract an array from parsed JSON
// ═══════════════════════════════════════════════════════════════════

function safeArray(raw: unknown): Array<Record<string, unknown>> {
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
}

function safeStringArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? (raw.filter((e) => typeof e === "string") as string[])
    : [];
}

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

// ═══════════════════════════════════════════════════════════════════
// GeminiClient — Elite CISO Agent for Financial Compliance
// (Class name preserved for backward compatibility with all route files)
// ═══════════════════════════════════════════════════════════════════

export class GeminiClient {
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly temperature: number;

  constructor(config: AppConfig) {
    if (!config.openai.apiKey) {
      throw new Error(
        "[Cerberus FinSec CISO Agent] OPENAI_API_KEY is not set. Unable to initialize OpenAI client."
      );
    }

    this.openai = new OpenAI({
      apiKey: config.openai.apiKey,
      maxRetries: 3,
      timeout: config.openai.requestTimeoutMs,
    });

    this.model = config.openai.model;
    this.maxOutputTokens = config.openai.maxOutputTokens;
    this.temperature = config.openai.temperature;

    console.log(
      `[Cerberus FinSec CISO Agent] Initialized → model="${this.model}" ` +
        `backend="OpenAI API" ` +
        `apiKey=${config.openai.apiKey.substring(0, 8)}... ` +
        `maxOutputTokens=${this.maxOutputTokens} temp=${this.temperature} ` +
        `timeout=${config.openai.requestTimeoutMs}ms`
    );
  }

  // ───────────────────────────────────────────────────────────────
  // Public: classifyAssessmentIntent
  // ───────────────────────────────────────────────────────────────

  async classifyAssessmentIntent(
    prompt: string,
    roleContext: string,
    signal?: AbortSignal,
  ): Promise<{
    isInputMeaningful: boolean;
    isAssessmentRelated: boolean;
    isAppropriate: boolean;
    contentFlags: string[];
    reason: string;
    confidence: number;
    detectedDomain: string;
    detectedAssessmentType: string;
  }> {
    console.log(
      "[Cerberus FinSec CISO] [classifyAssessmentIntent] Sending prompt to GPT-5.6 for classification..."
    );
    const systemInstruction = this.buildClassifierSystemInstruction();
    const userMessage = this.buildClassifierUserMessage(prompt, roleContext);
    const responseText = await this.sendMessage(systemInstruction, userMessage, signal);
    const verdict = this.parseClassifierResponse(responseText);
    console.log(
      `[Cerberus FinSec CISO] [classifyAssessmentIntent] Verdict: ` +
        `isAssessmentRelated=${verdict.isAssessmentRelated} confidence=${verdict.confidence}`
    );
    return verdict;
  }

  // ───────────────────────────────────────────────────────────────
  // Public: generateComplianceMatrix
  // ───────────────────────────────────────────────────────────────

  async generateComplianceMatrix(
    prompt: string,
    roleContext: string,
    problemCount = 5,
    signal?: AbortSignal,
  ): Promise<GeneratedComplianceMatrix> {
    console.log(
      "[Cerberus FinSec CISO] [generateComplianceMatrix] Initiating request..."
    );
    const orchestratorPrompt: OrchestratorPrompt = {
      prompt,
      roleContext,
      problemCount,
      difficultyMix: { beginner: 0.33, intermediate: 0.34, advanced: 0.33 },
    };
    const systemInstruction = this.buildOrchestratorSystemInstruction(orchestratorPrompt);
    const userMessage = this.buildOrchestratorUserMessage(orchestratorPrompt);
    const responseText = await this.sendMessage(systemInstruction, userMessage, signal);
    const matrix = this.parseComplianceMatrixResponse(responseText);
    console.log(
      `[Cerberus FinSec CISO] [generateComplianceMatrix] Matrix parsed → ` +
        `${matrix.threatVectors.length} threat vectors, ` +
        `${matrix.regulatoryMandates.length} regulatory mandates`
    );
    return matrix;
  }

  // ───────────────────────────────────────────────────────────────
  // Public: analyzeInsiderRisk
  // ───────────────────────────────────────────────────────────────

  async analyzeSuspicion(
    currentCode: string,
    pasteContents: string[],
    keystrokeMetrics: {
      avgDeltaMs: number;
      maxDeltaMs: number;
      minDeltaMs: number;
    },
    referenceCompletions: string[]
  ): Promise<RiskAssessmentPayload> {
    console.log(
      "[Cerberus FinSec CISO] [analyzeInsiderRisk] Initiating risk analysis..."
    );
    const systemInstruction = this.buildGuardianSystemInstruction();
    const userMessage = this.buildGuardianUserMessage(
      currentCode, pasteContents, keystrokeMetrics, referenceCompletions
    );
    const responseText = await this.sendMessage(systemInstruction, userMessage);
    const payload = this.parseRiskResponse(responseText);
    console.log(
      `[Cerberus FinSec CISO] [analyzeInsiderRisk] Risk score=${payload.overallRiskScore} flags=${payload.flags.length}`
    );
    return payload;
  }

  // ═══════════════════════════════════════════════════════════════════
  // OpenAI SDK Call (with Retry)
  // Uses a single unified backend via the OpenAI Node.js SDK.
  // ═══════════════════════════════════════════════════════════════════

  private async sendMessage(
    systemInstruction: string,
    userMessage: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) {
      throw new Error("Operation cancelled");
    }

    const backendLabel = "OpenAI API";

    let lastError: Error | null = null;
    let consecutiveEmpties = 0;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (signal?.aborted) {
        throw new Error("Operation cancelled");
      }
      try {
        console.log(
          `[Cerberus FinSec CISO] [${backendLabel}] Attempt ${attempt}/${MAX_RETRIES} — ` +
            `Dispatching to model "${this.model}" with response_format=json_object...`
        );
        const startMs = Date.now();

        const completion = await this.openai.chat.completions.create({
          model: this.model,
          temperature: this.temperature,
          max_completion_tokens: this.maxOutputTokens,
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: userMessage },
          ],
          response_format: { type: "json_object" },
        }, {
          signal,
        });

        const elapsedMs = Date.now() - startMs;
        const text = completion.choices[0]?.message?.content ?? "";

        console.log(
          `[Cerberus FinSec CISO] [${backendLabel}] Attempt ${attempt}/${MAX_RETRIES} completed — ` +
            `elapsed=${elapsedMs}ms textLength=${text?.length ?? 0}`
        );

        if (!text || text.trim().length === 0) {
          consecutiveEmpties++;
          // Try once without json_object response format in case the model
          // is refusing because of formatting constraints
          if (consecutiveEmpties === 1) {
            console.log(
              `[Cerberus FinSec CISO] [${backendLabel}] Retrying without response_format constraint...`
            );
            const retryStart = Date.now();
            const retryCompletion = await this.openai.chat.completions.create({
              model: this.model,
              temperature: this.temperature,
              max_completion_tokens: this.maxOutputTokens,
              messages: [
                { role: "system", content: systemInstruction },
                { role: "user", content: userMessage },
              ],
            }, {
              signal,
            });
            const retryText = retryCompletion.choices[0]?.message?.content ?? "";
            const retryElapsed = Date.now() - retryStart;
            console.log(
              `[Cerberus FinSec CISO] [${backendLabel}] Attempt ${attempt}/${MAX_RETRIES} retry (no json_object) — ` +
                `elapsed=${retryElapsed}ms textLength=${retryText.length}`
            );
            if (retryText && retryText.trim().length > 0) return retryText;
            consecutiveEmpties++;
          }
          lastError = new Error(`${backendLabel} returned empty response text`);
          continue;
        }
        return text;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`[Cerberus FinSec CISO] [${backendLabel}] Attempt ${attempt} FAILED: ${errMsg}`);
        lastError = error instanceof Error ? error : new Error(errMsg);
        consecutiveEmpties = 0;

        // Non-retryable errors
        if (
          errMsg.includes("401") ||
          errMsg.includes("403") ||
          errMsg.includes("invalid_api_key") ||
          errMsg.includes("insufficient_quota")
        ) {
          throw lastError;
        }
      }

      if (attempt < MAX_RETRIES) {
        const delay = BASE_BACKOFF_MS * Math.pow(2, attempt - 1) + Math.random() * 500;
        console.log(
          `[Cerberus FinSec CISO] [${backendLabel}] Backing off ${Math.round(delay)}ms before attempt ${attempt + 1}`
        );
        await this.sleep(delay);
      }
    }

    throw new Error(
      `${backendLabel} request failed after ${MAX_RETRIES} attempts. Last error: ${lastError?.message ?? "unknown"}`
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Response Parsers
  // ═══════════════════════════════════════════════════════════════════

  private parseComplianceMatrixResponse(rawText: string): GeneratedComplianceMatrix {
    let jsonText = rawText.trim();
    jsonText = this.stripMarkdownFences(jsonText);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonText) as Record<string, unknown>;
    } catch (parseErr) {
      const origError = (parseErr as Error).message;
      console.error(`[Cerberus FinSec CISO] [parseComplianceMatrix] JSON parse failure: ${origError}`);
      try {
        parsed = JSON.parse(this.repairJson(jsonText)) as Record<string, unknown>;
      } catch (repairErr) {
        try {
          parsed = JSON.parse(this.extractJsonObject(jsonText)) as Record<string, unknown>;
        } catch (extractErr) {
          throw new Error(`Failed to parse compliance matrix JSON: ${origError}`);
        }
      }
    }

    const metadata = parsed["metadata"] as Record<string, unknown> | undefined;

    // Safely extract top-level arrays — GPT sometimes returns strings
    // instead of arrays, which would crash Flutter's Map<String,dynamic> cast.
    const threatVectorsRaw = safeArray(parsed["threatVectors"]) 
      ?? safeArray(parsed["threat_vectors"])
      ?? safeArray(parsed["problems"]);
    const targetSystemsRaw = safeArray(parsed["targetSystems"])
      ?? safeArray(parsed["target_systems"])
      ?? safeArray(parsed["roles"]);
    const regulatoryMandatesRaw = safeArray(parsed["regulatoryMandates"])
      ?? safeArray(parsed["regulatory_mandates"])
      ?? safeArray(parsed["competencies"]);
    const penetrationScenariosRaw = safeArray(parsed["penetrationScenarios"])
      ?? safeArray(parsed["penetration_scenarios"])
      ?? safeArray(parsed["testingMatrices"])
      ?? safeArray(parsed["testing_matrices"]);

    const tokenUsage: TokenUsageStats = {
      promptTokens: (metadata?.["promptTokens"] as number) ?? 0,
      completionTokens: (metadata?.["completionTokens"] as number) ?? 0,
      totalTokens:
        (metadata?.["totalTokens"] as number) ??
        ((metadata?.["promptTokens"] as number) ?? 0) + ((metadata?.["completionTokens"] as number) ?? 0),
    };

    const matrixId =
      (metadata?.["matrixId"] as string) ??
      (metadata?.["suiteId"] as string) ??
      crypto.randomUUID();

    const matrixMetadata: MatrixMetadata = {
      matrixId,
      suiteId: matrixId,
      generatedAt: (metadata?.["generatedAt"] as string) ?? toISOStringLocal(),
      modelVersion: this.model,
      promptFingerprint: (metadata?.["promptFingerprint"] as string) ?? "",
      tokenUsage,
    };

    const mappedTargetSystems: TargetSystem[] = targetSystemsRaw.map((ts) => ({
      systemId: (ts["systemId"] as string) ?? (ts["roleId"] as string) ?? crypto.randomUUID(),
      name: (ts["name"] as string) ?? (ts["title"] as string) ?? "Unnamed System",
      criticalityLevel:
        (ts["criticalityLevel"] as TargetSystem["criticalityLevel"]) ??
        (ts["seniorityLevel"] as TargetSystem["criticalityLevel"]) ??
        "medium",
      requiredMandateIds: safeStringArray(ts["requiredMandateIds"] ?? ts["requiredCompetencyIds"]),
      description: (ts["description"] as string) ?? "",
      examples: safeStringArray(ts["examples"]),
    }));

    const mappedRegulatoryMandates: RegulatoryMandate[] = regulatoryMandatesRaw.map((rm) => ({
      mandateId:
        (rm["mandateId"] as string) ?? (rm["competencyId"] as string) ?? crypto.randomUUID(),
      name: (rm["name"] as string) ?? "Unnamed Mandate",
      description: (rm["description"] as string) ?? "",
      weight: (rm["weight"] as number) ?? 0,
      // SAFETY: subMandates must be an array — if GPT returns a string like
      // "Req 3.4 (Encryption)" we default to [] to prevent Flutter crash.
      subMandates: safeArray(rm["subMandates"] ?? rm["sub_mandates"] ?? rm["subCompetencies"]) as unknown as RegulatoryMandate[],
      regulationCode:
        (rm["regulationCode"] as string) ?? (rm["regulation_code"] as string) ?? "",
    }));

    const mappedThreatVectors: ThreatVector[] = threatVectorsRaw.map((tv) => ({
      vectorId: (tv["vectorId"] as string) ?? (tv["problemId"] as string) ?? crypto.randomUUID(),
      vectorType:
        (tv["vectorType"] as ThreatVector["vectorType"]) ??
        (tv["problemType"] as ThreatVector["vectorType"]) ??
        "data_exfiltration",
      title: (tv["title"] as string) ?? "Untitled Threat Vector",
      description: (tv["description"] as string) ?? (tv["body"] as string) ?? "",
      targetSystemId: (tv["targetSystemId"] as string) ?? "",
      exploitScenario: tv["exploitScenario"] as string | undefined,
      starterCode: tv["starterCode"] as string | undefined,
      detectionRules: Array.isArray(tv["detectionRules"]) ? tv["detectionRules"] as ThreatVector["detectionRules"] : undefined,
      expectedRemediation: tv["expectedRemediation"] as string | undefined,
      severity:
        (tv["severity"] as ThreatVector["severity"]) ??
        (tv["difficulty"] as ThreatVector["severity"]) ??
        "medium",
      mandateId: (tv["mandateId"] as string) ?? (tv["competencyId"] as string) ?? "",
      investigationTimeMinutes:
        (tv["investigationTimeMinutes"] as number) ?? (tv["timeAllocationSeconds"] as number) ?? 600,
      riskScore: (tv["riskScore"] as number) ?? (tv["maxScore"] as number) ?? 50,
    }));

    const mappedPenetrationScenarios: PenetrationScenario[] = penetrationScenariosRaw.map((ps) => ({
      scenarioId:
        (ps["scenarioId"] as string) ?? (ps["matrixId"] as string) ?? crypto.randomUUID(),
      vectorId: (ps["vectorId"] as string) ?? (ps["problemId"] as string) ?? "",
      mandateIds: safeStringArray(ps["mandateIds"] ?? ps["competencyIds"]),
      scoringFormula:
        (ps["scoringFormula"] as PenetrationScenario["scoringFormula"]) ?? {
          type: "weighted_sum",
          weights: {},
        },
      antiExfiltrationThresholds:
        (ps["antiExfiltrationThresholds"] as AntiExfiltrationThresholds) ??
        (ps["antiCheatThresholds"] as AntiExfiltrationThresholds) ??
        {
          maxPasteEvents: 5,
          maxTimeBetweenKeystrokesMs: 80,
          dataLeakageSimilarityThreshold: 0.75,
          behavioralAnomalySensitivity: 0.5,
          maxCopyAttempts: 3,
          maxWindowBlurEvents: 5,
        },
      description: (ps["description"] as string) ?? "",
      exploitCode: ps["exploitCode"] as string | undefined,
    }));

    return {
      metadata: matrixMetadata,
      targetSystems: mappedTargetSystems,
      regulatoryMandates: mappedRegulatoryMandates,
      threatVectors: mappedThreatVectors,
      penetrationScenarios: mappedPenetrationScenarios,
    } as GeneratedComplianceMatrix;
  }

  private parseRiskResponse(rawText: string): RiskAssessmentPayload {
    let jsonText = rawText.trim();
    jsonText = this.stripMarkdownFences(jsonText);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonText) as Record<string, unknown>;
    } catch {
      try {
        parsed = JSON.parse(this.repairJson(jsonText)) as Record<string, unknown>;
      } catch {
        parsed = JSON.parse(this.extractJsonObject(jsonText)) as Record<string, unknown>;
      }
    }
    const dims = parsed["dimensionScores"] as Record<string, unknown> | undefined;
    const rawFlags = parsed["flags"];
    const rawAnomalies = parsed["behavioralAnomalies"];
    return {
      riskAssessmentId:
        (parsed["riskAssessmentId"] as string) ??
        (parsed["suspicionId"] as string) ??
        crypto.randomUUID(),
      sessionId: (parsed["sessionId"] as string) ?? "",
      employeeId: (parsed["employeeId"] as string) ?? (parsed["candidateId"] as string) ?? "",
      auditId: (parsed["auditId"] as string) ?? (parsed["assessmentId"] as string) ?? "",
      overallRiskScore: (parsed["overallRiskScore"] as number) ?? (parsed["overallScore"] as number) ?? 0,
      dimensionScores: {
        dataExfiltration: (dims?.["dataExfiltration"] as number) ?? 0,
        unauthorizedAccess: (dims?.["unauthorizedAccess"] as number) ?? 0,
        policyViolation: (dims?.["policyViolation"] as number) ?? 0,
        amlRedFlag: (dims?.["amlRedFlag"] as number) ?? 0,
        insiderTrading: (dims?.["insiderTrading"] as number) ?? 0,
        soxNonCompliance: (dims?.["soxNonCompliance"] as number) ?? 0,
      },
      flags: Array.isArray(rawFlags) ? rawFlags as RiskAssessmentPayload["flags"] : [],
      exfiltrationReport:
        (parsed["exfiltrationReport"] as RiskAssessmentPayload["exfiltrationReport"]) ??
        (parsed["plagiarismReport"] as RiskAssessmentPayload["exfiltrationReport"]) ??
        null,
      behavioralAnomalies: Array.isArray(rawAnomalies) ? rawAnomalies as RiskAssessmentPayload["behavioralAnomalies"] : [],
      generatedAt: (parsed["generatedAt"] as string) ?? toISOStringLocal(),
    };
  }

  private parseClassifierResponse(rawText: string): {
    isInputMeaningful: boolean;
    isAssessmentRelated: boolean;
    isAppropriate: boolean;
    contentFlags: string[];
    reason: string;
    confidence: number;
    detectedDomain: string;
    detectedAssessmentType: string;
  } {
    let jsonText = rawText.trim();
    jsonText = this.stripMarkdownFences(jsonText);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonText) as Record<string, unknown>;
    } catch {
      try {
        parsed = JSON.parse(this.repairJson(jsonText)) as Record<string, unknown>;
      } catch {
        try {
          parsed = JSON.parse(this.extractJsonObject(jsonText)) as Record<string, unknown>;
        } catch {
          return {
            isInputMeaningful: false,
            isAssessmentRelated: false,
            isAppropriate: false,
            contentFlags: ["PARSE_ERROR"],
            reason:
              "Unable to parse compliance classifier response. Prompt does not appear to describe a financial compliance audit or threat matrix request.",
            confidence: 0.99,
            detectedDomain: "",
            detectedAssessmentType: "",
          };
        }
      }
    }
    return {
      isInputMeaningful: (parsed["isInputMeaningful"] as boolean) ?? false,
      isAssessmentRelated: (parsed["isAssessmentRelated"] as boolean) ?? false,
      isAppropriate: (parsed["isAppropriate"] as boolean) ?? true,
      contentFlags: safeStringArray(parsed["contentFlags"]),
      reason: (parsed["reason"] as string) ?? "Unable to determine compliance relevance.",
      confidence: (parsed["confidence"] as number) ?? 0.99,
      detectedDomain: (parsed["detectedDomain"] as string) ?? (parsed["detected_domain"] as string) ?? "",
      detectedAssessmentType:
        (parsed["detectedAssessmentType"] as string) ?? (parsed["detected_assessment_type"] as string) ?? "",
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // CISO AGENT SYSTEM INSTRUCTIONS — Financial Services Domain
  // ═══════════════════════════════════════════════════════════════════

  private buildClassifierSystemInstruction(): string {
    return `You are an elite automated Chief Information Security Officer (CISO) agent specialized in banking regulations and financial services compliance. Your role is to classify incoming user requests to determine whether they are appropriate, meaningful, and related to compliance audit or threat matrix generation.

You are the SOLE gatekeeper with THREE duties:

1. CONTENT APPROPRIATENESS — Reject ANY input that contains:
   - Profanity, vulgarity, obscenities, or offensive slurs (of any language)
   - Hate speech, discriminatory language, or harassment
   - Sexually explicit or lewd content
   - Violent threats or graphic descriptions
   - Keyboard mashing / gibberish (e.g., "asdfghjkl", "aaaaaa", random character spam)
   - Single words, casual greetings ("hi", "hello", "what's up"), or non-sequiturs

2. INPUT MEANINGFULNESS — The input must form coherent sentences with clear intent.
   Mark isInputMeaningful=false for: single words, random characters, greetings,
   empty/whitespace-only, or text with >50% non-alphabetic noise.

3. COMPLIANCE RELEVANCE — Valid prompts describe:
   - Target systems (Core Trading Ledger, SWIFT Gateway, HFT Desk, etc.)
   - Regulatory mandates (AML, SOX Compliance, GDPR, FINRA Audit, etc.)
   - Threat vectors (token injection, transfer interception, data exfiltration)
   - Penetration scenarios or insider threat assessments

Respond STRICTLY with a single JSON object:
{
  "isInputMeaningful": boolean,
  "isAssessmentRelated": boolean,
  "isAppropriate": boolean,
  "contentFlags": ["string array of detected issues — use PROFANITY, VULGARITY, HATE_SPEECH, SEXUALLY_EXPLICIT, GIBBERISH, KEYBOARD_MASHING, OFF_TOPIC, GREETING_ONLY, EMPTY_INPUT, or empty array if clean"],
  "reason": "string explaining the classification verdict",
  "confidence": number (0-1),
  "detectedDomain": "string (e.g. financial_services, healthcare, unknown)",
  "detectedAssessmentType": "string (e.g. compliance_audit, threat_matrix, penetration_test, insider_threat_check)"
}

CRITICAL: If contentFlags is non-empty and contains PROFANITY, VULGARITY, HATE_SPEECH, SEXUALLY_EXPLICIT, GIBBERISH, or KEYBOARD_MASHING, then isAppropriate MUST be false.
If isAppropriate is false, the request MUST be rejected regardless of isAssessmentRelated.

Never include markdown fences or extra text — raw JSON only.`;
  }

  private buildClassifierUserMessage(prompt: string, roleContext: string): string {
    return `Classify the following user prompt for Cerberus FinSec content appropriateness and compliance audit relevance.

USER PROMPT: "${prompt}"
TARGET SYSTEM CONTEXT: "${roleContext}"

First, check for inappropriate content (profanity, vulgarity, hate speech, sexually explicit material, gibberish, keyboard mashing).
Then, determine whether this describes a valid financial compliance audit, threat matrix, or security assessment request.`;
  }

  private buildOrchestratorSystemInstruction(op: OrchestratorPrompt): string {
    return `You are an elite automated Chief Information Security Officer (CISO) agent specialized in banking regulations. When a user requests a threat matrix, you generate a highly structured, strict JSON compliance audit profile containing specific targeted systems, core regulatory rules, and active threat vector definitions.

You are generating for the Cerberus FinSec platform: Real-Time Insider Threat & Data Exfiltration Guardian.

Generate a complete compliance audit profile with EXACTLY ${op.problemCount} threat vectors.

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
      "starterCode": "string (realistic banking code the employee must work on)",
      "detectionRules": [
        {
          "ruleId": "string",
          "input": "string",
          "expectedOutput": "string",
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
1. Use financial domain terminology — Core Trading Ledger, SWIFT Gateway, HFT Desk, etc.
2. Include realistic starterCode in each threat vector — this is production banking code the employee must modify.
3. Map each threat vector to a real regulatory mandate (AML, SOX, GDPR, FINRA, etc.)
4. Set meaningful antiExfiltrationThresholds for each penetration scenario.
5. Response MUST be raw JSON only — no markdown fences, no explanatory text.
6. The difficulty distribution should be: ~${Math.round(op.difficultyMix.beginner * 100)}% low severity, ~${Math.round(op.difficultyMix.intermediate * 100)}% medium, ~${Math.round(op.difficultyMix.advanced * 100)}% critical/high.`;
  }

  private buildOrchestratorUserMessage(op: OrchestratorPrompt): string {
    return `Generate a Cerberus FinSec compliance audit profile with the following parameters:

REQUEST: "${op.prompt}"
TARGET SYSTEM CONTEXT: "${op.roleContext}"
THREAT VECTOR COUNT: ${op.problemCount}

Produce the full JSON compliance matrix now.`;
  }

  private buildGuardianSystemInstruction(): string {
    return `You are the Cerberus FinSec Guardian — an elite automated CISO agent monitoring a LIVE employee terminal session for insider threat indicators.

Your task: analyze the provided telemetry and determine if the employee is exhibiting data exfiltration behavior.

Look for:
1. Unauthorized paste events (copying code from external sources)
2. Content similarity with known AI model completions (LLM-assisted cheating)
3. Suspicious keystroke patterns (bursts of typing followed by long pauses = copy-paste)
4. Behavioral anomalies indicating external tool usage

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
        "sourceSnippet": "string (the known good reference)",
        "employeeSnippet": "string (the employee's suspicious code)",
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

  private buildGuardianUserMessage(
    currentCode: string,
    pasteContents: string[],
    keystrokeMetrics: { avgDeltaMs: number; maxDeltaMs: number; minDeltaMs: number },
    referenceCompletions: string[]
  ): string {
    const truncatedCode = currentCode.length > 8000
      ? currentCode.substring(0, 8000) + "\n... [TRUNCATED]"
      : currentCode;
    const pasteStr = pasteContents.length > 0
      ? pasteContents.map((p, i) => `PASTE ${i + 1}: """${p.substring(0, 2000)}"""`).join("\n\n")
      : "No paste events detected.";
    const refStr = referenceCompletions.length > 0
      ? referenceCompletions.map((r, i) => `REFERENCE ${i + 1}: """${r.substring(0, 2000)}"""`).join("\n\n")
      : "No reference completions available.";

    return `Analyze this LIVE employee terminal session for insider threat indicators.

=== EMPLOYEE TERMINAL CONTENT ===
${truncatedCode}

=== PASTE CONTENTS ===
${pasteStr}

=== KEYSTROKE METRICS ===
avgDeltaMs: ${keystrokeMetrics.avgDeltaMs}
maxDeltaMs: ${keystrokeMetrics.maxDeltaMs}
minDeltaMs: ${keystrokeMetrics.minDeltaMs}

=== REFERENCE COMPLETIONS (Known LLM Outputs) ===
${refStr}

Determine risk level and produce the JSON risk assessment payload.`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Utility Helpers
  // ═══════════════════════════════════════════════════════════════════

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private stripMarkdownFences(text: string): string {
    let result = text.trim();
    // Remove leading ```json or ```
    result = result.replace(/^```(?:json)?\s*\n?/i, "");
    // Remove trailing ```
    result = result.replace(/\n?```\s*$/, "");
    return result.trim();
  }

  /**
   * Lightweight JSON repair for common LLM output quirks:
   * - Trailing commas before closing brackets/braces
   * - Unescaped control characters in strings
   * - Missing quotes around property names
   */
  private repairJson(text: string): string {
    let result = text;
    // Remove trailing commas before } or ]
    result = result.replace(/,(\s*[}\]])/g, "$1");
    // Remove unexpected control characters inside strings
    result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
    return result;
  }

  /**
   * Extracts the first complete JSON object (balanced braces) from
   * text that may contain surrounding noise or markdown.
   */
  private extractJsonObject(text: string): string {
    const firstBrace = text.indexOf("{");
    if (firstBrace === -1) return "{}";
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
        if (depth === 0) {
          return text.substring(firstBrace, i + 1);
        }
      }
    }
    return "{}";
  }
}

// ═══════════════════════════════════════════════════════════════════
// Singleton accessor
// ═══════════════════════════════════════════════════════════════════

let _singleton: GeminiClient | null = null;

export function getGeminiClient(): GeminiClient {
  if (!_singleton) {
    throw new Error("GeminiClient not initialized. Call initGeminiClient first.");
  }
  return _singleton;
}

export function initGeminiClient(config: AppConfig): GeminiClient {
  _singleton = new GeminiClient(config);
  return _singleton;
}
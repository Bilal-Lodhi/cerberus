/**
 * OpenAI Client — Cerberus AI Inference Engine
 *
 * Replaces the former @google/genai (Gemini) client with the OpenAI SDK.
 * All public function signatures are preserved:
 *   - initializeClient()
 *   - generateStructuredContent()
 *   - generateRiskScore()
 *   - explainFlag()
 *   - generateReport()
 *
 * The underlying model is GPT-5.6 (configurable via OPENAI_MODEL_NAME).
 * Authentication is via OPENAI_API_KEY environment variable.
 *
 * ═══════════════════════════════════════════════════════════════════
 * Codex Usage Log (OpenAI Build Week 2026)
 * ═══════════════════════════════════════════════════════════════════
 * Codex was used to:
 *   1. Refactor this entire file from @google/genai to the OpenAI SDK
 *   2. Map Gemini-specific params (generationConfig, safetySettings) to
 *      their OpenAI equivalents (temperature, max_tokens, response_format)
 *   3. Preserve the structured JSON output contract so downstream consumers
 *      (generate routes, guardian agent) work without changes
 *   4. Add retry logic with exponential backoff for rate limiting
 */

import OpenAI from "openai";
import type { AppConfig } from "../config.js";

// ─── Module-level client singleton ─────────────────────────────────

let _openai: OpenAI | null = null;

// ─── Types ─────────────────────────────────────────────────────────

export interface GenerateOptions {
  prompt: string;
  roleContext: string;
  problemCount: number;
  difficultyMix: {
    beginner: number;
    intermediate: number;
    advanced: number;
  };
}

export interface RiskAssessmentInput {
  sessionId: string;
  candidateId: string;
  pasteCount: number;
  keystrokeMetrics: {
    avgDeltaMs: number;
    maxDeltaMs: number;
    minDeltaMs: number;
  };
  currentCode: string;
  hasAnomalousKeystrokes: boolean;
  problemDescription: string;
}

export interface RiskAssessmentOutput {
  overallRiskScore: number; // 0-100
  plagiarismScore: number;
  keystrokeAnomalyScore: number;
  pasteAbuseScore: number;
  incidentSummary: string;
  recommendation: "monitor" | "warn" | "lock";
  flags: string[];
}

export interface FlagExplanationInput {
  flagType: string;
  sessionContext: {
    pasteCount: number;
    keystrokeMetrics: {
      avgDeltaMs: number;
      maxDeltaMs: number;
      minDeltaMs: number;
    };
    anomalyDetected: boolean;
  };
  codeSnippet: string;
}

export interface ReportInput {
  sessionId: string;
  candidateId: string;
  assessmentId: string;
  incidentLog: Array<{
    timestamp: string;
    eventType: string;
    riskScore: number;
    description: string;
  }>;
  finalDisposition: string;
}

// ─── Client Initialization ─────────────────────────────────────────

/**
 * Initializes and returns the OpenAI client singleton.
 * Must be called once at startup (or lazily on first use).
 */
export function initializeClient(config: AppConfig): OpenAI {
  if (_openai) return _openai;

  if (!config.openai.apiKey) {
    throw new Error(
      "[openai-client] OPENAI_API_KEY is not set. Unable to initialize OpenAI client."
    );
  }

  _openai = new OpenAI({
    apiKey: config.openai.apiKey,
    maxRetries: 3,
    timeout: config.openai.requestTimeoutMs,
  });

  console.log(
    `[openai-client] Initialized → model="${config.openai.model}" timeout=${config.openai.requestTimeoutMs}ms`
  );
  return _openai;
}

/**
 * Returns the currently initialized client, or throws if not yet initialized.
 */
function getClient(): OpenAI {
  if (!_openai) {
    throw new Error(
      "[openai-client] Client not initialized. Call initializeClient() first."
    );
  }
  return _openai;
}

// ─── Core Generation ───────────────────────────────────────────────

/**
 * Generic OpenAI chat completion with structured (JSON) output.
 * Used by all higher-level generation functions.
 */
async function chatCompletion(
  systemPrompt: string,
  userPrompt: string,
  config: AppConfig,
  options?: {
    temperature?: number;
    maxTokens?: number;
  }
): Promise<string> {
  const client = getClient();
  const model = config.openai.model;
  const temperature = options?.temperature ?? config.openai.temperature;
  const maxTokens = options?.maxTokens ?? config.openai.maxOutputTokens;

  const response = await client.chat.completions.create({
    model,
    temperature,
    max_completion_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("[openai-client] Empty response from OpenAI API");
  }

  return content;
}

// ─── Retry Wrapper ─────────────────────────────────────────────────

/**
 * Retries a function with exponential backoff.
 * Handles rate limits (429), server errors (5xx), and timeouts.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 3,
  baseDelayMs = 1000
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const status =
        (err as { status?: number }).status ??
        (err as { response?: { status?: number } }).response?.status;

      // Don't retry on 4xx errors (except 429)
      if (status && status >= 400 && status < 500 && status !== 429) {
        throw lastError;
      }

      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        console.warn(
          `[openai-client] ${label} attempt ${attempt}/${maxAttempts} failed (${lastError.message}). Retrying in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}

// ─── Structured Content Generation ─────────────────────────────────

/**
 * Generates a structured coding assessment (problems, test cases, rubrics).
 * Replaces the old Gemini generateAssessment() call.
 */
export async function generateStructuredContent(
  options: GenerateOptions,
  config: AppConfig
): Promise<string> {
  const systemPrompt = `You are an expert technical interviewer and coding assessment designer. 
Generate a structured JSON response containing coding problems for a technical assessment.

The response MUST be valid JSON with this exact structure:
{
  "assessmentTitle": string,
  "problems": [
    {
      "id": string,
      "title": string,
      "description": string,
      "difficulty": "beginner" | "intermediate" | "advanced",
      "starterCode": string,
      "testCases": [
        { "input": string, "expectedOutput": string }
      ],
      "rubric": {
        "correctness": number (0-100),
        "codeQuality": number (0-100),
        "edgeCases": number (0-100)
      }
    }
  ],
  "totalTimeMinutes": number
}`;

  const userPrompt = `Role context: ${options.roleContext}
Generate ${options.problemCount} coding problems with this difficulty distribution:
- Beginner: ${Math.round(options.difficultyMix.beginner * 100)}%
- Intermediate: ${Math.round(options.difficultyMix.intermediate * 100)}%
- Advanced: ${Math.round(options.difficultyMix.advanced * 100)}%

Make problems realistic, production-relevant, and appropriate for the role context.`;

  const result = await withRetry(
    () => chatCompletion(systemPrompt, userPrompt, config),
    "generateStructuredContent"
  );
  return result;
}

// ─── Risk Scoring ──────────────────────────────────────────────────

/**
 * Analyzes a candidate session and returns a risk assessment.
 * This is the core insider-threat detection inference call.
 */
export async function generateRiskScore(
  input: RiskAssessmentInput,
  config: AppConfig
): Promise<RiskAssessmentOutput> {
  const systemPrompt = `You are Cerberus AI, an insider threat detection system. 
Your job is to analyze candidate behavior during a coding assessment and produce a risk score (0-100).

Scoring guidelines:
- Plagiarism: code that appears copy-pasted or mechanically generated
- Keystroke anomalies: typing patterns that suggest automation or non-human behavior
- Paste abuse: excessive copy-paste events suggesting code theft

Respond ONLY with valid JSON matching this structure:
{
  "overallRiskScore": number (0-100),
  "plagiarismScore": number (0-100),
  "keystrokeAnomalyScore": number (0-100),
  "pasteAbuseScore": number (0-100),
  "incidentSummary": string,
  "recommendation": "monitor" | "warn" | "lock",
  "flags": string[]
}`;

  const userPrompt = JSON.stringify({
    sessionId: input.sessionId,
    candidateId: input.candidateId,
    pasteCount: input.pasteCount,
    keystrokeMetrics: input.keystrokeMetrics,
    hasAnomalousKeystrokes: input.hasAnomalousKeystrokes,
    problemDescription: input.problemDescription,
    currentCode: input.currentCode.substring(0, 8000), // truncate to avoid token limits
  });

  const result = await withRetry(
    () => chatCompletion(systemPrompt, userPrompt, config, { temperature: 0.1 }),
    "generateRiskScore"
  );

  const parsed: RiskAssessmentOutput = JSON.parse(result);
  return parsed;
}

// ─── Flag Explanation ──────────────────────────────────────────────

/**
 * Generates a human-readable explanation for a specific security flag.
 */
export async function explainFlag(
  input: FlagExplanationInput,
  config: AppConfig
): Promise<string> {
  const systemPrompt = `You are Cerberus AI, an insider threat detection system.
Explain the security flag in clear, actionable language that a hiring manager or proctor can understand.
Be specific about what was detected, why it's suspicious, and what the recommended next steps are.`;

  const userPrompt = JSON.stringify({
    flagType: input.flagType,
    sessionContext: input.sessionContext,
    codeSnippet: input.codeSnippet.substring(0, 4000),
  });

  const result = await withRetry(
    () => chatCompletion(systemPrompt, userPrompt, config),
    "explainFlag"
  );

  // Parse the JSON response — it should have an "explanation" field
  try {
    const parsed = JSON.parse(result);
    return parsed.explanation ?? result;
  } catch {
    return result;
  }
}

// ─── Report Generation ─────────────────────────────────────────────

/**
 * Generates a comprehensive incident report for a completed session.
 */
export async function generateReport(
  input: ReportInput,
  config: AppConfig
): Promise<string> {
  const systemPrompt = `You are Cerberus AI, an insider threat detection system.
Generate a comprehensive incident report in JSON format with these fields:
{
  "reportTitle": string,
  "executiveSummary": string,
  "timeline": [{ "timestamp": string, "event": string, "severity": "low" | "medium" | "high" | "critical" }],
  "riskBreakdown": { "plagiarism": number, "keystrokeAnomaly": number, "pasteAbuse": number },
  "verdict": "clean" | "suspicious" | "confirmed_threat",
  "recommendations": string[],
  "evidenceLinks": string[]
}`;

  const userPrompt = JSON.stringify({
    sessionId: input.sessionId,
    candidateId: input.candidateId,
    assessmentId: input.assessmentId,
    incidentLog: input.incidentLog,
    finalDisposition: input.finalDisposition,
  });

  const result = await withRetry(
    () => chatCompletion(systemPrompt, userPrompt, config, { temperature: 0.3 }),
    "generateReport"
  );

  return result;
}

// ─── Embeddings (OpenAI replacement for Vertex AI embeddings) ──────

/**
 * Generates an embedding vector for the given text using OpenAI's
 * text-embedding-3-small model. Replaces the former Vertex AI embeddings.
 */
export async function generateEmbedding(
  text: string,
  _config: AppConfig
): Promise<number[]> {
  const client = getClient();

  const response = await withRetry(
    () =>
      client.embeddings.create({
        model: "text-embedding-3-small",
        input: text.substring(0, 8191), // OpenAI token limit
        encoding_format: "float",
      }),
    "generateEmbedding"
  );

  return response.data[0]?.embedding ?? [];
}

/**
 * Computes cosine similarity between two embedding vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/** Public JSON-mode helper for route-specific agent workflows. */
export async function generateJsonResponse(
  systemPrompt: string,
  userPrompt: string,
  config: AppConfig,
  options?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  return withRetry(
    () => chatCompletion(systemPrompt, userPrompt, config, options),
    "generateJsonResponse"
  );
}

/** Public plain-text helper for human-readable summaries. */
export async function generateTextResponse(
  systemPrompt: string,
  userPrompt: string,
  config: AppConfig,
  options?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  const client = getClient();
  const response = await withRetry(
    () => client.chat.completions.create({
      model: config.openai.model,
      temperature: options?.temperature ?? config.openai.temperature,
      max_completion_tokens: options?.maxTokens ?? config.openai.maxOutputTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
    "generateTextResponse"
  );
  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("[openai-client] Empty text response from OpenAI API");
  return content;
}

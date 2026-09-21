/**
 * Route: POST /api/v1/generate + POST /api/v1/guardian/ingest + POST /api/v1/deploy-guardrail
 * Feature 1 — COMPLIANCE POLICY & THREAT MATRIX GENERATOR
 *
 * Accepts a single text prompt and delegates to the Cerberus FinSec
 * CISO Orchestrator Agent backed by GPT-5.6 (OpenAI).
 * Returns a fully structured compliance audit profile with metadata,
 * target systems, regulatory mandates, threat vectors, and penetration scenarios.
 *
 * ═══════════════════════════════════════════════════════════════════
 * ARCHITECTURE — AI is the SOLE gatekeeper for content filtering.
 *
 *   Every input — from "hello" to "generate a Python test" to keyboard
 *   mashing — flows directly to Gemini's classifyAssessmentIntent.
 *   The AI determines isInputMeaningful, isAssessmentRelated, domain,
 *   and confidence. This avoids fragile pattern-matching and lets the
 *   LLM apply genuine semantic understanding to every request.
 *
 *   Reference implementation: agentic-reddit-context-guardian
 *   https://github.com/Bilal-Lodhi/agentic-reddit-context-guardian
 * ═══════════════════════════════════════════════════════════════════
 *
 * ═══════════════════════════════════════════════════════════════════
 * ENTERPRISE HARDENING (2026-05-28):
 *   - MCP grounding operations are wrapped in isolated timeout
 *     trackers to prevent a slow MongoDB Atlas connection from
 *     bottlenecking upstream client requests.
 *   - Deep observability telemetry logs at every pipeline milestone.
 *   - JSON parse errors on the request body are caught and returned
 *     as structured 400 responses instead of crashing the event loop.
 * ═══════════════════════════════════════════════════════════════════
 */

import { Hono } from "hono";
import type { GenerateComplianceMatrixRequest } from "../types.js";
import { GeminiClient } from "../agents/gemini-client.js";
import { loadConfig } from "../config.js";
import { toISOStringLocal } from "../utils/time.js";

// ═══════════════════════════════════════════════════════════════════
// Stage 1: Regex-Based Content Pre-Filter
//
// Catches obvious vulgarity, profanity, keyboard mashing / gibberish,
// and empty/greeting-only inputs BEFORE sending to the AI model.
// This is a fast, deterministic first line of defense.
// ═══════════════════════════════════════════════════════════════════

/** Common profanity/vulgarity patterns (case-insensitive). */
const PROFANITY_PATTERNS = [
  /\bf[u*]ck\b/i,
  /\bsh[i*]t\b/i,
  /\bb[i*]tch\b/i,
  /\ba[s*]{2}\b/i,
  /\b(d[a*]mn?|d[a*]ng?)\b/i,
  /\bd[i*]ck\b/i,
  /\bp[u*]ss[iy*]\b/i,
  /\bc[u*]nt\b/i,
  /\bb[a*]st[a*]rd\b/i,
  /\bwh[o*]re\b/i,
  /\bsl[u*]t\b/i,
  /\bf[a*]g(got)?\b/i,
  /\bn[i*]gg[ae][r]\b/i,
  /\br[e*]t[a*]rd\b/i,
  /\bc[r*]a[p]\b/i,
];

/** Keyboard mashing / gibberish patterns. */
const GIBBERISH_PATTERNS = [
  /^[a-z]{10,}$/i,                         // Single very long word (all letters)
  /(.)\1{8,}/,                              // Same character repeated 9+ times
  /^[^a-z]{10,}$/i,                         // 10+ non-alphabetic chars only
  /^[qwertyuiopasdfghjklzxcvbnm]{12,}$/i,   // Only keyboard-row letters, 12+
  /([aeiou]{5,}|[bcdfghjklmnpqrstvwxyz]{8,})/i, // 5+ vowels or 8+ consonants in a row
];

/**
 * Determines if a prompt is a casual greeting / single word.
 * Returns true if the input is just "hi", "hello", "hey", "sup", etc.
 */
function isGreetingOnly(input: string): boolean {
  const trimmed = input.trim().toLowerCase();
  const greetings = /^(hi|hello|hey|sup|yo|hola|greetings|what.?s up|howdy|heya|heyy|hii|helloo|whats up|what's up)[!.]*$/i;
  return greetings.test(trimmed);
}

/**
 * Stage 1 fast pre-filter result.
 */
interface PreFilterResult {
  passed: boolean;
  reason: string;
  flags: string[];
}

/**
 * Run the fast regex-based pre-filter on the raw prompt.
 */
function runPreFilter(prompt: string): PreFilterResult {
  const trimmed = prompt.trim();

  // Empty / whitespace-only
  if (trimmed.length === 0) {
    return { passed: false, reason: "Input is empty.", flags: ["EMPTY_INPUT"] };
  }

  // Single word / greeting
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount === 1) {
    if (isGreetingOnly(trimmed)) {
      return { passed: false, reason: "Casual greeting detected — not a compliance audit request.", flags: ["GREETING_ONLY"] };
    }
    if (trimmed.length < 3) {
      return { passed: false, reason: "Input too short to be meaningful.", flags: ["GIBBERISH"] };
    }
    // Single short word likely not meaningful, let AI have final say
  }

  // Profanity/Vulgarity check
  for (const pattern of PROFANITY_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { passed: false, reason: "Inappropriate content detected by pre-filter.", flags: ["PROFANITY", "VULGARITY"] };
    }
  }

  // Keyboard mashing / gibberish check
  for (const pattern of GIBBERISH_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { passed: false, reason: "Gibberish or keyboard mashing detected by pre-filter.", flags: ["GIBBERISH", "KEYBOARD_MASHING"] };
    }
  }

  return { passed: true, reason: "Pre-filter passed.", flags: [] };
}

const generateRouter = new Hono();
const config = loadConfig();
const gemini = new GeminiClient(config);

// ─── In-flight request tracking (for user-initiated cancellation) ──
// ACTIVE_CONTROLLERS is keyed by the server-generated requestId (always unique)
// to prevent race conditions when concurrent requests share the same
// client-provided generationRequestId.
// GEN_REQUEST_TO_INTERNAL maps client-visible generationRequestId → internal requestId
// so cancel requests can find the right controller.
const ACTIVE_CONTROLLERS = new Map<string, AbortController>();
const GEN_REQUEST_TO_INTERNAL = new Map<string, string>();

// ─── MCP Grounding Constants ──────────────────────────────────────

/** MCP HTTP Adapter base URL (sidecar on port 3001). */
const MCP_BASE = process.env["MCP_URL"] ?? "http://localhost:3001";

/**
 * Maximum time (ms) the route will wait for an MCP grounding operation
 * before aborting and falling back. This prevents a slow MongoDB Atlas
 * connection from holding the upstream client request hostage.
 */
const MCP_GROUNDING_TIMEOUT_MS = 5_000;

// ═══════════════════════════════════════════════════════════════════
// Pipeline Diagnostics — attached to EVERY response so you can
// see exactly what the AI decided and why.
// ═══════════════════════════════════════════════════════════════════

interface PipelineDiagnostics {
  /** Timestamp when the pipeline started processing */
  startedAt: string;
  /** The raw input after trimming */
  input: string;
  /** ── Stage 1 Pre-Filter ── */
  preFilter: {
    passed: boolean;
    reason: string;
    flags: string[];
  };
  /** ── AI Classifier ── */
  geminiClassifier: {
    executed: boolean;
    elapsedMs: number;
    verdict?: {
      isInputMeaningful: boolean;
      isAssessmentRelated: boolean;
      isAppropriate: boolean;
      contentFlags: string[];
      confidence: number;
      detectedDomain: string;
      detectedAssessmentType: string;
      reason: string;
    };
    /** If the classifier call itself failed */
    error?: string;
  };
}

function buildPipelineDiag(
  startedAt: string,
  input: string,
  preFilter: PipelineDiagnostics["preFilter"],
  geminiClassifier: PipelineDiagnostics["geminiClassifier"],
): PipelineDiagnostics {
  return {
    startedAt,
    input,
    preFilter,
    geminiClassifier,
  };
}

// ─── POST / ───────────────────────────────────────────────────────

generateRouter.post("/", async (c) => {
  const startedAt = toISOStringLocal();
  const requestId =
    c.res.headers.get("X-Correlation-Id") ?? crypto.randomUUID();
  console.log(
    `[Generate Route] [${requestId}] Incoming POST /api/v1/generate request`,
  );

  // ── Step 1: Parse & Validate Request Body ──────────────────────
  let body: GenerateComplianceMatrixRequest;
  try {
    body = await c.req.json<GenerateComplianceMatrixRequest>();
    console.log(
      `[Generate Route] [${requestId}] Body parsed — promptLen=${body.prompt?.length ?? 0} ` +
        `roleContext="${body.roleContext ?? "undefined"}" problemCount=${body.problemCount ?? "default"}`,
    );
  } catch (parseError) {
    console.error(
      `[Generate Route] [${requestId}] JSON parse failure on request body:`,
      parseError,
    );
    return c.json(
      {
        success: false,
        error:
          "Invalid JSON body — request must be valid JSON with 'prompt' and 'roleContext' fields",
        correlationId: requestId,
      },
      400,
    );
  }

  // ── Guard against null, arrays, primitives ──────────────────────
  // `c.req.json()` can return `null` for a literal `null` body or
  // other non-object parse results.  Property access on null would
  // crash the event loop with an unhandled TypeError.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    console.warn(
      `[Generate Route] [${requestId}] Validation failed: body is ${body === null ? "null" : typeof body} (expected object)`,
    );
    return c.json(
      {
        success: false,
        error:
          "Request body must be a valid JSON object with 'prompt' and 'roleContext' fields",
        correlationId: requestId,
      },
      400,
    );
  }

  if (
    !body.prompt ||
    typeof body.prompt !== "string" ||
    body.prompt.trim().length === 0
  ) {
    console.warn(
      `[Generate Route] [${requestId}] Validation failed: missing/empty 'prompt'`,
    );
    return c.json(
      {
        success: false,
        error: "Field 'prompt' is required and must be a non-empty string",
      },
      400,
    );
  }

  if (!body.roleContext || typeof body.roleContext !== "string") {
    console.warn(
      `[Generate Route] [${requestId}] Validation failed: missing 'roleContext'`,
    );
    return c.json(
      {
        success: false,
        error: "Field 'roleContext' is required and must be a string",
      },
      400,
    );
  }

  const problemCount = body.problemCount ?? 5;
  if (problemCount < 1 || problemCount > 25) {
    console.warn(
      `[Generate Route] [${requestId}] Validation failed: problemCount=${problemCount} out of range`,
    );
    return c.json(
      {
        success: false,
        error: "Field 'problemCount' must be between 1 and 25",
      },
      400,
    );
  }

  const difficultyMix = body.difficultyMix ?? {
    beginner: 0.33,
    intermediate: 0.34,
    advanced: 0.33,
  };
  const mixSum =
    difficultyMix.beginner + difficultyMix.intermediate + difficultyMix.advanced;
  if (Math.abs(mixSum - 1.0) > 0.05) {
    console.warn(
      `[Generate Route] [${requestId}] Difficulty mix weights sum to ${mixSum.toFixed(3)} ` +
        `(expected ~1.0). Proceeding anyway.`,
    );
  }

  const trimmedPrompt = body.prompt.trim();

  // ── Step 2a: Stage 1 Regex Pre-Filter ──────────────────────────
  // Fast deterministic check for obvious vulgarity, gibberish, greetings
  // BEFORE sending to the AI model. Saves API cost and provides instant rejection.
  console.log(
    `[Generate Route] [${requestId}] Step 2a — Running regex pre-filter...`,
  );
  const preFilterResult = runPreFilter(trimmedPrompt);
  console.log(
    `[Generate Route] [${requestId}] Pre-filter result: passed=${preFilterResult.passed} ` +
      `flags=[${preFilterResult.flags.join(", ") || "none"}] reason="${preFilterResult.reason}"`,
  );

  if (!preFilterResult.passed) {
    console.warn(
      `[Generate Route] [${requestId}] Pre-filter REJECTED. Flags: [${preFilterResult.flags.join(", ")}]`,
    );

    return c.json(
      {
        success: false,
        error:
          preFilterResult.reason +
          "\n\nSecurity Violation: I am the Cerberus FinSec Insider Threat & Data Exfiltration Guardian. " +
          "Request a compliance audit, threat matrix, or penetration test to proceed.",
        correlationId: requestId,
        preFilterFlags: preFilterResult.flags,
        pipeline: buildPipelineDiag(
          startedAt,
          trimmedPrompt,
          { passed: preFilterResult.passed, reason: preFilterResult.reason, flags: preFilterResult.flags },
          { executed: false, elapsedMs: 0 },
        ),
      },
      422,
    );
  }

  // ── Step 2b: AI Classifier (semantic gatekeeper) ───────────
  // Pre-filter passed — now AI applies genuine semantic understanding
  // to detect inappropriate content, meaning, domain, and assessment relevance.
  console.log(
    `[Generate Route] [${requestId}] Step 2b — Running AI classifyAssessmentIntent...`,
  );

  let classifierDiag: PipelineDiagnostics["geminiClassifier"] = {
    executed: false,
    elapsedMs: 0,
  };

  // ── Register abort controller for cancellation ───────────────
  // Client sends X-Generation-Request-Id header so both sides share
  // the same ID before the request body is streamed, enabling cancel.
  const generationRequestId =
    c.req.header("X-Generation-Request-Id")?.trim() || crypto.randomUUID();
  const abortController = new AbortController();
  // Map BOTH the client-visible generationRequestId AND the server-internal
  // requestId so parallel requests don't collide on the same key.
  ACTIVE_CONTROLLERS.set(requestId, abortController);
  GEN_REQUEST_TO_INTERNAL.set(generationRequestId, requestId);
  console.log(
    `[Generate Route] [${requestId}] Registered abort controller — ` +
      `generationRequestId=${generationRequestId} internalId=${requestId}`,
  );

  try {
    const classifierStartMs = Date.now();
    const verdict = await gemini.classifyAssessmentIntent(
      trimmedPrompt,
      body.roleContext,
      abortController.signal,
    );
    const classifierElapsed = Date.now() - classifierStartMs;

    console.log(
      `[Generate Route] [${requestId}] AI Classifier returned in ${classifierElapsed}ms — ` +
        `isInputMeaningful=${verdict.isInputMeaningful} ` +
        `isAssessmentRelated=${verdict.isAssessmentRelated} ` +
        `isAppropriate=${verdict.isAppropriate} ` +
        `contentFlags=[${verdict.contentFlags?.join(", ") || "none"}] ` +
        `confidence=${verdict.confidence.toFixed(2)} ` +
        `detectedDomain="${verdict.detectedDomain}" ` +
        `detectedAssessmentType="${verdict.detectedAssessmentType}" ` +
        `reason="${verdict.reason}"`,
    );

    classifierDiag = {
      executed: true,
      elapsedMs: classifierElapsed,
      verdict: {
        isInputMeaningful: verdict.isInputMeaningful,
        isAssessmentRelated: verdict.isAssessmentRelated,
        isAppropriate: verdict.isAppropriate,
        contentFlags: verdict.contentFlags ?? [],
        confidence: verdict.confidence,
        detectedDomain: verdict.detectedDomain,
        detectedAssessmentType: verdict.detectedAssessmentType,
        reason: verdict.reason,
      },
    };

    // ── Tiered rejection logic ──
    const classifierErrors: string[] = [];

    // Tier 0: Content Appropriateness (HIGHEST priority)
    if (!verdict.isAppropriate) {
      const flags = verdict.contentFlags?.join(", ") ?? "CONTENT_VIOLATION";
      classifierErrors.push(`isAppropriate=false (flags: ${flags})`);
    }

    if (!verdict.isInputMeaningful) {
      classifierErrors.push("isInputMeaningful=false");
    }
    if (
      verdict.isAppropriate &&
      verdict.isInputMeaningful &&
      !verdict.isAssessmentRelated
    ) {
      classifierErrors.push("isAssessmentRelated=false");
    }
    if (
      verdict.isAppropriate &&
      verdict.isInputMeaningful &&
      verdict.isAssessmentRelated &&
      verdict.confidence < 0.75
    ) {
      classifierErrors.push(
        `confidence=${verdict.confidence}<0.75`,
      );
    }
    if (
      verdict.isAppropriate &&
      verdict.isInputMeaningful &&
      verdict.isAssessmentRelated &&
      (!verdict.detectedDomain ||
        verdict.detectedDomain.trim().length < 3)
    ) {
      classifierErrors.push(
        `detectedDomain="${verdict.detectedDomain || "(empty)"}" (too short/generic)`,
      );
    }

    const classificationRejected = classifierErrors.length > 0;

    if (classificationRejected) {
      const aiReason = verdict.reason || "";
      const tagline =
        "\n\nSecurity Violation: I am the Cerberus FinSec Insider Threat & Data Exfiltration Guardian. " +
        "Request a compliance audit, threat matrix, or penetration test to proceed.";
      const reason = aiReason + tagline;

      console.warn(
        `[Generate Route] [${requestId}] AI Classifier REJECTED. Errors: [${classifierErrors.join(", ")}]`,
      );

      return c.json(
        {
          success: false,
          error: reason,
          correlationId: requestId,
          classificationConfidence: verdict.confidence,
          detectedDomain: verdict.detectedDomain || null,
          contentFlags: verdict.contentFlags ?? [],
          pipeline: buildPipelineDiag(
            startedAt,
            trimmedPrompt,
            { passed: preFilterResult.passed, reason: preFilterResult.reason, flags: preFilterResult.flags },
            classifierDiag,
          ),
        },
        422,
      );
    }

    console.log(
      `[Generate Route] [${requestId}] AI Classifier ACCEPTED. ` +
        `Domain="${verdict.detectedDomain}" Type="${verdict.detectedAssessmentType}"`,
    );
  } catch (classifierError) {
    const classifierMsg =
      classifierError instanceof Error
        ? classifierError.message
        : "Classifier failure";
    console.error(
      `[Generate Route] [${requestId}] AI Classifier FAILED: ${classifierMsg}`,
    );

    classifierDiag = {
      executed: true,
      elapsedMs: 0,
      error: classifierMsg,
    };

    // ── FAIL-CLOSED: If the classifier is unavailable, reject the request ──
    // Previously this was fail-open ("proceeding to generation anyway"),
    // which allowed all content to pass through when the AI was down.
    console.warn(
      `[Generate Route] [${requestId}] Classifier unavailable — rejecting request (fail-closed).`,
    );

    return c.json(
      {
        success: false,
        error:
          "Cerberus FinSec compliance classifier is currently unavailable. " +
          "Your request could not be validated for content appropriateness and compliance relevance. " +
          "Please try again in a moment.\n\n" +
          "Security Violation: I am the Cerberus FinSec Insider Threat & Data Exfiltration Guardian. " +
          "Request a compliance audit, threat matrix, or penetration test to proceed.",
        correlationId: requestId,
        retryable: true,
        pipeline: buildPipelineDiag(
          startedAt,
          trimmedPrompt,
          { passed: preFilterResult.passed, reason: preFilterResult.reason, flags: preFilterResult.flags },
          classifierDiag,
        ),
      },
      503,
    );
  }

  const enrichedPrompt = `${body.prompt}\n\n[Difficulty distribution requested: ${JSON.stringify(difficultyMix)}. Target exactly ${problemCount} problems total.]`;
  console.log(
    `[Generate Route] [${requestId}] Prompt enriched — final length=${enrichedPrompt.length} chars`,
  );

  // ── Step 3: Generate Test Suite ────────────────────────────────
  let mcpCorrelationId = crypto.randomUUID();
  let fingerprint = "";

  try {
    console.log(
      `[Generate Route] [${requestId}] Delegating to GeminiClient (GPT-5.6).generateComplianceMatrix...`,
    );
    const matrixStartMs = Date.now();

    const matrix = await gemini.generateComplianceMatrix(
      enrichedPrompt,
      body.roleContext,
      problemCount,
      abortController.signal,
    );

    const matrixElapsed = Date.now() - matrixStartMs;
    console.log(
      `[Generate Route] [${requestId}] GeminiClient (GPT-5.6) returned matrix in ${matrixElapsed}ms — ` +
        `${matrix.threatVectors.length} threat vectors, ${matrix.regulatoryMandates.length} regulatory mandates`,
    );

    fingerprint = await sha256(body.prompt);
    matrix.metadata.promptFingerprint = fingerprint;
    console.log(
      `[Generate Route] [${requestId}] SHA-256 fingerprint computed — ${fingerprint.substring(0, 12)}...`,
    );

    await persistMatrixViaMCP(matrix, mcpCorrelationId, requestId);

    const response = {
      success: true,
      matrix,
      mcpCorrelationId,
      pipeline: buildPipelineDiag(
        startedAt,
        trimmedPrompt,
        { passed: preFilterResult.passed, reason: preFilterResult.reason, flags: preFilterResult.flags },
        classifierDiag,
      ),
    };

    console.log(
      `[Generate Route] [${requestId}] COMPLETE — 201 Created, correlationId=${mcpCorrelationId}`,
    );
    // Extend response with generationRequestId so the client can cancel
    const responseWithCancel = {
      ...response,
      generationRequestId,
    };
    return c.json(responseWithCancel, 201);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown agent error";
    const stack = error instanceof Error ? error.stack : "";
    console.error(
      `[Generate Route] [${requestId}] FAILURE — ${message}`,
      stack,
    );

    // Check if this was a user-initiated cancellation
    const isCancelled =
      message.includes("cancelled") ||
      message.includes("aborted") ||
      abortController.signal.aborted;

    if (isCancelled) {
      return c.json(
        {
          success: false,
          error: "Generation cancelled. You can resume later.",
          correlationId: requestId,
          cancelled: true,
          pipeline: buildPipelineDiag(
            startedAt,
            trimmedPrompt,
            { passed: preFilterResult.passed, reason: preFilterResult.reason, flags: preFilterResult.flags },
            classifierDiag,
          ),
        },
        200,
      );
    }

    const isAIServiceOverloaded =
      message.includes("request failed after") ||
      message.includes("timed out after") ||
      message.includes("overloaded") ||
      message.includes("API error 503") ||
      message.includes("API error 504") ||
      message.includes("API error 429");

    const statusCode = isAIServiceOverloaded ? 503 : 500;
    const userError = isAIServiceOverloaded
      ? "AI service is currently busy. Please retry in a moment."
      : `Test suite generation failed: ${message}`;

    return c.json(
      {
        success: false,
        error: userError,
        correlationId: requestId,
        retryable: isAIServiceOverloaded,
        pipeline: buildPipelineDiag(
          startedAt,
          trimmedPrompt,
          { passed: preFilterResult.passed, reason: preFilterResult.reason, flags: preFilterResult.flags },
          classifierDiag,
        ),
      },
      statusCode,
    );
  } finally {
    ACTIVE_CONTROLLERS.delete(requestId);
    GEN_REQUEST_TO_INTERNAL.delete(generationRequestId);
    console.log(
      `[Generate Route] [${requestId}] Removed abort controller — generationRequestId=${generationRequestId}`,
    );
  }
});

// ─── POST /cancel ────────────────────────────────────────────────
// Allows the frontend to cancel an in-flight generation request.
// The client receives a generationRequestId field in the streaming
// connection headers, and passes it here to abort the server-side
// Gemini call.

generateRouter.post("/cancel", async (c) => {
  const requestId =
    c.res.headers.get("X-Correlation-Id") ?? crypto.randomUUID();

  let body: { generationRequestId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        success: false,
        error: "Invalid JSON body — request must have a 'generationRequestId' field",
        correlationId: requestId,
      },
      400,
    );
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return c.json(
      {
        success: false,
        error:
          "Request body must be a valid JSON object with a 'generationRequestId' field",
        correlationId: requestId,
      },
      400,
    );
  }

  if (!body.generationRequestId) {
    return c.json(
      {
        success: false,
        error: "Field 'generationRequestId' is required",
        correlationId: requestId,
      },
      400,
    );
  }

  const genRequestId = body.generationRequestId;
  // Resolve client-visible generationRequestId → internal requestId
  const internalId = GEN_REQUEST_TO_INTERNAL.get(genRequestId);
  // Also try direct lookup in case generationRequestId === requestId
  const controller = (internalId && ACTIVE_CONTROLLERS.get(internalId)) 
    ?? ACTIVE_CONTROLLERS.get(genRequestId);

  if (!controller) {
    console.warn(
      `[Generate Route] [${requestId}] Cancel requested for unknown/inactive generation: ${genRequestId}`,
    );
    return c.json(
      {
        success: false,
        error:
          "No active generation found for this request ID. It may have already completed.",
        correlationId: requestId,
      },
      404,
    );
  }

  console.log(
    `[Generate Route] [${requestId}] ABORTING generation ${genRequestId} per user request.`,
  );
  controller.abort();
  // Clean up both maps
  ACTIVE_CONTROLLERS.delete(internalId ?? genRequestId);
  GEN_REQUEST_TO_INTERNAL.delete(genRequestId);

  return c.json({
    success: true,
    message: "Generation cancelled. You can resume later.",
    correlationId: requestId,
  });
});

// ─── MCP Persistence Helper ────────────────────────────────────────

async function persistMatrixViaMCP(
  suite: unknown,
  correlationId: string,
  requestId: string,
): Promise<void> {
  console.log(
    `[MCP Grounding] [${requestId}] Syncing tool payloads → correlationId=${correlationId}`,
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn(
      `[MCP Grounding] [${requestId}] ABORTING after ${MCP_GROUNDING_TIMEOUT_MS}ms — ` +
        `MCP/MongoDB unresponsive. Suite was already returned to client.`,
    );
    controller.abort();
  }, MCP_GROUNDING_TIMEOUT_MS);

  try {
    const mcpStartMs = Date.now();
    const mcpRes = await fetch(`${MCP_BASE}/tools/store_test_suite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        suite,
        correlationId,
        persistedAt: toISOStringLocal(),
      }),
      signal: controller.signal,
    });
    const mcpElapsed = Date.now() - mcpStartMs;

    if (!mcpRes.ok) {
      const errBody = await mcpRes.text().catch(() => "<unreadable>");
      console.error(
        `[MCP Grounding] [${requestId}] Persist failed — HTTP ${mcpRes.status} ` +
          `after ${mcpElapsed}ms: ${errBody.substring(0, 300)}`,
      );
      return;
    }

    const mcpResult = (await mcpRes.json().catch(() => ({}))) as {
      success?: boolean;
      documentId?: string;
    };

    console.log(
      `[MCP Grounding] [${requestId}] Persist SUCCESS in ${mcpElapsed}ms — ` +
        `documentId=${mcpResult.documentId ?? "unknown"}, success=${mcpResult.success ?? false}`,
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      console.error(
        `[MCP Grounding] [${requestId}] Persist TIMED OUT after ${MCP_GROUNDING_TIMEOUT_MS}ms.`,
      );
    } else {
      console.error(
        `[MCP Grounding] [${requestId}] Persist error:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Utility: SHA-256 fingerprint ──────────────────────────────────

async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { generateRouter };
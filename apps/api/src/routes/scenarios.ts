/**
 * Route: POST /api/v1/scenarios
 *
 * Threat scenario authoring. Accepts a natural-language request and delegates
 * to the Cerberus CISO agent, which returns a structured threat scenario
 * matrix: monitored systems, regulatory mandates, threat vectors with
 * detection rules, and penetration scenarios carrying anti-exfiltration
 * thresholds.
 *
 * Pipeline:
 *   Stage 1  deterministic regex pre-filter (empty / greeting / gibberish /
 *            profanity) — fast rejection before any paid inference
 *   Stage 2  AI semantic classifier (fail-closed: an unavailable classifier
 *            rejects rather than admits the request)
 *   Stage 3  scenario generation + MongoDB persistence via the MCP layer
 */

import { Hono } from "hono";
import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { SeverityMix, ThreatScenarioRequest } from "../types.js";
import { getAIProvider } from "../ai/provider.js";
import { LOG_EVENTS, logger } from "../observability/logger.js";
import { currentRequestId } from "../observability/request-context.js";
import { callMcpTool, MCP_TOOL_NAMES } from "../services/mcp-client.js";
import { toISOStringLocal } from "../utils/time.js";

const MCP_GROUNDING_TIMEOUT_MS = 5_000;

/**
 * Maximum accepted length of the operator-authored scenario prompt, in
 * characters.
 *
 * This is a paid-inference boundary, not a storage limit: the prompt is sent to
 * the model verbatim. 8 000 is the same order of magnitude the risk-analysis
 * prompt uses to truncate terminal content, so it is comfortably above any real
 * authoring request while keeping one request from becoming a large bill.
 */
export const MAX_PROMPT_CHARS = 8_000;

/** Maximum accepted length of the target-system context string, in characters. */
export const MAX_ROLE_CONTEXT_CHARS = 200;

// ═══════════════════════════════════════════════════════════════════
// Stage 1 — deterministic content pre-filter
// ═══════════════════════════════════════════════════════════════════

const PROFANITY_PATTERNS = [
  /\bf[u*]ck(?:ing|er|ers|ed|s)?\b/i,
  /\bsh[i*]t(?:ty|ting|s)?\b/i,
  /\bb[i*]tch(?:es|y)?\b/i,
  /\ba[s*]{2}(?:hole|holes)?\b/i,
  /\b(d[a*]mn?|d[a*]ng?)\b/i,
  /\bd[i*]ck\b/i,
  /\bp[u*]ss[iy*]\b/i,
  /\bc[u*]nts?\b/i,
  /\bb[a*]st[a*]rds?\b/i,
  /\bwh[o*]res?\b/i,
  /\bsl[u*]ts?\b/i,
  /\bf[a*]g(got|gots)?\b/i,
  /\bn[i*]gg[ae]rs?\b/i,
  /\br[e*]t[a*]rds?\b/i,
  /\bc[r*]a[p]\b/i,
];

const GIBBERISH_PATTERNS = [
  /^[a-z]{10,}$/i,
  /(.)\1{8,}/,
  /^[^a-z]{10,}$/i,
  /^[qwertyuiopasdfghjklzxcvbnm]{12,}$/i,
  /([aeiou]{5,}|[bcdfghjklmnpqrstvwxyz]{8,})/i,
];

const GREETING_PATTERN =
  /^(hi|hello|hey|sup|yo|hola|greetings|what.?s up|howdy|heya|heyy|hii|helloo|whats up|what's up)[!.]*$/i;

export interface PreFilterResult {
  passed: boolean;
  reason: string;
  flags: string[];
}

export function runPreFilter(prompt: string): PreFilterResult {
  const trimmed = prompt.trim();

  if (trimmed.length === 0) {
    return { passed: false, reason: "Input is empty.", flags: ["EMPTY_INPUT"] };
  }

  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount === 1) {
    if (GREETING_PATTERN.test(trimmed)) {
      return {
        passed: false,
        reason: "Casual greeting detected — not a threat scenario request.",
        flags: ["GREETING_ONLY"],
      };
    }
    if (trimmed.length < 3) {
      return {
        passed: false,
        reason: "Input too short to be meaningful.",
        flags: ["GIBBERISH"],
      };
    }
  }

  for (const pattern of PROFANITY_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        passed: false,
        reason: "Inappropriate content detected by pre-filter.",
        flags: ["PROFANITY", "VULGARITY"],
      };
    }
  }

  for (const pattern of GIBBERISH_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        passed: false,
        reason: "Gibberish or keyboard mashing detected by pre-filter.",
        flags: ["GIBBERISH", "KEYBOARD_MASHING"],
      };
    }
  }

  return { passed: true, reason: "Pre-filter passed.", flags: [] };
}

const DEFAULT_SEVERITY_MIX: SeverityMix = {
  low: 0.25,
  medium: 0.35,
  high: 0.25,
  critical: 0.15,
};

// ═══════════════════════════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════════════════════════

interface ClassifierDiagnostics {
  executed: boolean;
  elapsedMs: number;
  verdict?: {
    isInputMeaningful: boolean;
    isScenarioRelated: boolean;
    isAppropriate: boolean;
    contentFlags: string[];
    confidence: number;
    detectedDomain: string;
    reason: string;
  };
  error?: string;
}

export function createScenariosRouter(config: AppConfig): Hono {
  const scenariosRouter = new Hono();

  // In-flight request tracking for user-initiated cancellation.
  const ACTIVE_CONTROLLERS = new Map<string, AbortController>();
  const REQUEST_ID_TO_INTERNAL = new Map<string, string>();

  scenariosRouter.post("/", async (c) => {
    const startedAt = toISOStringLocal();
    const requestId = currentRequestId();

    // ── Parse & validate ──────────────────────────────────────────
    let body: ThreatScenarioRequest;
    try {
      body = await c.req.json<ThreatScenarioRequest>();
    } catch {
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

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
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

    if (!body.prompt || typeof body.prompt !== "string" || !body.prompt.trim()) {
      return c.json(
        {
          success: false,
          error: "Field 'prompt' is required and must be a non-empty string",
          correlationId: requestId,
        },
        400,
      );
    }

    if (!body.roleContext || typeof body.roleContext !== "string") {
      return c.json(
        {
          success: false,
          error: "Field 'roleContext' is required and must be a string",
          correlationId: requestId,
        },
        400,
      );
    }

    // Length caps come before any inference is spent. The global body limit
    // bounds the request as a whole; these bound the two fields that are sent
    // to a paid provider.
    if (body.prompt.length > MAX_PROMPT_CHARS) {
      return c.json(
        {
          success: false,
          error: `Field 'prompt' must be at most ${MAX_PROMPT_CHARS} characters (got ${body.prompt.length}).`,
          code: "PROMPT_TOO_LONG",
          maxChars: MAX_PROMPT_CHARS,
          correlationId: requestId,
        },
        400,
      );
    }

    if (body.roleContext.length > MAX_ROLE_CONTEXT_CHARS) {
      return c.json(
        {
          success: false,
          error: `Field 'roleContext' must be at most ${MAX_ROLE_CONTEXT_CHARS} characters (got ${body.roleContext.length}).`,
          code: "ROLE_CONTEXT_TOO_LONG",
          maxChars: MAX_ROLE_CONTEXT_CHARS,
          correlationId: requestId,
        },
        400,
      );
    }

    const vectorCount = body.vectorCount ?? 5;
    if (!Number.isInteger(vectorCount) || vectorCount < 1 || vectorCount > 25) {
      return c.json(
        {
          success: false,
          error: "Field 'vectorCount' must be an integer between 1 and 25",
          correlationId: requestId,
        },
        400,
      );
    }

    const severityMix = normalizeSeverityMix(body.severityMix);
    const trimmedPrompt = body.prompt.trim();

    // ── Stage 1: deterministic pre-filter ─────────────────────────
    const preFilter = runPreFilter(trimmedPrompt);
    logger.debug(LOG_EVENTS.SCENARIOS_PREFILTER, {
      passed: preFilter.passed,
      flags: preFilter.flags,
    });

    if (!preFilter.passed) {
      return c.json(
        {
          success: false,
          error:
            `${preFilter.reason}\n\nCerberus authors insider-threat and data-exfiltration ` +
            "scenarios. Describe the monitored systems, regulatory mandates or threat " +
            "vectors you want covered.",
          correlationId: requestId,
          preFilterFlags: preFilter.flags,
        },
        422,
      );
    }

    // ── Stage 2: AI semantic classifier ───────────────────────────
    const generationRequestId =
      c.req.header("X-Generation-Request-Id")?.trim() || randomUUID();
    const abortController = new AbortController();
    // The controller map is keyed on a **server-generated** value, never on the
    // request id. A caller may now choose its own `X-Request-Id`, and two concurrent
    // scenario requests sharing one id would otherwise collide in this map: the second
    // would overwrite the first's controller and the first's `finally` would delete
    // the second's, so a cancel could abort the wrong generation.
    const controllerKey = randomUUID();
    ACTIVE_CONTROLLERS.set(controllerKey, abortController);
    REQUEST_ID_TO_INTERNAL.set(generationRequestId, controllerKey);

    let classifierDiag: ClassifierDiagnostics = { executed: false, elapsedMs: 0 };

    try {
      const classifierStartMs = Date.now();
      const verdict = await getAIProvider(config).classifyScenarioRequest(
        trimmedPrompt,
        body.roleContext,
        abortController.signal,
      );
      const elapsedMs = Date.now() - classifierStartMs;

      classifierDiag = {
        executed: true,
        elapsedMs,
        verdict: {
          isInputMeaningful: verdict.isInputMeaningful,
          isScenarioRelated: verdict.isScenarioRelated,
          isAppropriate: verdict.isAppropriate,
          contentFlags: verdict.contentFlags,
          confidence: verdict.confidence,
          detectedDomain: verdict.detectedDomain,
          reason: verdict.reason,
        },
      };

      const rejection = evaluateVerdict(verdict);
      if (rejection) {
        logger.warn(LOG_EVENTS.SCENARIOS_CLASSIFIER, {
          classification: "rejected",
          reason: rejection,
          confidence: verdict.confidence,
          detectedDomain: verdict.detectedDomain || null,
          dependency: "provider",
        });
        return c.json(
          {
            success: false,
            error:
              `${verdict.reason}\n\nCerberus authors insider-threat and data-exfiltration ` +
              "scenarios. Describe the monitored systems, regulatory mandates or threat " +
              "vectors you want covered.",
            correlationId: requestId,
            classificationConfidence: verdict.confidence,
            detectedDomain: verdict.detectedDomain || null,
            contentFlags: verdict.contentFlags,
            pipeline: { startedAt, preFilter, classifier: classifierDiag },
          },
          422,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Classifier failure";
      classifierDiag = { executed: true, elapsedMs: 0, error: message };

      // FAIL-CLOSED: never author a scenario set that was not validated.
      logger.warn(LOG_EVENTS.SCENARIOS_CLASSIFIER, {
        classification: "unavailable",
        dependency: "provider",
        consequence: "refused-fail-closed",
        error: message,
      });
      return c.json(
        {
          success: false,
          error:
            "The Cerberus scenario classifier is currently unavailable, so the request " +
            "could not be validated. Please retry shortly.",
          correlationId: requestId,
          retryable: true,
          code: "CLASSIFIER_UNAVAILABLE",
          pipeline: { startedAt, preFilter, classifier: classifierDiag },
        },
        503,
      );
    } finally {
      ACTIVE_CONTROLLERS.delete(controllerKey);
      REQUEST_ID_TO_INTERNAL.delete(generationRequestId);
    }

    // ── Stage 3: author the scenario matrix ───────────────────────
    const mcpCorrelationId = randomUUID();

    try {
      const matrix = await getAIProvider(config).authorThreatScenarioMatrix(
        trimmedPrompt,
        body.roleContext,
        vectorCount,
        severityMix,
        abortController.signal,
      );

      matrix.metadata.promptFingerprint = createHash("sha256")
        .update(body.prompt, "utf-8")
        .digest("hex");

      const persisted = await callMcpTool(
        config,
        MCP_TOOL_NAMES.STORE_THREAT_SCENARIO,
        { scenario: matrix, correlationId: mcpCorrelationId, persistedAt: toISOStringLocal() },
        { requestId, timeoutMs: MCP_GROUNDING_TIMEOUT_MS },
      );

      if (!persisted.ok) {
        // Persistence is best-effort: the matrix is still returned to the caller.
        logger.warn(LOG_EVENTS.SCENARIOS_PERSIST_FAILURE, {
          dependency: "mcp",
          classification: "write-failed",
          reason: persisted.error,
        });
      }

      logger.info(LOG_EVENTS.SCENARIOS_COMPLETE, {
        threatVectorCount: matrix.threatVectors.length,
        persisted: persisted.ok,
        dependency: "provider",
      });
      return c.json(
        {
          success: true,
          matrix,
          mcpCorrelationId,
          persisted: persisted.ok,
          generationRequestId,
          pipeline: { startedAt, preFilter, classifier: classifierDiag },
        },
        201,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown agent error";

      const cancelled = message.includes("cancelled") || abortController.signal.aborted;
      if (cancelled) {
        logger.info(LOG_EVENTS.SCENARIOS_FAILURE, {
          classification: "cancelled",
          dependency: "provider",
        });
        return c.json(
          {
            success: false,
            error: "Generation cancelled.",
            correlationId: requestId,
            cancelled: true,
          },
          200,
        );
      }

      const overloaded =
        message.includes("request failed after") ||
        message.includes("timed out after") ||
        message.includes("overloaded") ||
        message.includes("429") ||
        message.includes("503") ||
        message.includes("504");

      // The classification and the retryable verdict, never the prompt or the
      // provider's response body.
      logger.error(LOG_EVENTS.SCENARIOS_FAILURE, {
        classification: overloaded ? "provider-unavailable" : "generation-failed",
        retryable: overloaded,
        dependency: "provider",
        error: message,
      });

      return c.json(
        {
          success: false,
          error: overloaded
            ? "The AI service is currently busy. Please retry shortly."
            : "Threat scenario generation failed.",
          correlationId: requestId,
          retryable: overloaded,
          code: overloaded ? "AI_UNAVAILABLE" : "SCENARIO_GENERATION_FAILED",
        },
        overloaded ? 503 : 500,
      );
    }
  });

  // ── POST /cancel ────────────────────────────────────────────────
  scenariosRouter.post("/cancel", async (c) => {
    const requestId = currentRequestId();

    let body: { generationRequestId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: "Invalid JSON body — expected 'generationRequestId'",
          correlationId: requestId,
        },
        400,
      );
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json(
        {
          success: false,
          error: "Request body must be a JSON object with 'generationRequestId'",
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
    const internalId = REQUEST_ID_TO_INTERNAL.get(genRequestId);
    const controller =
      (internalId ? ACTIVE_CONTROLLERS.get(internalId) : undefined) ??
      ACTIVE_CONTROLLERS.get(genRequestId);

    if (!controller) {
      return c.json(
        {
          success: false,
          error: "No active generation found for this request ID. It may have completed.",
          correlationId: requestId,
        },
        404,
      );
    }

    controller.abort();
    ACTIVE_CONTROLLERS.delete(internalId ?? genRequestId);
    REQUEST_ID_TO_INTERNAL.delete(genRequestId);

    return c.json({ success: true, message: "Generation cancelled.", correlationId: requestId });
  });

  return scenariosRouter;
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

/** Normalises weights to sum to 1.0; falls back to defaults when unusable. */
export function normalizeSeverityMix(raw: unknown): SeverityMix {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_SEVERITY_MIX };
  }

  const source = raw as Record<string, unknown>;
  const read = (key: string): number => {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  };

  const mix: SeverityMix = {
    low: read("low"),
    medium: read("medium"),
    high: read("high"),
    critical: read("critical"),
  };

  const total = mix.low + mix.medium + mix.high + mix.critical;
  if (total <= 0) return { ...DEFAULT_SEVERITY_MIX };

  return {
    low: mix.low / total,
    medium: mix.medium / total,
    high: mix.high / total,
    critical: mix.critical / total,
  };
}

/**
 * Returns a human-readable rejection reason, or null when the verdict admits
 * the request. Tier order matters: appropriateness outranks relevance.
 */
export function evaluateVerdict(verdict: {
  isInputMeaningful: boolean;
  isScenarioRelated: boolean;
  isAppropriate: boolean;
  contentFlags: string[];
  confidence: number;
  detectedDomain: string;
}): string | null {
  if (!verdict.isAppropriate) {
    return `isAppropriate=false (flags: ${verdict.contentFlags.join(", ") || "CONTENT_VIOLATION"})`;
  }
  if (!verdict.isInputMeaningful) return "isInputMeaningful=false";
  if (!verdict.isScenarioRelated) return "isScenarioRelated=false";
  if (verdict.confidence < 0.75) return `confidence=${verdict.confidence}<0.75`;
  if (!verdict.detectedDomain || verdict.detectedDomain.trim().length < 3) {
    return `detectedDomain="${verdict.detectedDomain}" (too short/generic)`;
  }
  return null;
}

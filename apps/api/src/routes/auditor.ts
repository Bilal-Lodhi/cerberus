/**
 * Route: POST /api/v1/auditor/query
 *
 * Natural-language querying over the persisted session records. The model
 * translates the operator's question into a MongoDB aggregation pipeline,
 * which is then applied in-process against records fetched through the MCP
 * persistence layer.
 *
 * The pipeline is NEVER forwarded to MongoDB verbatim: only a small, explicit
 * subset of stages ($match, $sort, $limit) is interpreted, so a model cannot
 * induce an arbitrary database operation.
 *
 * ── Two paid calls, and a durable read between them ───────────────────
 *
 * `toMongoPipeline` builds the pipeline and `summarizeSessionRecords`
 * summarises the result. A `list_sessions` read sits between them, so the gap
 * between the two spends is a network dependency rather than a scheduling one.
 * One route-level idempotency record covers the whole request, which is what
 * makes a retry after a lost response free. See
 * docs/development/paid-operation-state-model.md §3.5.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { LOG_EVENTS, logger } from "../observability/logger.js";
import { currentRequestId } from "../observability/request-context.js";
import { getAIProvider } from "../ai/provider.js";
import { callMcpTool, MCP_TOOL_NAMES } from "../services/mcp-client.js";
import {
  IDEMPOTENCY_KEY_HEADER,
  readIdempotencyKey,
} from "../services/idempotency-key.js";
import {
  FINGERPRINT_VERSION,
  fingerprintAuditorRequest,
} from "../services/request-fingerprint.js";
import {
  beginPaidOperation,
  classifyProviderFailure,
  completePaidOperation,
  failPaidOperation,
  isRetryableFailure,
  stripRequestIdentity,
  withCurrentRequestId,
  type PaidOperationContext,
} from "../services/paid-operation.js";

interface SessionRecord {
  [key: string]: unknown;
  sessionId?: string;
  employeeId?: string;
  overallRiskScore?: number;
}

/**
 * Maximum accepted length of the natural-language audit question, in
 * characters.
 *
 * The question is sent to a paid provider twice (once to build the pipeline,
 * once to summarise the results), so it is bounded before any inference is
 * spent. The global body limit bounds the request as a whole.
 */
export const MAX_QUESTION_CHARS = 2_000;

/**
 * Hard ceiling on the number of records the auditor will hand to the model or
 * return to the caller, whatever the model's pipeline asks for.
 *
 * The model's `$limit` is a suggestion, not a control: `applySafePipeline`
 * ignores unknown stages but a pipeline with no `$limit` at all would otherwise
 * pass every session through. This cap is applied after the pipeline runs.
 */
export const MAX_AUDITOR_RESULTS = 200;

export function createAuditorRouter(config: AppConfig): Hono {
  const auditorRouter = new Hono();

  /**
   * Reads the session list, **reporting whether the store answered**.
   *
   * ── Why this is not just an array ────────────────────────────────────
   *
   * It used to be one: a failed read returned `[]`, which is the same value as a store that
   * answered "no sessions". The route then summarised an empty record set and returned
   * `200` with a plausible-looking answer, so a database outage was presented as an audit
   * finding — "no sessions matched" when in fact nothing was read.
   *
   * That was a truthfulness defect on its own. It became a **correctness** defect once the
   * response started being recorded for replay: a `200` recorded as `completed` would
   * replay that fabricated answer for the whole retention window, and the caller would have
   * no way to tell it apart from a real one. A response is only worth remembering if it is
   * true.
   */
  async function listSessions(
    requestId: string,
  ): Promise<{ ok: true; records: SessionRecord[] } | { ok: false; error: string }> {
    const result = await callMcpTool<{ data?: unknown }>(
      config,
      MCP_TOOL_NAMES.LIST_SESSIONS,
      {},
      { requestId, timeoutMs: 5_000 },
    );

    if (!result.ok) {
      return { ok: false, error: result.error ?? "the session store did not answer" };
    }

    return {
      ok: true,
      records: Array.isArray(result.data?.data)
        ? (result.data?.data as SessionRecord[])
        : [],
    };
  }

  auditorRouter.post("/query", async (c) => {
    const requestId = currentRequestId();

    let body: { question?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { success: false, error: "Invalid JSON body", correlationId: requestId },
        400,
      );
    }

    if (typeof body.question !== "string" || !body.question.trim()) {
      return c.json(
        {
          success: false,
          error: "Field 'question' must be a non-empty string",
          correlationId: requestId,
        },
        400,
      );
    }

    if (body.question.length > MAX_QUESTION_CHARS) {
      return c.json(
        {
          success: false,
          error: `Field 'question' must be at most ${MAX_QUESTION_CHARS} characters (got ${body.question.length}).`,
          code: "QUESTION_TOO_LONG",
          maxChars: MAX_QUESTION_CHARS,
          correlationId: requestId,
        },
        400,
      );
    }

    // ── Idempotency key: validated before anything is claimed ───────
    //
    // After every validation that spends nothing, and before the first paid call. A
    // rejected key is a `400` and **no record is created**, because a rejected key must
    // not consume an operation.
    const idempotencyKey = readIdempotencyKey(c.req.header(IDEMPOTENCY_KEY_HEADER));
    if (idempotencyKey.status === "rejected") {
      return c.json(
        {
          success: false,
          error: idempotencyKey.reason,
          code: "INVALID_IDEMPOTENCY_KEY",
          correlationId: requestId,
        },
        400,
      );
    }

    // ── Idempotency: claim the operation before any money is spent ──
    let operation: PaidOperationContext | undefined;
    if (idempotencyKey.status === "accepted") {
      const decision = await beginPaidOperation(config, {
        routeFamily: "auditor",
        keyHash: idempotencyKey.keyHash,
        // The route passes `question` through untrimmed to both paid calls, so the
        // untrimmed value is what the fingerprint covers.
        fingerprint: fingerprintAuditorRequest({ question: body.question }),
        fingerprintVersion: FINGERPRINT_VERSION,
        keyId: idempotencyKey.keyId,
      });

      if (decision.kind === "conflict") {
        return c.json(
          {
            success: false,
            error:
              "This Idempotency-Key was already used for a different request. Use a new key " +
              "for a different request.",
            code: "IDEMPOTENCY_CONFLICT",
            correlationId: requestId,
          },
          409,
        );
      }

      if (decision.kind === "pending") {
        c.header("Retry-After", String(decision.retryAfterSeconds));
        return c.json(
          {
            success: false,
            error:
              "An operation with this Idempotency-Key is already in progress. Retry " +
              "shortly, or use a new key to start a separate operation.",
            code: "IDEMPOTENCY_IN_PROGRESS",
            retryAfterSeconds: decision.retryAfterSeconds,
            correlationId: requestId,
          },
          409,
        );
      }

      if (decision.kind === "unavailable") {
        return c.json(
          {
            success: false,
            error:
              "The idempotency store is unavailable, so this request was not started and " +
              "nothing was spent. Retry shortly.",
            code: "IDEMPOTENCY_STATE_UNAVAILABLE",
            retryable: true,
            correlationId: requestId,
          },
          503,
        );
      }

      if (decision.kind === "replay") {
        c.header("Idempotency-Replayed", "true");
        return c.json(
          withCurrentRequestId(decision.body, requestId) as never,
          decision.status as never,
        );
      }

      operation = decision.context;
    }

    try {
      const provider = getAIProvider(config);
      const pipeline = await provider.toMongoPipeline(body.question);

      const sessions = await listSessions(requestId);
      if (!sessions.ok) {
        // The store did not answer. Summarising an empty list would present an outage as
        // an audit finding, and recording it would replay that fabricated answer for the
        // whole retention window.
        logger.warn(LOG_EVENTS.AUDITOR_FAILURE, {
          dependency: "mcp",
          classification: "read-failed",
          error: sessions.error,
        });

        if (operation) {
          // Retryable: nothing usable was produced, so a same-key retry re-executes.
          await failPaidOperation(config, operation, "provider-unavailable");
        }

        return c.json(
          {
            success: false,
            error:
              "The session store is unavailable, so this query could not be answered. " +
              "Nothing was read, and no answer is reported.",
            code: "AUDITOR_STORE_UNAVAILABLE",
            retryable: true,
            correlationId: requestId,
          },
          503,
        );
      }

      const matched = applySafePipeline(sessions.records, pipeline);
      // The model's own `$limit` is a suggestion; this ceiling is the control,
      // so a pipeline without one cannot pass every session to the model.
      const records = matched.slice(0, MAX_AUDITOR_RESULTS);
      const summary = await provider.summarizeSessionRecords(body.question, records);

      const successBody = { success: true, summary, raw: records };

      // The operation succeeded, so the record is completed with the response to replay.
      // `summary` and `raw` are the business result; only the request-specific correlation
      // identity is stripped, and this body carries none.
      if (operation) {
        await completePaidOperation(config, operation, {
          status: 200,
          body: stripRequestIdentity(successBody),
        });
      }

      return c.json(successBody);
    } catch (error) {
      logger.failure(LOG_EVENTS.AUDITOR_FAILURE, error, { dependency: "provider" });

      const message = error instanceof Error ? error.message : "auditor query failed";
      const category = classifyProviderFailure(message);

      if (operation) {
        await failPaidOperation(config, operation, category);
      }

      return c.json(
        {
          success: false,
          error: "Auditor query failed.",
          code: "AUDITOR_QUERY_FAILED",
          // Additive: the status and the code are unchanged, and a caller that ignores
          // `retryable` sees exactly what it saw before.
          //
          // `retryable` answers one specific question — *may a retry with the same
          // Idempotency-Key execute again?* — and it is the same predicate the claim uses.
          // It is deliberately not "will retrying help": a provider that rejected the
          // credential is retryable in this sense, because the operation produced nothing
          // and the record must not replay a failure that a fixed credential would clear.
          retryable: isRetryableFailure(category),
          correlationId: requestId,
        },
        500,
      );
    }
  });

  return auditorRouter;
}

/**
 * Applies a whitelisted subset of aggregation stages in-process.
 * Unknown stages are ignored rather than executed.
 */
export function applySafePipeline(
  records: SessionRecord[],
  pipeline: unknown,
): SessionRecord[] {
  if (!Array.isArray(pipeline)) return records;

  let result = [...records];

  for (const stage of pipeline) {
    if (!stage || typeof stage !== "object") continue;

    const match = (stage as { $match?: Record<string, unknown> }).$match;
    if (match && typeof match === "object") {
      result = result.filter((record) =>
        Object.entries(match).every(([key, value]) => {
          const actual = record[key];
          if (value && typeof value === "object") {
            const operators = value as Record<string, unknown>;
            return Object.entries(operators).every(([operator, expected]) => {
              switch (operator) {
                case "$gt":
                  return typeof actual === "number" && actual > Number(expected);
                case "$gte":
                  return typeof actual === "number" && actual >= Number(expected);
                case "$lt":
                  return typeof actual === "number" && actual < Number(expected);
                case "$lte":
                  return typeof actual === "number" && actual <= Number(expected);
                case "$ne":
                  return actual !== expected;
                default:
                  return actual === expected;
              }
            });
          }
          return actual === value;
        }),
      );
    }

    const sort = (stage as { $sort?: Record<string, number> }).$sort;
    if (sort) {
      const [field, direction] = Object.entries(sort)[0] ?? [];
      if (field) {
        // MongoDB convention: -1 is descending, 1 is ascending.
        const sign = Number(direction) < 0 ? -1 : 1;
        result.sort((a, b) => (Number(a[field] ?? 0) - Number(b[field] ?? 0)) * sign);
      }
    }

    const limit = (stage as { $limit?: number }).$limit;
    if (typeof limit === "number" && limit >= 0) {
      result = result.slice(0, limit);
    }
  }

  return result;
}

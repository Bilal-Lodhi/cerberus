/**
 * The paid-operation claim, from the API's side.
 *
 * ── What this module is ───────────────────────────────────────────────
 *
 * The store owns the *protocol* — the insert, the atomic reclaim, the conditional
 * completion — and this module owns the *decision*: given a caller's key and fingerprint,
 * should this request spend money, and what should it answer if not?
 *
 * It is one place rather than two because both paid routes must answer identically. A
 * `/scenarios` request and an `/auditor/query` request that disagreed about what
 * `pending` means, or about which failures may re-execute, would be two different
 * contracts wearing one name.
 *
 * ── The rule that matters most ────────────────────────────────────────
 *
 * **Money is spent only on `execute`.** Every other decision — replay, in progress,
 * conflict, unavailable — is answered without reaching the provider. That is the whole
 * point, and it is why {@link beginPaidOperation} returns a discriminated decision rather
 * than a boolean: a boolean would make "someone else is working on it" and "your key was
 * reused for a different request" both look like "false", and a route that mishandled
 * either would spend.
 *
 * ── Never logged ──────────────────────────────────────────────────────
 *
 * The raw `Idempotency-Key`, either request body, and any provider result. Log lines carry
 * the request id, the route family, the state, the elapsed time, `replay`, and a truncated
 * digest of the key (`keyId`) — see `docs/development/paid-operation-state-model.md` §3.13.
 */

import type { AppConfig } from "../config.js";
import { LOG_EVENTS, logger } from "../observability/logger.js";
import { callMcpTool, MCP_TOOL_NAMES } from "./mcp-client.js";
import { MAX_STORED_RESULT_BYTES } from "./idempotency-limits.js";

/**
 * The MCP-side vocabulary, mirrored here.
 *
 * Same reasoning as `idempotency-limits.ts`: the API does not depend on the MCP package at
 * runtime, so the families and the failure categories are declared on both sides and their
 * agreement is asserted by a test. A copy with a test is a contract.
 */
export const PAID_ROUTE_FAMILIES = ["scenarios", "auditor"] as const;
export type PaidRouteFamily = (typeof PAID_ROUTE_FAMILIES)[number];

export const OPERATION_FAILURE_CATEGORIES = [
  "provider-unavailable",
  "provider-failed",
  "result-persist-failed",
  "result-too-large",
  "cancelled",
  "state-unavailable",
] as const;
export type OperationFailureCategory = (typeof OPERATION_FAILURE_CATEGORIES)[number];

/**
 * The categories for which a same-key retry re-executes.
 *
 * The other two — `result-persist-failed` and `result-too-large` — describe an operation
 * where Cerberus **observed the provider succeed** and then failed to record it. The money
 * is spent, so a same-key retry replays the recorded failure instead, and a caller who wants
 * a different outcome uses a new key. That is the difference between "we do not know whether
 * it spent" and "we know it spent".
 */
export const RETRYABLE_FAILURE_CATEGORIES: readonly OperationFailureCategory[] = [
  "provider-unavailable",
  "provider-failed",
  "cancelled",
];

/** Whether a failure in `category` may be retried by re-executing. */
export function isRetryableFailure(category: OperationFailureCategory): boolean {
  return RETRYABLE_FAILURE_CATEGORIES.includes(category);
}

/**
 * The lease, derived from the provider timeout.
 *
 * Doubling covers the fact that `/scenarios` runs **two** provider calls back to back, each
 * of which may take the full timeout; the margin covers the durable round trips inside the
 * operation. Deriving it rather than configuring it is what makes "the lease expired while
 * a healthy operation was still running" unrepresentable — and that state would mean a
 * second process reclaiming and spending again on an operation that was working.
 */
export const MIN_LEASE_MS = 60_000;
export const MAX_LEASE_MS = 30 * 60_000;
export const LEASE_TIMEOUT_MULTIPLIER = 2;
export const LEASE_MARGIN_MS = 30_000;

/** The lease for a given provider timeout, clamped to the documented bounds. */
export function deriveLeaseMs(providerTimeoutMs: number): number {
  const usable =
    Number.isFinite(providerTimeoutMs) && providerTimeoutMs > 0 ? providerTimeoutMs : 180_000;
  const derived = usable * LEASE_TIMEOUT_MULTIPLIER + LEASE_MARGIN_MS;
  return Math.min(Math.max(Math.round(derived), MIN_LEASE_MS), MAX_LEASE_MS);
}

/** A response a completed — or definitively failed — operation replays. */
export interface PaidOperationResult {
  status: number;
  body: unknown;
}

/** A claim this process owns, and the values every later write is conditional on. */
export interface PaidOperationContext {
  routeFamily: PaidRouteFamily;
  keyHash: string;
  fingerprint: string;
  claimId: string;
  ttlMs: number;
  /** A truncated digest of the key, safe for a log line. */
  keyId: string;
  /** When the claim was made, so completion can report the operation's duration. */
  claimedAtMs: number;
  /** Whether this process claimed the record or reclaimed a stale one. */
  reclaimed: boolean;
}

/** What a route should do with the request. */
export type PaidOperationDecision =
  | { kind: "execute"; context: PaidOperationContext }
  | { kind: "replay"; status: number; body: unknown; state: "completed" | "failed"; resultOmitted?: string }
  | { kind: "pending"; retryAfterSeconds: number }
  | { kind: "conflict" }
  | { kind: "unavailable"; reason: string };

export interface BeginPaidOperationInput {
  routeFamily: PaidRouteFamily;
  keyHash: string;
  fingerprint: string;
  fingerprintVersion: number;
  /** A truncated digest of the key, for logging only. */
  keyId: string;
}

/**
 * Claims the operation, or reports what the existing claim says.
 *
 * Always resolves. A store that cannot be reached is `unavailable`, never `execute`: an
 * unreachable claim store means the mutual exclusion cannot be enforced, and proceeding
 * would spend money on the one request the mechanism cannot protect.
 */
export async function beginPaidOperation(
  config: AppConfig,
  input: BeginPaidOperationInput,
): Promise<PaidOperationDecision> {
  const ttlMs = config.idempotency.ttlSeconds * 1000;
  const leaseMs = deriveLeaseMs(config.openai.requestTimeoutMs);
  const startedAtMs = Date.now();

  const response = await callMcpTool<Record<string, unknown>>(
    config,
    MCP_TOOL_NAMES.CLAIM_PAID_OPERATION,
    {
      routeFamily: input.routeFamily,
      keyHash: input.keyHash,
      fingerprint: input.fingerprint,
      fingerprintVersion: input.fingerprintVersion,
      leaseMs,
      ttlMs,
    },
    { timeoutMs: config.mcp.timeoutMs },
  );

  if (!response.ok || !response.data) {
    logger.warn(LOG_EVENTS.IDEMPOTENCY_STATE_UNAVAILABLE, {
      routeFamily: input.routeFamily,
      keyId: input.keyId,
      dependency: "mcp",
      classification: response.status === null ? "transport" : "non-2xx",
      ...(response.status !== null ? { status: response.status } : {}),
    });
    return {
      kind: "unavailable",
      reason: response.error ?? "the idempotency store did not answer",
    };
  }

  const outcome = String(response.data["outcome"] ?? "");
  const base = {
    routeFamily: input.routeFamily,
    keyId: input.keyId,
    elapsedMs: Date.now() - startedAtMs,
  };

  switch (outcome) {
    case "claimed":
    case "reclaimed": {
      const claimId = response.data["claimId"];
      if (typeof claimId !== "string" || claimId.length === 0) {
        // A claim we cannot address is a claim we cannot complete, which would leave the
        // record `pending` until its lease expired. Refusing to execute is the safe answer.
        logger.warn(LOG_EVENTS.IDEMPOTENCY_STATE_UNAVAILABLE, {
          ...base,
          dependency: "mcp",
          classification: "malformed-claim",
        });
        return { kind: "unavailable", reason: "the claim store returned no claim id" };
      }

      const reclaimed = outcome === "reclaimed";
      logger.info(
        reclaimed ? LOG_EVENTS.IDEMPOTENCY_RECLAIMED : LOG_EVENTS.IDEMPOTENCY_CLAIMED,
        { ...base, state: "pending", replay: false, reclaimed },
      );

      return {
        kind: "execute",
        context: {
          routeFamily: input.routeFamily,
          keyHash: input.keyHash,
          fingerprint: input.fingerprint,
          claimId,
          ttlMs,
          keyId: input.keyId,
          claimedAtMs: Date.now(),
          reclaimed,
        },
      };
    }

    case "replay": {
      const state = response.data["state"] === "failed" ? "failed" : "completed";
      const raw = response.data["result"] as PaidOperationResult | null | undefined;
      const resultOmitted =
        typeof response.data["resultOmitted"] === "string"
          ? response.data["resultOmitted"]
          : undefined;

      // A record with nothing to replay. For a `failed` record that is the store refusing a
      // non-retryable failure without a result, which it does not do — so this is a
      // malformed or hand-edited document rather than a state the protocol produces.
      // Answering `unavailable` is truthful; answering `execute` would spend again.
      if (!raw || typeof raw.status !== "number") {
        logger.warn(LOG_EVENTS.IDEMPOTENCY_STATE_UNAVAILABLE, {
          ...base,
          state,
          dependency: "mcp",
          classification: "missing-result",
        });
        return { kind: "unavailable", reason: "the recorded result is missing" };
      }

      logger.info(LOG_EVENTS.IDEMPOTENCY_REPLAYED, {
        ...base,
        state,
        replay: true,
        ...(resultOmitted ? { resultOmitted } : {}),
      });
      return { kind: "replay", status: raw.status, body: raw.body, state, ...(resultOmitted ? { resultOmitted } : {}) };
    }

    case "pending": {
      const retryAfterSeconds = Number(response.data["retryAfterSeconds"]);
      const bounded = Number.isFinite(retryAfterSeconds)
        ? Math.max(1, Math.ceil(retryAfterSeconds))
        : 1;

      logger.info(LOG_EVENTS.IDEMPOTENCY_PENDING, {
        ...base,
        state: "pending",
        replay: false,
        retryAfterSeconds: bounded,
      });
      return { kind: "pending", retryAfterSeconds: bounded };
    }

    case "conflict": {
      logger.warn(LOG_EVENTS.IDEMPOTENCY_CONFLICT, {
        ...base,
        conflict: true,
        replay: false,
      });
      return { kind: "conflict" };
    }

    default: {
      // An outcome this build does not know. Treating it as `execute` would spend on an
      // answer we could not read; `unavailable` is the only safe reading.
      logger.warn(LOG_EVENTS.IDEMPOTENCY_STATE_UNAVAILABLE, {
        ...base,
        dependency: "mcp",
        classification: "unknown-outcome",
      });
      return { kind: "unavailable", reason: "the claim store returned an unknown outcome" };
    }
  }
}

/**
 * Records a completed operation.
 *
 * `result` is the response to replay, with any request-specific correlation identity
 * removed — a replayed answer must present the *current* request's identity, not the
 * original's.
 *
 * If the serialised result exceeds {@link MAX_STORED_RESULT_BYTES} the record is completed
 * with `resultOmitted` and a small, truthful substitute response instead. That branch is
 * defensive: the auditor's result is structurally bounded far below the ceiling, and a test
 * asserts a maximal payload lands well under it. It is written to be honest if it ever
 * fires rather than to silently re-execute.
 */
export async function completePaidOperation(
  config: AppConfig,
  context: PaidOperationContext,
  result: PaidOperationResult,
): Promise<void> {
  let toStore = result;
  let resultOmitted: string | undefined;

  const serialised = safeSerialise(result.body);
  if (serialised !== null && Buffer.byteLength(serialised, "utf8") > MAX_STORED_RESULT_BYTES) {
    resultOmitted = "too-large";
    toStore = {
      status: 503,
      body: {
        success: false,
        error:
          "This operation completed, but its response was too large to retain for replay. " +
          "Re-executing would spend again, so it is not repeated: retry with a new key if " +
          "the response is needed.",
        code: "IDEMPOTENCY_STATE_UNAVAILABLE",
      },
    };
    logger.warn(LOG_EVENTS.IDEMPOTENCY_FAILED, {
      routeFamily: context.routeFamily,
      keyId: context.keyId,
      state: "completed",
      resultOmitted,
      dependency: "mcp",
    });
  }

  const response = await callMcpTool<Record<string, unknown>>(
    config,
    MCP_TOOL_NAMES.COMPLETE_PAID_OPERATION,
    {
      routeFamily: context.routeFamily,
      keyHash: context.keyHash,
      claimId: context.claimId,
      result: toStore,
      ttlMs: context.ttlMs,
      ...(resultOmitted ? { resultOmitted } : {}),
    },
    { timeoutMs: config.mcp.timeoutMs },
  );

  const fields = {
    routeFamily: context.routeFamily,
    keyId: context.keyId,
    state: "completed",
    replay: false,
    elapsedMs: Date.now() - context.claimedAtMs,
    ...(context.reclaimed ? { reclaimed: true } : {}),
  };

  // `completed: false` means the completion matched no claim: the lease expired and another
  // process reclaimed the record. That means **a second execution exists**, and it is
  // reported rather than swallowed — the one state this mechanism cannot rule out.
  if (!response.ok || response.data?.["completed"] !== true) {
    logger.warn(LOG_EVENTS.IDEMPOTENCY_COMPLETION_LOST, {
      ...fields,
      dependency: "mcp",
      classification: response.ok ? "claim-not-ours" : "write-failed",
    });
    return;
  }

  logger.info(LOG_EVENTS.IDEMPOTENCY_COMPLETED, fields);
}

/**
 * Records a failed operation.
 *
 * `result` is required for a non-retryable category, because such a failure describes an
 * operation Cerberus saw the provider complete: there is no re-execution to offer, so the
 * recorded failure *is* the answer to a same-key retry.
 */
export async function failPaidOperation(
  config: AppConfig,
  context: PaidOperationContext,
  errorCategory: OperationFailureCategory,
  result?: PaidOperationResult,
): Promise<void> {
  const response = await callMcpTool<Record<string, unknown>>(
    config,
    MCP_TOOL_NAMES.FAIL_PAID_OPERATION,
    {
      routeFamily: context.routeFamily,
      keyHash: context.keyHash,
      claimId: context.claimId,
      errorCategory,
      ttlMs: context.ttlMs,
      ...(result ? { result } : {}),
    },
    { timeoutMs: config.mcp.timeoutMs },
  );

  const fields = {
    routeFamily: context.routeFamily,
    keyId: context.keyId,
    state: "failed",
    errorCategory,
    retryable: isRetryableFailure(errorCategory),
    replay: false,
    elapsedMs: Date.now() - context.claimedAtMs,
  };

  if (!response.ok || response.data?.["recorded"] !== true) {
    logger.warn(LOG_EVENTS.IDEMPOTENCY_COMPLETION_LOST, {
      ...fields,
      dependency: "mcp",
      classification: response.ok ? "claim-not-ours" : "write-failed",
    });
    return;
  }

  logger.info(LOG_EVENTS.IDEMPOTENCY_FAILED, fields);
}

/**
 * Strips request-specific identity from a body before it is stored for replay.
 *
 * `correlationId` names *this request*, and a replayed answer that presented the original
 * request's identity as current would be a lie about which request the caller is looking at.
 * The route re-injects the current one on replay.
 *
 * Applied to a shallow copy, so the response the caller is about to receive is untouched.
 */
export function stripRequestIdentity(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const copy = { ...(body as Record<string, unknown>) };
  delete copy["correlationId"];
  return copy;
}

/** `JSON.stringify`, or `null` when the value cannot be serialised. */
function safeSerialise(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/**
 * Puts the **current** request's correlation id on a body that is being replayed.
 *
 * The counterpart of {@link stripRequestIdentity}. A replayed answer must be the original
 * business result — that is the point — while presenting the request the caller is actually
 * making now. Replaying the original's correlation id would tell a client, and an operator
 * reading a log, that this response belongs to a request that has already finished.
 */
export function withCurrentRequestId(body: unknown, requestId: string): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  return { ...(body as Record<string, unknown>), correlationId: requestId };
}

/** The classification a route reports for a provider failure, from its message. */
export function classifyProviderFailure(message: string): OperationFailureCategory {
  const unavailable =
    message.includes("request failed after") ||
    message.includes("timed out after") ||
    message.includes("overloaded") ||
    message.includes("429") ||
    message.includes("503") ||
    message.includes("504");

  return unavailable ? "provider-unavailable" : "provider-failed";
}

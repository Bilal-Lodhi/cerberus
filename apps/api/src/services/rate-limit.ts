/**
 * In-process request rate limiting.
 *
 * ── What this is ──────────────────────────────────────────────────────
 *
 * A backstop against a runaway client, a retry loop or an accidental burst. It is
 * **not** DDoS defence, and the documentation says so rather than implying
 * otherwise. It runs in one process with no shared state, so a deployment with N
 * replicas enforces up to N times the configured limit.
 *
 * ── Why token buckets ─────────────────────────────────────────────────
 *
 * Two numbers per bucket and no per-request storage: memory is bounded regardless
 * of traffic, refill is smooth rather than bursty at a window boundary, and the
 * decision is a pure function of the injected clock — so the boundary is asserted
 * exactly in tests and nothing sleeps.
 *
 * ── Why a bucket is a category, not a caller ──────────────────────────
 *
 * Cerberus has one shared operator key and no per-caller identity, so there is no
 * caller to key on: keying on the credential would produce a single global bucket
 * per category anyway. The limiter therefore bounds the **total** request rate per
 * category. Per-caller limiting needs per-caller identity, which the OSS baseline
 * does not have; it is a reverse-proxy concern.
 *
 * `X-Forwarded-For` is deliberately **not** trusted. Behind a proxy it is
 * caller-controlled unless the proxy is configured to overwrite it, and behind no
 * proxy it is meaningless. Trusting it would let a caller mint a fresh bucket per
 * request, which is worse than not limiting at all.
 *
 * ── Where it runs ─────────────────────────────────────────────────────
 *
 * **After authentication.** A limiter placed before auth would let an
 * unauthenticated caller exhaust a category's bucket and deny service to the
 * legitimate operator — turning a backstop into a denial-of-service amplifier.
 * Unauthenticated flooding is therefore a reverse-proxy concern, and the threat
 * model already records "no brute-force lockout or alerting" as an accepted
 * limitation.
 */

import { systemClock, type Clock } from "./session-liveness.js";

/** Route categories, ordered by how expensive a request is. */
export type RateLimitCategory = "ai" | "ingest" | "mutation" | "read";

export interface RateLimitPolicy {
  /** Requests allowed in a burst. */
  limit: number;
  /** Window the limit is expressed over. */
  windowMs: number;
}

/**
 * Default policies, in requests per minute.
 *
 * These are backstops, not tuned production values. They are constants rather than
 * five more environment variables because changing them is not an operational
 * need: the only one an operator is likely to want to raise is the AI limit, and
 * that one is configurable (`CERBERUS_AI_REQUESTS_PER_MINUTE`).
 */
export const RATE_LIMIT_POLICIES: Record<RateLimitCategory, RateLimitPolicy> = {
  /**
   * AI-backed endpoints. Every request spends money, so this is a cost control as
   * much as an abuse control. Ten a minute is far above one operator authoring
   * scenarios by hand and far below a loop that would run up a bill.
   */
  ai: { limit: 10, windowMs: 60_000 },
  /**
   * Telemetry ingestion. The console sends one event per request, so this is well
   * above a human typing rate while still bounding a runaway client.
   */
  ingest: { limit: 600, windowMs: 60_000 },
  /** State changes: corpus mutation, identity registration, session lifecycle. */
  mutation: { limit: 60, windowMs: 60_000 },
  /** Reads. */
  read: { limit: 300, windowMs: 60_000 },
};

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until one request becomes available. 0 when allowed. */
  retryAfterSeconds: number;
  /** The bucket's burst limit, for the `X-RateLimit-Limit` header. */
  limit: number;
  /** Whole requests remaining after this decision. */
  remaining: number;
}

export interface RateLimiter {
  check(category: RateLimitCategory, policy?: RateLimitPolicy): RateLimitDecision;
  /** Number of buckets held. Exposed so a test can assert memory is bounded. */
  readonly trackedBuckets: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimiterOptions {
  /** Time source. Defaults to the system clock; tests inject a manual one. */
  clock?: Clock;
  /** Policy overrides, merged over {@link RATE_LIMIT_POLICIES}. */
  policies?: Partial<Record<RateLimitCategory, RateLimitPolicy>>;
}

/**
 * Builds a token-bucket limiter.
 *
 * Memory is bounded by construction: one bucket per category, because the category
 * is the key. There is no map that grows with traffic and nothing to evict.
 */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const clock = options.clock ?? systemClock;
  const policies: Record<RateLimitCategory, RateLimitPolicy> = {
    ...RATE_LIMIT_POLICIES,
    ...options.policies,
  };
  const buckets = new Map<RateLimitCategory, Bucket>();

  return {
    check(category, policyOverride) {
      const policy = policyOverride ?? policies[category];
      const now = clock.now();

      // Tokens added per millisecond. A zero or negative limit would make this
      // non-positive and every division below meaningless, so it is refused rather
      // than silently producing `Infinity`.
      const refillPerMs = policy.limit / policy.windowMs;
      if (!Number.isFinite(refillPerMs) || refillPerMs <= 0) {
        return { allowed: false, retryAfterSeconds: 60, limit: policy.limit, remaining: 0 };
      }

      let bucket = buckets.get(category);
      if (!bucket) {
        bucket = { tokens: policy.limit, lastRefillMs: now };
        buckets.set(category, bucket);
      }

      // `Math.max(0, ...)` so a clock that moves backwards cannot mint tokens.
      const elapsedMs = Math.max(0, now - bucket.lastRefillMs);
      bucket.tokens = Math.min(policy.limit, bucket.tokens + elapsedMs * refillPerMs);
      bucket.lastRefillMs = now;

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return {
          allowed: true,
          retryAfterSeconds: 0,
          limit: policy.limit,
          remaining: Math.floor(bucket.tokens),
        };
      }

      const msUntilToken = (1 - bucket.tokens) / refillPerMs;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(msUntilToken / 1000)),
        limit: policy.limit,
        remaining: 0,
      };
    },

    get trackedBuckets() {
      return buckets.size;
    },
  };
}

/**
 * The category a request belongs to, or `null` when it is exempt.
 *
 * Liveness is exempt on purpose: a probe that is rate limited looks like a dead
 * service, and the whole point of the endpoint is to answer that question.
 */
export function categorizeRequest(
  method: string,
  path: string,
): RateLimitCategory | null {
  const upperMethod = method.toUpperCase();

  if (path === "/" || path === "/health" || path === "/ready") return null;

  // AI-backed: the two endpoints that spend money on inference.
  if (path === "/api/v1/scenarios" && upperMethod === "POST") return "ai";
  if (path === "/api/v1/auditor/query" && upperMethod === "POST") return "ai";

  // Telemetry has its own, much higher ceiling.
  if (path === "/api/v1/guardian/ingest" && upperMethod === "POST") return "ingest";

  if (upperMethod === "GET" || upperMethod === "HEAD" || upperMethod === "OPTIONS") {
    return "read";
  }

  return "mutation";
}

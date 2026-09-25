/**
 * Liveness and readiness.
 *
 * These answer different questions, and conflating them is a real operational
 * hazard:
 *
 *   - **Liveness** (`/health`): "is this process running and able to answer HTTP?"
 *     It must not check dependencies. A liveness probe that fails when MongoDB is
 *     down causes the orchestrator to restart a perfectly healthy process, in a
 *     loop, while the actual outage continues — making a dependency failure worse.
 *   - **Readiness** (`/ready`): "can this instance serve requests that need the
 *     persistence layer?" It *must* check dependencies, so a load balancer stops
 *     routing traffic to an instance that cannot store anything.
 *
 * Before this module the API had only `/health`, which returned `healthy`
 * unconditionally. A deployment whose MCP sidecar was down reported itself healthy
 * and accepted telemetry it could not persist.
 *
 * ── Why the probe is cached ───────────────────────────────────────────
 *
 * A readiness endpoint is polled continuously by every orchestrator and load
 * balancer, and each probe would otherwise become a round trip to the persistence
 * layer — so the monitoring would add load in proportion to how closely it is
 * watched. The result is cached for a short window, and concurrent callers share a
 * single in-flight check rather than each starting their own.
 */

import { toISOStringLocal } from "../utils/time.js";
import { systemClock, type Clock } from "./session-liveness.js";

export type DependencyState = "up" | "down";

export interface DependencyStatus {
  name: string;
  state: DependencyState;
  /** One line explaining a `down` state. Never contains configuration values. */
  detail?: string;
  /** How long the check took, in milliseconds. */
  latencyMs?: number;
}

export interface ReadinessReport {
  ready: boolean;
  checkedAt: string;
  /** True when this report came from the cache rather than a fresh check. */
  cached: boolean;
  dependencies: DependencyStatus[];
}

/** A dependency check: resolves when up, throws when down. */
export type DependencyCheck = () => Promise<void>;

export interface ReadinessProbeOptions {
  name: string;
  check: DependencyCheck;
  clock?: Clock;
  /** How long a result is reused. Default 2000 ms. */
  cacheMs?: number;
  /** How long a check may take before it counts as down. Default 2000 ms. */
  timeoutMs?: number;
}

export interface ReadinessProbe {
  (): Promise<ReadinessReport>;
}

/**
 * Wraps a dependency check with a deadline, a cache and single-flight.
 *
 * Never throws: a probe that throws is a probe that returns a 500, and a 500 is
 * not a readiness answer. A failed check is reported as a `down` dependency.
 */
export function createReadinessProbe(options: ReadinessProbeOptions): ReadinessProbe {
  const clock = options.clock ?? systemClock;
  const cacheMs = options.cacheMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 2_000;

  let cached: ReadinessReport | null = null;
  let cachedAtMs = 0;
  let inFlight: Promise<ReadinessReport> | null = null;

  async function checkOnce(): Promise<ReadinessReport> {
    const startedAtMs = clock.now();
    let dependency: DependencyStatus;

    try {
      await withDeadline(options.check(), timeoutMs);
      dependency = {
        name: options.name,
        state: "up",
        latencyMs: Math.max(0, clock.now() - startedAtMs),
      };
    } catch (error) {
      dependency = {
        name: options.name,
        state: "down",
        detail: error instanceof Error ? error.message : "unknown error",
        latencyMs: Math.max(0, clock.now() - startedAtMs),
      };
    }

    return {
      ready: dependency.state === "up",
      checkedAt: toISOStringLocal(new Date(clock.now())),
      cached: false,
      dependencies: [dependency],
    };
  }

  return async function probe(): Promise<ReadinessReport> {
    const now = clock.now();
    if (cached && now - cachedAtMs < cacheMs) {
      return { ...cached, cached: true };
    }

    // Single-flight: a burst of probes shares one check rather than each starting
    // its own, so being watched closely does not multiply the load.
    if (inFlight) return inFlight;

    inFlight = checkOnce()
      .then((report) => {
        cached = report;
        cachedAtMs = clock.now();
        return report;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };
}

/**
 * Rejects when `work` does not settle within `timeoutMs`.
 *
 * Uses an explicit referenced timer rather than `AbortSignal.timeout()`, which
 * schedules an **unref'd** timer: when the deadline is the only pending work it
 * never fires, and the process exits with the promise still unresolved. That was
 * observed as a CI-only test failure.
 *
 * The abandoned promise is deliberately not cancelled — the caller has stopped
 * waiting, and the underlying call has its own deadline from the MCP client.
 */
export async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

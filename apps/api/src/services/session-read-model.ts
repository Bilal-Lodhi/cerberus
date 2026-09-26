/**
 * The durable session read model.
 *
 * ── Why this is one module ────────────────────────────────────────────
 *
 * Four surfaces answer questions about the same session: the live list, the live detail,
 * the review list and the review detail. Each of them reads a durable session document,
 * and before this module each read it with its own expression. They disagreed:
 *
 *   - the live detail's registry branch reported zero for every counter, so a session
 *     deployed before a restart reported `eventCount: 0` there while the live list
 *     reported the durable total;
 *   - the review detail reported no counters at all, so the console re-derived them by
 *     counting the **timeline** — which is capped at 500 events, so a session with more
 *     than 500 events was under-reported on the review panel;
 *   - the review detail reported `flagged` under `status`, a derived disposition, while
 *     the review list reported the lifecycle status for the same session.
 *
 * One reader means one answer. Every field is read through a tolerant reader, so a
 * document holding a legacy field name or an unusable value is reported the same way
 * wherever it is read.
 *
 * ── The three vocabularies this module does not conflate ──────────────
 *
 *   DURABLE      `monitored_sessions.status`: `active`, `locked`, `terminated`.
 *   DISPOSITION  what the evidence suggests — `flagged`, `investigating` — derived at
 *                read time and never persisted. See `ReviewDisposition` in `types.ts`.
 *   LIVENESS     `active` or `expired`, derived from the activity instant and
 *                `SESSION_TTL_SECONDS`. Never persisted; never a status.
 *
 * See `docs/development/read-model.md`.
 */

import { normalizeStatus, type PersistedSessionStatus } from "./session-status.js";
import { toISOStringLocal } from "../utils/time.js";

/**
 * Reads a finite, non-negative counter from an untyped durable document.
 *
 * Stricter than a cast: a string `"5"` or a negative value reads as `0` rather than
 * being propagated. Every counter on a session document is written by the store as a
 * number, so a value of another shape is a data-integrity signal, not a total to trust.
 */
export function readDurableCounter(
  durable: Record<string, unknown> | null,
  key: string,
): number {
  const value = durable?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Reads the focus-loss counter, tolerating the deprecated field name.
 *
 * The counter used to be stored as `fullscreenExitCount`, which described one of the two
 * events that incremented it — `WINDOW_BLUR` counted as a fullscreen exit. Migration
 * `0003` renames it. This fallback means a deployment that has not run the migration
 * still reports the right number rather than zero, and takes the **larger** of the two so
 * a document holding both cannot lose the higher total.
 */
export function readFocusLossCount(durable: Record<string, unknown> | null): number {
  return Math.max(
    readDurableCounter(durable, "focusLossCount"),
    readDurableCounter(durable, "fullscreenExitCount"),
  );
}

/** Reads a non-empty string field from an untyped durable document, or `null`. */
export function readDurableString(
  source: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The durable-derived fields of a session, read from its document. */
export interface DurableSessionView {
  sessionId: string;
  employeeId: string;
  /** The scenario matrix id, tolerating the legacy `auditId` spelling. */
  matrixId: string;
  targetSystem: string;
  /** The lifecycle status, normalised onto the known vocabulary. */
  status: PersistedSessionStatus;
  /** `deployedAt`, falling back to `createdAt`. */
  deployedAt: string;
  /** `updatedAt` — the durable, server-written activity instant. */
  lastActivityAt: string;
  /** `peakRiskScore`, falling back to the older spellings. */
  riskScore: number;
  eventCount: number;
  pasteCount: number;
  tabSwitchCount: number;
  focusLossCount: number;
  copyAttemptCount: number;
}

/**
 * Reads the durable view of a session document.
 *
 * `deployedAt` falls back to `createdAt` and then to the current instant. A document with
 * neither is malformed — `create_session` always writes one — and a fabricated but
 * plausible instant is a smaller problem than a missing one on a display surface. The
 * live list has always done this; sharing the reader is what makes the surfaces agree.
 *
 * The returned `riskScore` is `peakRiskScore` when the document holds it. That field is
 * maintained with `$max` on every ingest, so it is monotonic and survives a restart —
 * which is why it, and not a re-derived maximum over the assessments, is the durable
 * answer to "how risky did this session get".
 */
export function readDurableSessionView(
  document: Record<string, unknown>,
  sessionId: string,
): DurableSessionView {
  const deployedAt = String(
    document["deployedAt"] ?? document["createdAt"] ?? toISOStringLocal(),
  );

  return {
    sessionId,
    employeeId: String(document["employeeId"] ?? "unknown"),
    matrixId: String(document["matrixId"] ?? document["auditId"] ?? ""),
    targetSystem: String(document["targetSystem"] ?? ""),
    status: normalizeStatus(String(document["status"] ?? "active")),
    deployedAt,
    lastActivityAt: String(document["updatedAt"] ?? deployedAt),
    riskScore: Number(
      document["peakRiskScore"] ??
        document["overallRiskScore"] ??
        document["riskIndex"] ??
        0,
    ),
    eventCount: readDurableCounter(document, "eventCount"),
    pasteCount: readDurableCounter(document, "pasteCount"),
    tabSwitchCount: readDurableCounter(document, "tabSwitchCount"),
    focusLossCount: readFocusLossCount(document),
    copyAttemptCount: readDurableCounter(document, "copyAttemptCount"),
  };
}

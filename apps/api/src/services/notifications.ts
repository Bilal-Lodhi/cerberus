/**
 * Outbound high-risk incident notifications.
 *
 * Both channels are optional and no-op when unconfigured. Failures are logged
 * and swallowed: a notification outage must never fail telemetry ingestion.
 *
 * Every call is time-bounded. Ingestion awaits both channels before returning,
 * so without a deadline a hung webhook would stall the ingest request for as long
 * as the socket stayed open — turning the notification path into a way to block
 * telemetry collection, which is the opposite of what it is for.
 *
 * ── What is logged ────────────────────────────────────────────────────
 *
 * The request id, the channel, a classification (`skipped`, `non-2xx`, `timeout`,
 * `transport`) and the HTTP status when there was one. **Never** the webhook URL — a
 * webhook URL is itself a credential, and anyone holding it can post into the channel
 * — and never the credentials or the incident content. The failure classification is
 * what an operator acts on; the body is not. See
 * `docs/development/operability-model.md` §7.
 *
 * Notifications remain **best effort**. There is no durable outbox, and no delivery
 * guarantee is claimed.
 */

import type { RiskAssessmentPayload } from "../types.js";
import { LOG_EVENTS, logger } from "../observability/logger.js";

/**
 * Per-call deadline for an outbound notification, in milliseconds.
 *
 * Five seconds: long enough for a healthy webhook or email API to answer, short
 * enough that a dead one cannot visibly stall the ingestion response. A constant
 * rather than a setting, because it is a safety bound rather than an operational
 * preference — waiting longer for a notification whose failure is already
 * swallowed buys nothing.
 */
export const NOTIFICATION_TIMEOUT_MS = 5_000;

/**
 * `fetch` under a deadline.
 *
 * An explicit `AbortController` rather than `AbortSignal.timeout()`: that helper
 * schedules an **unref'd** timer, so a deadline that happens to be the only
 * pending work never fires and the promise stays pending forever. This timer is
 * ref'd, so the deadline is guaranteed to fire, and it is always cleared.
 *
 * There is no caller-supplied signal here, so any `AbortError` is this deadline.
 */
async function fetchWithDeadline(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Distinguishes a deadline from a transport failure, as a stable classification. */
function classifyFailure(error: unknown): "timeout" | "transport" {
  return error instanceof Error && error.name === "AbortError" ? "timeout" : "transport";
}

/** The safe, non-identifying fields every notification log line carries. */
function notificationFields(
  channel: string,
  payload: RiskAssessmentPayload,
): Record<string, unknown> {
  return {
    channel,
    dependency: "notification",
    // A session id is the incident's own subject and is already what the caller asked
    // about, so it is safe here — unlike on a list or probe path.
    sessionId: payload.sessionId,
    severity: payload.overallRiskScore,
  };
}

export async function notifySlack(
  webhookUrl: string,
  payload: RiskAssessmentPayload,
  timeoutMs: number = NOTIFICATION_TIMEOUT_MS,
): Promise<void> {
  if (!webhookUrl) {
    logger.debug(LOG_EVENTS.NOTIFICATION, {
      ...notificationFields("slack", payload),
      classification: "skipped",
      reason: "not-configured",
    });
    return;
  }

  try {
    const flags = payload.flags
      .map((flag) => `${flag.severity}: ${flag.description}`)
      .join("; ");

    const response = await fetchWithDeadline(
      webhookUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text:
            `Cerberus high-risk alert: ${payload.employeeId} scored ` +
            `${payload.overallRiskScore}/100. Flags: ${flags || "none"}`,
        }),
      },
      timeoutMs,
    );

    if (!response.ok) {
      logger.warn(LOG_EVENTS.NOTIFICATION, {
        ...notificationFields("slack", payload),
        classification: "non-2xx",
        status: response.status,
      });
    } else {
      logger.debug(LOG_EVENTS.NOTIFICATION, {
        ...notificationFields("slack", payload),
        classification: "delivered",
        status: response.status,
      });
    }
  } catch (error) {
    logger.warn(LOG_EVENTS.NOTIFICATION, {
      ...notificationFields("slack", payload),
      classification: classifyFailure(error),
      timeoutMs,
    });
  }
}

export async function sendEmail(
  apiKey: string,
  from: string,
  to: string,
  payload: RiskAssessmentPayload,
  timeoutMs: number = NOTIFICATION_TIMEOUT_MS,
): Promise<void> {
  if (!apiKey || !from || !to) {
    logger.debug(LOG_EVENTS.NOTIFICATION, {
      ...notificationFields("email", payload),
      classification: "skipped",
      reason: "not-configured",
    });
    return;
  }

  try {
    const response = await fetchWithDeadline(
      "https://api.sendgrid.com/v3/mail/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: from },
          subject: `Cerberus high-risk incident: ${payload.employeeId}`,
          content: [
            {
              type: "text/plain",
              value:
                `Risk score: ${payload.overallRiskScore}/100\n` +
                `Session: ${payload.sessionId}\n` +
                `Summary: ${payload.incidentSummary ?? "n/a"}\n` +
                `Flags: ${payload.flags.map((f) => f.flagType).join(", ") || "none"}\n`,
            },
          ],
        }),
      },
      timeoutMs,
    );

    if (!response.ok) {
      logger.warn(LOG_EVENTS.NOTIFICATION, {
        ...notificationFields("email", payload),
        classification: "non-2xx",
        status: response.status,
      });
    } else {
      logger.debug(LOG_EVENTS.NOTIFICATION, {
        ...notificationFields("email", payload),
        classification: "delivered",
        status: response.status,
      });
    }
  } catch (error) {
    logger.warn(LOG_EVENTS.NOTIFICATION, {
      ...notificationFields("email", payload),
      classification: classifyFailure(error),
      timeoutMs,
    });
  }
}

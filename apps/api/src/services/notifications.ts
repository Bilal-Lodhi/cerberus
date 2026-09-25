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
 */

import type { RiskAssessmentPayload } from "../types.js";

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

/** Distinguishes a deadline from a transport failure in the logs. */
function describeFailure(error: unknown, channel: string, timeoutMs: number): string {
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return `${channel} notification timed out after ${timeoutMs}ms`;
  }
  return `${channel} notification failed: ${
    error instanceof Error ? error.message : String(error)
  }`;
}

export async function notifySlack(
  webhookUrl: string,
  payload: RiskAssessmentPayload,
  timeoutMs: number = NOTIFICATION_TIMEOUT_MS,
): Promise<void> {
  if (!webhookUrl) {
    console.log("[notifications] Slack skipped: webhook is not configured");
    return;
  }

  try {
    const flags = payload.flags
      .map((flag) => `${flag.severity}: ${flag.description}`)
      .join("; ");

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text:
          `Cerberus high-risk alert: ${payload.employeeId} scored ` +
          `${payload.overallRiskScore}/100. Flags: ${flags || "none"}`,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      console.error(`[notifications] Slack returned HTTP ${response.status}`);
    }
  } catch (error) {
    console.error(`[notifications] ${describeFailure(error, "Slack", timeoutMs)}`);
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
    console.log("[notifications] Email skipped: provider configuration is incomplete");
    return;
  }

  try {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
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
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      console.error(`[notifications] Email provider returned HTTP ${response.status}`);
    }
  } catch (error) {
    console.error(`[notifications] ${describeFailure(error, "Email", timeoutMs)}`);
  }
}

/**
 * Outbound high-risk incident notifications.
 *
 * Both channels are optional and no-op when unconfigured. Failures are logged
 * and swallowed: a notification outage must never fail telemetry ingestion.
 */

import type { RiskAssessmentPayload } from "../types.js";

export async function notifySlack(
  webhookUrl: string,
  payload: RiskAssessmentPayload,
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
    });

    if (!response.ok) {
      console.error(`[notifications] Slack returned HTTP ${response.status}`);
    }
  } catch (error) {
    console.error(
      "[notifications] Slack notification failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function sendEmail(
  apiKey: string,
  from: string,
  to: string,
  payload: RiskAssessmentPayload,
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
    });

    if (!response.ok) {
      console.error(`[notifications] Email provider returned HTTP ${response.status}`);
    }
  } catch (error) {
    console.error(
      "[notifications] Email notification failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

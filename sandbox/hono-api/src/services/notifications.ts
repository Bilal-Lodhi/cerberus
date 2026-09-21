import type { RiskAssessmentPayload } from "../types.js";

export async function notifySlack(
  webhookUrl: string,
  payload: RiskAssessmentPayload
): Promise<void> {
  if (!webhookUrl || webhookUrl === "mock") {
    console.log("[Notifications] Slack skipped: webhook is not configured");
    return;
  }
  try {
    const flags = payload.flags.map((flag) => `${flag.severity}: ${flag.description}`).join("; ");
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `Cerberus high-risk alert: ${payload.employeeId} scored ${payload.overallRiskScore}/100. Flags: ${flags || "none"}`,
      }),
    });
    if (!response.ok) console.error(`[Notifications] Slack returned HTTP ${response.status}`);
  } catch (error) {
    console.error("[Notifications] Slack notification failed:", error);
  }
}

export async function sendEmail(
  apiKey: string,
  from: string,
  to: string,
  payload: RiskAssessmentPayload
): Promise<void> {
  if (!apiKey || apiKey === "mock" || !from || !to) {
    console.log("[Notifications] Email skipped: SendGrid configuration is incomplete");
    return;
  }
  try {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from },
        subject: `Cerberus high-risk incident: ${payload.employeeId}`,
        content: [{ type: "text/plain", value: JSON.stringify(payload, null, 2) }],
      }),
    });
    if (!response.ok) console.error(`[Notifications] SendGrid returned HTTP ${response.status}`);
  } catch (error) {
    console.error("[Notifications] Email notification failed:", error);
  }
}

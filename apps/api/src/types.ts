/**
 * Core type definitions for Cerberus — real-time insider-threat and
 * data-exfiltration telemetry guardian.
 *
 * These types model the conceptual requirements of a financial-compliance
 * monitoring workflow: monitored systems, regulatory mandates, threat
 * vectors, detection rules, and live employee terminal sessions.
 */

// ─── Threat Scenario Authoring Contracts ──────────────────────────

export interface ThreatScenarioPrompt {
  /** Raw natural-language description of the desired threat scenario set */
  prompt: string;
  /** Target system context (e.g. "core-trading-ledger", "swift-gateway") */
  roleContext: string;
  /** Number of threat vectors the generator should produce */
  vectorCount: number;
  /** Threat severity distribution weights (sums to ~1.0) */
  severityMix: SeverityMix;
}

export interface SeverityMix {
  low: number;
  medium: number;
  high: number;
  critical: number;
}

export interface ThreatScenarioMatrix {
  metadata: ThreatScenarioMetadata;
  targetSystems: TargetSystem[];
  regulatoryMandates: RegulatoryMandate[];
  threatVectors: ThreatVector[];
  penetrationScenarios: PenetrationScenario[];
}

export interface ThreatScenarioMetadata {
  /** Unique matrix identifier — also the MongoDB index key. */
  matrixId: string;
  generatedAt: string;          // ISO-8601
  modelVersion: string;         // e.g. "gpt-5.6"
  promptFingerprint: string;    // SHA-256 of the input prompt
  tokenUsage: TokenUsageStats;
}

export interface TokenUsageStats {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface TargetSystem {
  systemId: string;
  name: string;
  criticalityLevel: "low" | "medium" | "high" | "critical" | "tier-1";
  requiredMandateIds: string[];
  description: string;
  /** Examples: "Core Trading Ledger", "SWIFT Gateway", "HFT Desk" */
  examples: string[];
}

export interface RegulatoryMandate {
  mandateId: string;
  name: string;
  description: string;
  weight: number;               // 0-1 contribution to overall compliance score
  subMandates: RegulatoryMandate[];
  /** Examples: "Anti-Money Laundering [AML]", "SOX Compliance", "GDPR", "FINRA Audit" */
  regulationCode: string;
}

export interface ThreatVector {
  vectorId: string;
  vectorType: "token_injection" | "transfer_interception" | "data_exfiltration" | "privilege_escalation";
  title: string;
  description: string;
  targetSystemId: string;
  exploitScenario?: string;
  /** Seed content placed in the monitored terminal workspace for this vector. */
  workspaceSeed?: string;
  detectionRules?: DetectionRule[];
  expectedRemediation?: string;
  severity: "low" | "medium" | "high" | "critical";
  mandateId: string;
  investigationTimeMinutes: number;
  riskScore: number;
}

export interface DetectionRule {
  ruleId: string;
  /** Telemetry pattern the rule matches against (keystroke/paste/focus signal). */
  signalPattern: string;
  /** Expected telemetry verdict when the pattern matches. */
  expectedSignal: string;
  /** true = always-on baseline rule; false = adaptive/anomaly-derived rule. */
  isBaseline: boolean;
  evaluationWindowMs: number;
}

export interface PenetrationScenario {
  scenarioId: string;
  vectorId: string;
  mandateIds: string[];
  scoringFormula: ScoringFormula;
  antiExfiltrationThresholds: AntiExfiltrationThresholds;
  description: string;
  /** Simulated exploit code or transaction wrapper */
  exploitCode?: string;
}

export interface ScoringFormula {
  type: "weighted_sum" | "all_or_nothing" | "partial_credit";
  weights: Record<string, number>;  // mandateId -> weight
}

export interface AntiExfiltrationThresholds {
  maxPasteEvents: number;
  maxTimeBetweenKeystrokesMs: number;
  dataLeakageSimilarityThreshold: number; // 0-1 cosine distance
  behavioralAnomalySensitivity: number;   // 0-1
  maxCopyAttempts: number;
  maxWindowBlurEvents: number;
}

// ─── Telemetry / Insider Threat Guardian Types ─────────────────────

export interface MicroEvent {
  eventId: string;
  sessionId: string;
  employeeId: string;
  /** Compliance audit identifier this session belongs to. */
  auditId: string;
  /** Threat vector being monitored. */
  vectorId: string;
  eventType: MicroEventType;
  timestamp: string;            // ISO-8601 with millis
  payload: MicroEventPayload;
  clientMetadata: ClientMetadata;
}

export type MicroEventType =
  | "KEYSTROKE"
  | "PASTE_TRIGGER"
  | "CODE_DELTA"
  | "TAB_SWITCH"
  | "WINDOW_BLUR"
  | "COPY_ATTEMPT"
  | "DEVELOPER_TOOLS_OPEN"
  | "FULLSCREEN_EXIT"
  | "EXTERNAL_APP_SWITCH"
  | "SUBMIT"
  | "EDIT"
  | "PASTE";

export interface MicroEventPayload {
  /** For KEYSTROKE: the character typed */
  char?: string;
  /** Timestamp delta since previous event in ms */
  deltaMs?: number;
  /** For CODE_DELTA: unified diff of the change */
  diffPatch?: string;
  /** For PASTE_TRIGGER: the pasted content snapshot */
  pasteContent?: string;
  /** For COPY_ATTEMPT: copied text preview (possibly truncated) */
  copyContent?: string;
  /** For COPY_ATTEMPT: total copied character count */
  copiedLength?: number;
  /** For COPY_ATTEMPT: selected text length before fallback-to-full-text copy */
  selectedTextLength?: number;
  /** For COPY_ATTEMPT: selected text */
  selectedText?: string;
  /** Browser tab visibility state */
  visibilityState?: "visible" | "hidden";
  /** Whether dev tools are open */
  devToolsOpen?: boolean;
  /** Full snapshot of the current terminal workspace content */
  terminalSnapshot?: string;
  /** For EDIT/PASTE: the full new text of the terminal workspace */
  newText?: string;
  /** For EDIT/PASTE: signed character count delta (positive=insert, negative=delete) */
  changeLength?: number;
}

export interface ClientMetadata {
  userAgent: string;
  ipAddress: string;
  screenResolution: string;
  platform: string;
  language: string;
}

export interface RiskDimensionScores {
  dataExfiltration: number;     // 0-100
  unauthorizedAccess: number;   // 0-100
  policyViolation: number;      // 0-100
  amlRedFlag: number;           // 0-100
  insiderTrading: number;       // 0-100
  soxNonCompliance: number;     // 0-100
}

export interface RiskAssessmentPayload {
  riskAssessmentId: string;
  sessionId: string;
  employeeId: string;
  auditId: string;
  overallRiskScore: number;     // 0-100 risk percentage
  /** Breakdown by risk category dimension (0-100 each). */
  dimensionScores: RiskDimensionScores;
  flags: RiskFlag[];
  exfiltrationReport: ExfiltrationReport | null;
  behavioralAnomalies: BehavioralAnomaly[];
  generatedAt: string;          // ISO-8601

  // ── Full Incident Context (persisted to MongoDB, retrievable on review) ──
  /** Full paste content blobs collected from PASTE/PASTE_TRIGGER events at detection time */
  pasteSnippets?: string[];
  /** Complete terminal workspace code snapshot at the moment of risk detection */
  codeSnapshot?: string;
  /** Running behavioral counter tallies at detection time */
  behavioralContext?: BehavioralContext;
  /** Keystroke rhythm metrics at detection time */
  keystrokeMetrics?: KeystrokeMetrics;
  /** Short 1-2 line summary message for the risk notification popup */
  incidentSummary?: string;
  /** Employee display name shown in the risk notification UI */
  employeeDisplayName?: string;
  /** Human-readable timestamp label for the notification ("Today 10:32 AM") */
  incidentTimeLabel?: string;
  /** Total lines in pasted content (useful for displaying "101 lines detected") */
  pasteLineCount?: number;
  /** Total character count across all paste snippets */
  pasteCharCount?: number;
  recommendedActions?: string[];
}

/** Running counter snapshot of behavioral deviations at risk-detection time. */
export interface BehavioralContext {
  /** Total paste events in the session so far */
  totalPasteEvents: number;
  /** Total tab-switch / window-blur events */
  totalFocusBreaches: number;
  /** Total copy-attempt events */
  totalCopyAttempts: number;
  /** Total dev-tools-open events */
  totalDevToolsOpens: number;
    /**
   * Total focus-loss events — `WINDOW_BLUR` and `FULLSCREEN_EXIT` together.
   *
   * Browser telemetry cannot distinguish the two, so this is what the counter has always
   * measured.
   */
  totalFocusLosses: number;
  /**
   * Deprecated alias for {@link totalFocusLosses}, with the same value.
   *
   * Kept because a risk assessment is **persisted**: a document written before the rename
   * carries this field and is still read back by the review surfaces.
   */
  totalFullscreenExits?: number;
}

/** Keystroke timing summary captured at risk-detection time. */
export interface KeystrokeMetrics {
  /** Average inter-key delay (ms) across recent keystrokes */
  averageInterKeyMs: number;
  /** Minimum inter-key delay observed */
  minInterKeyMs: number;
  /** Number of keystrokes faster than the anomaly threshold */
  burstKeystrokes: number;
}

export interface RiskFlag {
  flagType: string;
  severity: "low" | "medium" | "high" | "critical";
  sourceEventId: string;
  description: string;
  confidence: number;           // 0-1
  timestamp: string;
}

export interface ExfiltrationReport {
  overallSimilarity: number;    // 0-1
  matchedSnippets: ExfiltrationMatch[];
  aiCompletionLikelihood: number; // 0-1 likelihood it's AI-generated
}

export interface ExfiltrationMatch {
  sourceSnippet: string;
  employeeSnippet: string;
  similarityScore: number;
  sourceLabel: string;          // e.g. "gpt-5.6-completion", "external-llm-service"
}

export interface BehavioralAnomaly {
  anomalyType: string;
  description: string;
  evidenceWindowStart: string;
  evidenceWindowEnd: string;
  metricValue: number;
  threshold: number;
}

// ─── API Request/Response Contracts ────────────────────────────────

export interface ThreatScenarioRequest {
  prompt: string;
  roleContext: string;
  vectorCount: number;
  severityMix: SeverityMix;
}

export interface ThreatScenarioResponse {
  success: boolean;
  matrix: ThreatScenarioMatrix;
  /** MCP correlation ID for the MongoDB audit trail */
  mcpCorrelationId: string;
}

export interface IngestMicroEventRequest {
  events: MicroEvent[];
}

export interface IngestMicroEventResponse {
  success: boolean;
  processedCount: number;
  /**
   * Whether the persistence layer answered for the events write.
   *
   * `callMcpTool` never throws, so a failed `ingest_micro_events` is not an error
   * path in the route — it simply produces no accepted-set report. When that happens
   * this is `false` and **`acceptedCount` and `duplicateCount` are omitted**, because
   * a number the server knows is unverified is worse than no number: before this
   * field existed, a failed write reported `acceptedCount: <batch size>` and
   * `duplicateCount: 0`, which is indistinguishable from a fully successful ingest.
   *
   * `processedCount` always keeps its meaning — the size of the batch the caller
   * sent — so nothing is lost.
   */
  telemetryPersisted: boolean;
  /**
   * How many events in the batch were newly persisted.
   *
   * Present only when {@link telemetryPersisted} is true. Additive to
   * `processedCount`, which remains the batch size, so a caller retrying after a
   * network ambiguity can see that its events were already stored.
   */
  acceptedCount?: number;
  /** How many events were already present — a retry or a replay. */
  duplicateCount?: number;
  /**
   * Whether the `riskPayload` in this response is durable.
   *
   * Absent when no analysis ran, because then the question does not apply. `false`
   * means the paid analysis completed but its persistence did not, so the payload
   * exists only in this response body and in this process's memory. In that case the
   * session's status is deliberately **not** changed and no notification is sent:
   * a lock whose justification was never recorded is the failure this ordering exists
   * to prevent.
   */
  assessmentPersisted?: boolean;
  riskPayload: RiskAssessmentPayload | null;
  /** Whether the exfiltration threshold was breached */
  alertTriggered: boolean;
  /** Current anomaly risk index scoring */
  anomalyRiskIndex: number;
}

// ─── Session Deployment Types ──────────────────────────────────────

export interface DeploySessionRequest {
  employeeUid: string;          // e.g. "op-trader-001"
  sessionId: string;            // e.g. "active-ledger-audit"
  matrixId: string;             // The threat scenario matrix to associate
  targetSystem: string;         // e.g. "Core Trading Ledger"
}

export interface DeploySessionResponse {
  success: boolean;
  sessionId: string;
  employeeId: string;
  deployedAt: string;
  mongoDocumentId: string;
  mcpCorrelationId: string;
}

export interface ActiveSession {
  sessionId: string;
  employeeId: string;
  matrixId: string;
  targetSystem: string;
  status: "active" | "flagged" | "investigating" | "cleared" | "locked";
  deployedAt: string;
  riskIndex: number;
  /**
   * Server-observed time of the last activity on this session. Feeds the
   * `SESSION_TTL_SECONDS` expiry predicate for a session that has been deployed
   * but has not ingested telemetry yet, and is refreshed on reactivation.
   * Absent means "fall back to `deployedAt`".
   */
  lastActivityAt?: string;
}

// ─── Session Review Types ──────────────────────────────────────────

/**
 * Derived liveness of a session, computed from its activity and
 * `SESSION_TTL_SECONDS` (see `services/session-liveness.ts`).
 *
 * `"expired"` means the monitoring window has closed: the session is not live,
 * refuses new telemetry until it is reactivated, and is excluded from
 * `GET /api/v1/guardian/sessions`. It is NOT a statement about the evidence —
 * review data is retained and still served by the review endpoints.
 *
 * This is never persisted as a session status.
 */
export type SessionLiveness = "active" | "expired";

/**
 * The review **disposition** of a session: what the evidence suggests, as distinct from
 * its lifecycle status.
 *
 * This used to be folded into `SessionReviewResponse.status`, which made the review
 * detail the one surface that reported `flagged` where every other surface reported
 * `active` — including the review *list*, for the same session. Two consequences were
 * observable: a client comparing the surfaces saw a disagreement about the same session,
 * and the console's review panel treated `flagged` as `locked`, so a session scoring 60
 * was displayed as LOCKED while the dashboard displayed it as active.
 *
 *   `flagged`        the latest assessment scored above the alert threshold
 *   `investigating`  the session has a submission, with no assessment above it
 *   `none`           neither
 *
 * Derived at read time and never persisted. `status` carries the lifecycle state
 * everywhere, under one vocabulary.
 */
export type ReviewDisposition = "flagged" | "investigating" | "none";

export interface SessionReviewResponse {
  sessionId: string;
  employeeId: string;
  auditId: string;
  /**
   * The **lifecycle** status, the same vocabulary every other surface reports.
   *
   * `flagged` and `investigating` are no longer produced here; they are a
   * {@link ReviewDisposition}. `cleared` is unreachable — nothing has ever produced it —
   * and is kept in the union only because a legacy document could still hold it.
   */
  status: "active" | "flagged" | "investigating" | "cleared" | "locked" | "terminated";
  /** Derived from the evidence. Never persisted. */
  disposition?: ReviewDisposition;
  /**
   * The session's lifetime event total, from the durable document.
   *
   * Distinct from `timeline.length`, which is capped: the timeline holds the most recent
   * events only. Before this field existed the console re-derived its counters by counting
   * the timeline, so a session with more than 500 events was under-reported on the review
   * panel.
   */
  eventCount?: number;
  pasteCount?: number;
  tabSwitchCount?: number;
  focusLossCount?: number;
  /** Deprecated alias for `focusLossCount`. Same value. */
  fullscreenExitCount?: number;
  copyAttemptCount?: number;
  /** The durable peak risk score, monotonic across a restart. */
  peakRiskScore?: number;
  /** True when the timeline holds fewer events than the session has. */
  timelineTruncated?: boolean;
  startedAt?: string;
  targetSystem?: string;
  terminalContent: string;
  timeline: TimelineEntry[];
  riskSummary: RiskAssessmentPayload[];
  finalRiskScore: number | null;
  /** Derived, never persisted. Absent on older payloads. */
  liveness?: SessionLiveness;
}

export interface TimelineEntry {
  timestamp: string;
  eventType: string;
  label: string;
  severity: "info" | "warning" | "critical";
  detail: string;
}

// ─── Operator Identity Types ───────────────────────────────────────

export interface IdentityPayload {
  displayName: string;
  employeeId: string;
  role?: string;
  department?: string;          // e.g. "Trading Desk", "Compliance"
}

export interface IdentityResponse {
  success: boolean;
  identity: IdentityPayload;
  /** Opaque per-process operator handle. Not an authorization credential. */
  sessionToken: string;
}

// ─── MCP Server Types ──────────────────────────────────────────────

export interface MCPToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
  correlationId: string;
}

export interface MCPToolResult {
  correlationId: string;
  toolName: string;
  success: boolean;
  data: unknown;
  error?: string;
  mongoDocumentId?: string;
}

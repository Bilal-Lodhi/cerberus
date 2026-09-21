/**
 * Core type definitions for Cerberus FinSec: Real-Time Insider Threat
 * & Data Exfiltration Guardian.
 * Google Cloud Financial Services Track — Hackathon 2026.
 *
 * These types model the pure conceptual requirements of a financial
 * compliance audit workflow: threat matrices, regulatory mandates,
 * monitored penetration scenarios, and live employee terminal sessions.
 */

// ─── Gemini Agent Contracts ───────────────────────────────────────

export interface OrchestratorPrompt {
  /** Raw natural-language description of the desired compliance audit / threat matrix */
  prompt: string;
  /** Target system context (e.g. "core-trading-ledger", "swift-gateway") */
  roleContext: string;
  /** Number of monitored threat vectors the generator should produce */
  problemCount: number;
  /** Threat severity distribution weights */
  difficultyMix: DifficultyMix;
}

export interface DifficultyMix {
  beginner: number;    // 0-1 weight (backward compat)
  intermediate: number;
  advanced: number;
  /** Alias for beginner — FinSec severity mapping */
  low?: number;
  /** Alias for intermediate */
  medium?: number;
  /** Alias for advanced */
  critical?: number;
}

export interface GeneratedComplianceMatrix {
  metadata: MatrixMetadata;
  targetSystems: TargetSystem[];
  regulatoryMandates: RegulatoryMandate[];
  threatVectors: ThreatVector[];
  penetrationScenarios: PenetrationScenario[];
}

export interface MatrixMetadata {
  matrixId: string;
  suiteId: string;              // Unique suite ID for MongoDB indexing (mirrors matrixId)
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
  starterCode?: string;
  detectionRules?: DetectionRule[];
  expectedRemediation?: string;
  severity: "low" | "medium" | "high" | "critical";
  mandateId: string;
  investigationTimeMinutes: number;
  riskScore: number;
}

export interface DetectionRule {
  ruleId: string;
  input: string;
  expectedOutput: string;
  isBaseline: boolean;          // false = hidden detection rule
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

// ─── Security / Insider Threat Guardian Types ──────────────────────

export interface MicroEvent {
  eventId: string;
  sessionId: string;
  employeeId: string;           // Renamed from candidateId
  auditId: string;              // Renamed from assessmentId
  vectorId: string;             // Renamed from problemId
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
  employeeId: string;           // Renamed from candidateId
  auditId: string;              // Renamed from assessmentId
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
  /** Total fullscreen-exit events */
  totalFullscreenExits: number;
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

export interface GenerateComplianceMatrixRequest {
  prompt: string;
  roleContext: string;
  problemCount: number;
  difficultyMix: DifficultyMix;
}

export interface GenerateComplianceMatrixResponse {
  success: boolean;
  matrix: GeneratedComplianceMatrix;
  /** MCP correlation ID for MongoDB audit trail */
  mcpCorrelationId: string;
}

export interface IngestMicroEventRequest {
  events: MicroEvent[];
}

export interface IngestMicroEventResponse {
  success: boolean;
  processedCount: number;
  riskPayload: RiskAssessmentPayload | null;  // Renamed from suspicionPayload
  /** Whether the exfiltration threshold was breached */
  alertTriggered: boolean;
  /** Current anomaly risk index scoring */
  anomalyRiskIndex: number;
}

// ─── Session Deployment Types ──────────────────────────────────────

export interface DeploySessionRequest {
  employeeUid: string;          // e.g. "op-trader-001"
  sessionId: string;            // e.g. "active-ledger-audit"
  matrixId: string;             // The compliance matrix to associate
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
}

// ─── Session Review Types ──────────────────────────────────────────

export interface SessionReviewResponse {
  sessionId: string;
  employeeId: string;           // Renamed from candidateId
  auditId: string;              // Renamed from assessmentId
  status: "active" | "flagged" | "investigating" | "cleared" | "locked" | "terminated";
  terminalContent: string;      // Renamed from submittedCode
  timeline: TimelineEntry[];
  riskSummary: RiskAssessmentPayload[];  // Renamed from suspicionSummary
  finalRiskScore: number | null;         // Renamed from finalScore
}

export interface TimelineEntry {
  timestamp: string;
  eventType: string;
  label: string;
  severity: "info" | "warning" | "critical";
  detail: string;
}

// ─── Lightweight Identity Types (No Auth — Hackathon Demo) ─────────

export interface IdentityPayload {
  displayName: string;
  employeeId: string;           // Renamed from candidateId
  role?: string;
  department?: string;          // e.g. "Trading Desk", "Compliance"
}

export interface IdentityResponse {
  success: boolean;
  identity: IdentityPayload;
  sessionToken: string; // ephemeral demo token (UUID, no crypto)
}

// ─── MCP Server Types (MongoDB Track) ──────────────────────────────

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

// ─── Backward Compatibility Aliases (for gradual migration) ────────
// These maintain compatibility with existing code during the rebrand.

/** @deprecated Use GeneratedComplianceMatrix instead */
export type GeneratedTestSuite = GeneratedComplianceMatrix;

/** @deprecated Use SuiteMetadata (now MatrixMetadata) */
export type SuiteMetadata = MatrixMetadata;

/** @deprecated Use RoleDescriptor (now TargetSystem) */
export type RoleDescriptor = TargetSystem;

/** @deprecated Use CompetencyTree (now RegulatoryMandate) */
export type CompetencyTree = RegulatoryMandate;

/** @deprecated Use GeneratedProblem (now ThreatVector) */
export type GeneratedProblem = ThreatVector;

/** @deprecated Use HiddenTestingMatrix (now PenetrationScenario) */
export type HiddenTestingMatrix = PenetrationScenario;

/** @deprecated Use HiddenTestCase (now DetectionRule) */
export type HiddenTestCase = DetectionRule;

/** @deprecated Use MCQOption — kept for reference */
export interface MCQOption {
  optionId: string;
  text: string;
  isCorrect: boolean;
  explanation: string;
}

/** @deprecated Use AntiExfiltrationThresholds instead */
export type AntiCheatThresholds = AntiExfiltrationThresholds;

/** @deprecated Use SuspiionPayload (now RiskAssessmentPayload) */
export type SuspicionPayload = RiskAssessmentPayload;

/** @deprecated Use SuspicionFlag (now RiskFlag) */
export type SuspicionFlag = RiskFlag;

/** @deprecated Use PlagiarismReport (now ExfiltrationReport) */
export type PlagiarismReport = ExfiltrationReport;

/** @deprecated Use PlagiarismMatch (now ExfiltrationMatch) */
export type PlagiarismMatch = ExfiltrationMatch;

/** @deprecated Use GenerateComplianceMatrixRequest instead */
export type GenerateTestSuiteRequest = GenerateComplianceMatrixRequest;

/** @deprecated Use GenerateComplianceMatrixResponse instead */
export type GenerateTestSuiteResponse = GenerateComplianceMatrixResponse;

/** @deprecated Use IngestMicroEventRequest (same name, updated fields) */
// IngestMicroEventRequest retained as primary name

/** @deprecated Use IngestMicroEventResponse (same name, updated fields) */
// IngestMicroEventResponse retained as primary name

/** @deprecated Use SessionReviewResponse (updated fields) */
// SessionReviewResponse retained as primary name

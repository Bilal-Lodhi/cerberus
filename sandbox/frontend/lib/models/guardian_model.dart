// ═══════════════════════════════════════════════════════════════════
// Cerberus FinSec — Insider Threat & Data Exfiltration Guardian Model
// ═══════════════════════════════════════════════════════════════════
// Models the real-time risk assessment output contract from the
// Hono API guardian endpoint backed by Gemini 3 Flash Preview.
//
// Field names match the TypeScript types in
// sandbox/hono-api/src/types.ts exactly (camelCase).

class RiskAssessmentPayload {
  /// Unique risk assessment report identifier (UUID v4).
  final String riskAssessmentId;

  /// The employee/operator UID under audit.
  final String employeeId;

  /// The active terminal session audit identifier.
  final String auditId;

  /// The correlated session ID from the ingestion pipeline.
  final String sessionId;

  /// ISO-8601 timestamp when this risk assessment was generated.
  final String generatedAt;

  /// Composite anomaly risk score 0–100 (0 = compliant, 100 = critical exfiltration).
  final double overallRiskScore;

  /// Breakdown by risk category dimension.
  final RiskDimensionScores dimensionScores;

  /// Ordered list of flagged behavioral indicators.
  final List<AnomalyFlag> flags;

  /// Raw Gemini reasoning trace (audit trail).
  final String auditReasoning;

  // ── Full Incident Context (persisted to MongoDB, retrievable on review) ──

  /// Full paste content blobs collected at detection time.
  final List<String> pasteSnippets;

  /// Complete terminal workspace code snapshot at the moment of risk detection.
  final String codeSnapshot;

  /// Running behavioral counter tallies at detection time.
  final BehavioralContext? behavioralContext;

  /// Keystroke rhythm metrics at detection time.
  final KeystrokeMetrics? keystrokeMetrics;

  /// Short 1-2 line summary message for the risk notification popup.
  final String incidentSummary;

  /// Employee display name shown in the risk notification UI.
  final String employeeDisplayName;

  /// Human-readable timestamp label for the notification ("Today 10:32 AM").
  final String incidentTimeLabel;

  /// Total lines in pasted content.
  final int pasteLineCount;

  /// Total character count across all paste snippets.
  final int pasteCharCount;

  const RiskAssessmentPayload({
    required this.riskAssessmentId,
    required this.employeeId,
    required this.auditId,
    required this.sessionId,
    required this.generatedAt,
    required this.overallRiskScore,
    required this.dimensionScores,
    required this.flags,
    required this.auditReasoning,
    this.pasteSnippets = const [],
    this.codeSnapshot = '',
    this.behavioralContext,
    this.keystrokeMetrics,
    this.incidentSummary = '',
    this.employeeDisplayName = '',
    this.incidentTimeLabel = '',
    this.pasteLineCount = 0,
    this.pasteCharCount = 0,
  });

  factory RiskAssessmentPayload.fromJson(Map<String, dynamic> json) {
    return RiskAssessmentPayload(
      riskAssessmentId: json['riskAssessmentId'] as String? ?? '',
      employeeId: json['employeeId'] as String? ?? '',
      auditId: json['auditId'] as String? ?? '',
      sessionId: json['sessionId'] as String? ?? '',
      generatedAt: json['generatedAt'] as String? ?? '',
      overallRiskScore: (json['overallRiskScore'] as num?)?.toDouble() ?? 0.0,
      dimensionScores: RiskDimensionScores.fromJson(
        (json['dimensionScores'] as Map<String, dynamic>?) ?? const {},
      ),
      flags: (json['flags'] as List<dynamic>? ?? [])
          .map((f) => AnomalyFlag.fromJson(f as Map<String, dynamic>))
          .toList(),
      auditReasoning: json['auditReasoning'] as String? ?? '',
      pasteSnippets:
          (json['pasteSnippets'] as List<dynamic>?)
              ?.map((s) => s as String)
              .toList() ??
          [],
      codeSnapshot: json['codeSnapshot'] as String? ?? '',
      behavioralContext: json['behavioralContext'] != null
          ? BehavioralContext.fromJson(
              json['behavioralContext'] as Map<String, dynamic>,
            )
          : null,
      keystrokeMetrics: json['keystrokeMetrics'] != null
          ? KeystrokeMetrics.fromJson(
              json['keystrokeMetrics'] as Map<String, dynamic>,
            )
          : null,
      incidentSummary: json['incidentSummary'] as String? ?? '',
      employeeDisplayName: json['employeeDisplayName'] as String? ?? '',
      incidentTimeLabel: json['incidentTimeLabel'] as String? ?? '',
      pasteLineCount: json['pasteLineCount'] as int? ?? 0,
      pasteCharCount: json['pasteCharCount'] as int? ?? 0,
    );
  }
}

/// Running counter snapshot of behavioral deviations at risk-detection time.
class BehavioralContext {
  final int totalPasteEvents;
  final int totalFocusBreaches;
  final int totalCopyAttempts;
  final int totalDevToolsOpens;
  final int totalFullscreenExits;

  const BehavioralContext({
    required this.totalPasteEvents,
    required this.totalFocusBreaches,
    required this.totalCopyAttempts,
    required this.totalDevToolsOpens,
    required this.totalFullscreenExits,
  });

  factory BehavioralContext.fromJson(Map<String, dynamic> json) {
    return BehavioralContext(
      totalPasteEvents: json['totalPasteEvents'] as int? ?? 0,
      totalFocusBreaches: json['totalFocusBreaches'] as int? ?? 0,
      totalCopyAttempts: json['totalCopyAttempts'] as int? ?? 0,
      totalDevToolsOpens: json['totalDevToolsOpens'] as int? ?? 0,
      totalFullscreenExits: json['totalFullscreenExits'] as int? ?? 0,
    );
  }
}

/// Keystroke timing summary captured at risk-detection time.
class KeystrokeMetrics {
  final double averageInterKeyMs;
  final double minInterKeyMs;
  final int burstKeystrokes;

  const KeystrokeMetrics({
    required this.averageInterKeyMs,
    required this.minInterKeyMs,
    required this.burstKeystrokes,
  });

  factory KeystrokeMetrics.fromJson(Map<String, dynamic> json) {
    return KeystrokeMetrics(
      averageInterKeyMs: (json['averageInterKeyMs'] as num?)?.toDouble() ?? 0.0,
      minInterKeyMs: (json['minInterKeyMs'] as num?)?.toDouble() ?? 0.0,
      burstKeystrokes: json['burstKeystrokes'] as int? ?? 0,
    );
  }
}

/// Dimension-level risk scores for radar / heatmap rendering.
class RiskDimensionScores {
  final double dataExfiltration;
  final double unauthorizedAccess;
  final double policyViolation;
  final double amlRedFlag;
  final double insiderTrading;
  final double soxNonCompliance;

  const RiskDimensionScores({
    required this.dataExfiltration,
    required this.unauthorizedAccess,
    required this.policyViolation,
    required this.amlRedFlag,
    required this.insiderTrading,
    required this.soxNonCompliance,
  });

  factory RiskDimensionScores.fromJson(Map<String, dynamic> json) {
    return RiskDimensionScores(
      dataExfiltration: (json['dataExfiltration'] as num?)?.toDouble() ?? 0.0,
      unauthorizedAccess:
          (json['unauthorizedAccess'] as num?)?.toDouble() ?? 0.0,
      policyViolation: (json['policyViolation'] as num?)?.toDouble() ?? 0.0,
      amlRedFlag: (json['amlRedFlag'] as num?)?.toDouble() ?? 0.0,
      insiderTrading: (json['insiderTrading'] as num?)?.toDouble() ?? 0.0,
      soxNonCompliance: (json['soxNonCompliance'] as num?)?.toDouble() ?? 0.0,
    );
  }
}

/// Individual behavioral anomaly flag raised by Gemini.
class AnomalyFlag {
  final String flagId;
  final String category;
  final String description;
  final double confidence;
  final String evidenceSnippet;
  final String timestamp;

  const AnomalyFlag({
    required this.flagId,
    required this.category,
    required this.description,
    required this.confidence,
    required this.evidenceSnippet,
    this.timestamp = '',
  });

  factory AnomalyFlag.fromJson(Map<String, dynamic> json) {
    // The Hono API returns Gemini's raw field names: {flagType, severity,
    // sourceEventId, description, confidence, timestamp}. Map them to
    // the Flutter model's internal field names.
    final flagType =
        json['flagType'] as String? ?? json['category'] as String? ?? '';
    final sourceEventId =
        json['sourceEventId'] as String? ?? json['flagId'] as String? ?? '';
    return AnomalyFlag(
      // Use sourceEventId as the primary identifier for the flag.
      flagId: sourceEventId.isNotEmpty ? sourceEventId : flagType,
      // Use flagType as the category dimension label.
      category: flagType,
      description: json['description'] as String? ?? '',
      confidence: (json['confidence'] as num?)?.toDouble() ?? 0.0,
      // Best available evidence text — use description as the evidence snippet
      // since the API doesn't send a dedicated evidenceSnippet field.
      evidenceSnippet:
          json['evidenceSnippet'] as String? ??
          json['description'] as String? ??
          '',
      timestamp: json['timestamp'] as String? ?? '',
    );
  }
}

// ── Micro Event models ───────────────────────────────────────────────────

/// Payload for the POST /api/v1/guardian/ingest endpoint.
class IngestMicroEventRequest {
  final List<MicroEvent> events;

  const IngestMicroEventRequest({required this.events});

  Map<String, dynamic> toJson() => {
    'events': events.map((e) => e.toJson()).toList(),
  };
}

/// Individual telemetry micro-event captured from the employee terminal.
class MicroEvent {
  final String sessionId;
  final String employeeId;
  final String auditId;
  final String eventType;
  final MicroEventPayload payload;
  final int timestampEpochMs;

  const MicroEvent({
    required this.sessionId,
    required this.employeeId,
    required this.auditId,
    required this.eventType,
    required this.payload,
    required this.timestampEpochMs,
  });

  factory MicroEvent.fromJson(Map<String, dynamic> json) {
    return MicroEvent(
      sessionId: json['sessionId'] as String? ?? '',
      employeeId: json['employeeId'] as String? ?? '',
      auditId: json['auditId'] as String? ?? '',
      eventType: json['eventType'] as String? ?? '',
      payload: MicroEventPayload.fromJson(
        (json['payload'] as Map<String, dynamic>?) ?? const {},
      ),
      timestampEpochMs: json['timestampEpochMs'] as int? ?? 0,
    );
  }

  Map<String, dynamic> toJson() => {
    'sessionId': sessionId,
    'employeeId': employeeId,
    'auditId': auditId,
    'eventType': eventType,
    'payload': payload.toJson(),
    'timestampEpochMs': timestampEpochMs,
  };
}

class MicroEventPayload {
  final int? deltaMs;
  final String? pasteContent;
  final String? diffPatch;
  final String? copyContent;
  final int? copiedLength;
  final String? copiedTextPreview;
  final int? selectedTextLength;
  final String? windowEvent;
  final String? visibilityState;
  final String? newText;
  final int? changeLength;

  const MicroEventPayload({
    this.deltaMs,
    this.pasteContent,
    this.diffPatch,
    this.copyContent,
    this.copiedLength,
    this.copiedTextPreview,
    this.selectedTextLength,
    this.windowEvent,
    this.visibilityState,
    this.newText,
    this.changeLength,
  });

  factory MicroEventPayload.fromJson(Map<String, dynamic> json) {
    return MicroEventPayload(
      deltaMs: json['deltaMs'] as int?,
      pasteContent: json['pasteContent'] as String?,
      diffPatch: json['diffPatch'] as String?,
      copyContent: json['copyContent'] as String?,
      copiedLength: json['copiedLength'] as int?,
      copiedTextPreview: json['copiedTextPreview'] as String?,
      selectedTextLength: json['selectedTextLength'] as int?,
      windowEvent: json['windowEvent'] as String?,
      visibilityState: json['visibilityState'] as String?,
      newText: json['newText'] as String?,
      changeLength: json['changeLength'] as int?,
    );
  }

  Map<String, dynamic> toJson() => {
    if (deltaMs != null) 'deltaMs': deltaMs,
    if (pasteContent != null) 'pasteContent': pasteContent,
    if (diffPatch != null) 'diffPatch': diffPatch,
    if (copyContent != null) 'copyContent': copyContent,
    if (copiedLength != null) 'copiedLength': copiedLength,
    if (copiedTextPreview != null) 'copiedTextPreview': copiedTextPreview,
    if (selectedTextLength != null) 'selectedTextLength': selectedTextLength,
    if (windowEvent != null) 'windowEvent': windowEvent,
    if (visibilityState != null) 'visibilityState': visibilityState,
    if (newText != null) 'newText': newText,
    if (changeLength != null) 'changeLength': changeLength,
  };
}

/// ── Session / Deploy / Review Models ────────────────────────────────────

/// Summary row displayed in the left-drawer audit session list.
class SessionSummary {
  final String sessionId;
  final String employeeId;
  final String employeeUid;
  final String auditId;
  final String matrixId;
  final String targetSystem;
  final String status;
  final String startedAt;
  final String createdAt;
  final String lastEventTimestamp;
  final double peakRiskScore;
  final double suspicionScore;
  final int eventCount;
  final int pasteCount;
  final int tabSwitchCount;
  final bool alertTriggered;

  const SessionSummary({
    required this.sessionId,
    required this.employeeId,
    this.employeeUid = '',
    this.auditId = '',
    this.matrixId = '',
    this.targetSystem = '',
    this.status = 'in_progress',
    this.startedAt = '',
    this.createdAt = '',
    this.lastEventTimestamp = '',
    this.peakRiskScore = 0.0,
    this.suspicionScore = 0.0,
    this.eventCount = 0,
    this.pasteCount = 0,
    this.tabSwitchCount = 0,
    this.alertTriggered = false,
  });

  factory SessionSummary.fromJson(Map<String, dynamic> json) {
    final empId =
        json['employeeId'] as String? ??
        json['employeeUid'] as String? ??
        json['candidateId'] as String? ??
        'Unknown';
    return SessionSummary(
      sessionId: json['sessionId'] as String? ?? '',
      employeeId: empId,
      employeeUid:
          json['employeeUid'] as String? ??
          json['employeeId'] as String? ??
          json['candidateId'] as String? ??
          'Unknown',
      auditId:
          json['auditId'] as String? ?? json['assessmentId'] as String? ?? '',
      matrixId: json['matrixId'] as String? ?? '',
      targetSystem: json['targetSystem'] as String? ?? '',
      status: json['status'] as String? ?? 'in_progress',
      startedAt:
          json['startedAt'] as String? ??
          json['deployedAt'] as String? ??
          json['createdAt'] as String? ??
          '',
      createdAt:
          json['createdAt'] as String? ??
          json['deployedAt'] as String? ??
          json['startedAt'] as String? ??
          '',
      lastEventTimestamp:
          json['lastEventTimestamp'] as String? ??
          json['deployedAt'] as String? ??
          json['updatedAt'] as String? ??
          '',
      peakRiskScore:
          (json['peakRiskScore'] as num?)?.toDouble() ??
          (json['riskIndex'] as num?)?.toDouble() ??
          0.0,
      suspicionScore:
          (json['suspicionScore'] as num?)?.toDouble() ??
          (json['riskIndex'] as num?)?.toDouble() ??
          (json['peakRiskScore'] as num?)?.toDouble() ??
          0.0,
      eventCount: json['eventCount'] as int? ?? 0,
      pasteCount: json['pasteCount'] as int? ?? 0,
      tabSwitchCount: json['tabSwitchCount'] as int? ?? 0,
      alertTriggered: json['alertTriggered'] as bool? ?? false,
    );
  }
}

/// Full audit review record returned by GET /api/v1/sessions/:sessionId.
class ReviewRecord {
  final String sessionId;
  final String employeeId;
  final String auditId;
  final String status;
  final String startedAt;
  final String? endedAt;
  final double overallRiskScore;
  final RiskAssessmentPayload? lastRiskPayload;
  final int eventCount;
  final int pasteCount;
  final int tabSwitchCount;
  final int copyAttemptCount;
  final List<Map<String, dynamic>> timeline;
  final String codeSubmission;
  final double peakRiskScore;
  final String targetSystem;

  const ReviewRecord({
    required this.sessionId,
    required this.employeeId,
    this.auditId = '',
    this.status = 'active',
    this.startedAt = '',
    this.endedAt,
    this.overallRiskScore = 0.0,
    this.lastRiskPayload,
    this.eventCount = 0,
    this.pasteCount = 0,
    this.tabSwitchCount = 0,
    this.copyAttemptCount = 0,
    this.timeline = const [],
    this.codeSubmission = '',
    this.peakRiskScore = 0.0,
    this.targetSystem = '',
  });

  /// Alias — consumers may reference .latestSuspicion for the risk payload.
  RiskAssessmentPayload? get latestSuspicion => lastRiskPayload;

  /// Whether the session is locked due to detected anomalous behavior.
  /// The backend stores 'flagged' (set_session_status), while older code
  /// may use 'locked'. Both are treated as locked.
  bool get isLocked => status == 'flagged' || status == 'locked';

  factory ReviewRecord.fromJson(Map<String, dynamic> json) {
    return ReviewRecord(
      sessionId: json['sessionId'] as String? ?? '',
      employeeId: json['employeeId'] as String? ?? '',
      auditId: json['auditId'] as String? ?? '',
      status: json['status'] as String? ?? 'active',
      startedAt: json['startedAt'] as String? ?? '',
      endedAt: json['endedAt'] as String?,
      overallRiskScore: (json['overallRiskScore'] as num?)?.toDouble() ?? 0.0,
      lastRiskPayload: json['lastRiskPayload'] != null
          ? RiskAssessmentPayload.fromJson(
              json['lastRiskPayload'] as Map<String, dynamic>,
            )
          : null,
      eventCount: json['eventCount'] as int? ?? 0,
      pasteCount: json['pasteCount'] as int? ?? 0,
      tabSwitchCount: json['tabSwitchCount'] as int? ?? 0,
      copyAttemptCount: json['copyAttemptCount'] as int? ?? 0,
      timeline:
          (json['timeline'] as List<dynamic>?)
              ?.map((e) => e as Map<String, dynamic>)
              .toList() ??
          [],
      codeSubmission: json['codeSubmission'] as String? ?? '',
      peakRiskScore: (json['peakRiskScore'] as num?)?.toDouble() ?? 0.0,
      targetSystem:
          json['targetSystem'] as String? ??
          json['targetSystemLabel'] as String? ??
          '',
    );
  }
}

/// Deployed guardrail audit session returned by POST /api/v1/guardian/deploy.
class AuditSession {
  final String sessionId;
  final String employeeId;
  final String matrixId;
  final String targetSystem;
  final String status;
  final String startedAt;
  final String? endedAt;
  final double currentRiskScore;
  final int eventCount;
  final String createdAt;

  const AuditSession({
    required this.sessionId,
    required this.employeeId,
    this.matrixId = '',
    this.targetSystem = '',
    this.status = 'deployed',
    this.startedAt = '',
    this.endedAt,
    this.currentRiskScore = 0.0,
    this.eventCount = 0,
    this.createdAt = '',
  });

  factory AuditSession.fromJson(Map<String, dynamic> json) {
    return AuditSession(
      sessionId: json['sessionId'] as String? ?? '',
      employeeId: json['employeeId'] as String? ?? '',
      matrixId: json['matrixId'] as String? ?? '',
      targetSystem: json['targetSystem'] as String? ?? '',
      status: json['status'] as String? ?? 'deployed',
      startedAt: json['startedAt'] as String? ?? '',
      endedAt: json['endedAt'] as String?,
      currentRiskScore: (json['currentRiskScore'] as num?)?.toDouble() ?? 0.0,
      eventCount: json['eventCount'] as int? ?? 0,
      createdAt: json['createdAt'] as String? ?? '',
    );
  }
}

/// Response from the ingestion endpoint.
class IngestMicroEventResponse {
  final bool success;
  final int processedCount;
  final RiskAssessmentPayload? riskPayload;
  final bool alertTriggered;
  final double anomalyRiskIndex;

  const IngestMicroEventResponse({
    required this.success,
    required this.processedCount,
    required this.riskPayload,
    required this.alertTriggered,
    required this.anomalyRiskIndex,
  });

  factory IngestMicroEventResponse.fromJson(Map<String, dynamic> json) {
    return IngestMicroEventResponse(
      success: json['success'] as bool? ?? false,
      processedCount: json['processedCount'] as int? ?? 0,
      riskPayload: json['riskPayload'] != null
          ? RiskAssessmentPayload.fromJson(
              json['riskPayload'] as Map<String, dynamic>,
            )
          : null,
      alertTriggered: json['alertTriggered'] as bool? ?? false,
      anomalyRiskIndex: (json['anomalyRiskIndex'] as num?)?.toDouble() ?? 0.0,
    );
  }
}

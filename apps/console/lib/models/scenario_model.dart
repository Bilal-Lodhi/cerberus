// ═══════════════════════════════════════════════════════════════════
// Cerberus — Threat Scenario Matrix Model
// ═══════════════════════════════════════════════════════════════════
// Models the structured JSON output contract from the Cerberus API
// threat-scenario authoring endpoint, backed by the OpenAI-backed provider.
//
// Field names match the TypeScript types in apps/api/src/types.ts exactly
// (camelCase). The API response envelope is:
//   { success, matrix, mcpCorrelationId, persisted, generationRequestId }
//
// DEFENSIVE PARSING: All .map() chains over List<dynamic> include a
// .whereType<Map<String, dynamic>>() guard so that a malformed
// payload (a plain string in place of an array-of-objects) does not
// crash the Flutter app (TypeError: type 'String' is not a subtype
// of type 'Map<String, dynamic>').

class ThreatScenarioMatrix {
  final ThreatScenarioMetadata metadata;
  final List<TargetSystemDescriptor> targetSystems;
  final List<RegulatoryMandate> regulatoryMandates;
  final List<ThreatVector> threatVectors;
  final List<PenetrationScenarioDescriptor> penetrationScenarios;

  const ThreatScenarioMatrix({
    required this.metadata,
    required this.targetSystems,
    required this.regulatoryMandates,
    required this.threatVectors,
    required this.penetrationScenarios,
  });

  factory ThreatScenarioMatrix.fromJson(Map<String, dynamic> json) {
    return ThreatScenarioMatrix(
      metadata: ThreatScenarioMetadata.fromJson(
        (json['metadata'] as Map<String, dynamic>?) ?? const {},
      ),
      targetSystems: (json['targetSystems'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .map((r) => TargetSystemDescriptor.fromJson(r))
          .toList(),
      regulatoryMandates: (json['regulatoryMandates'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .map((c) => RegulatoryMandate.fromJson(c))
          .toList(),
      threatVectors: (json['threatVectors'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .map((p) => ThreatVector.fromJson(p))
          .toList(),
      penetrationScenarios:
          (json['penetrationScenarios'] as List<dynamic>? ?? [])
              .whereType<Map<String, dynamic>>()
              .map((m) => PenetrationScenarioDescriptor.fromJson(m))
              .toList(),
    );
  }
}

// ── Metadata ─────────────────────────────────────────────────────────────

class ThreatScenarioMetadata {
  final String matrixId;
  final String generatedAt;
  final String modelVersion;
  final String promptFingerprint;
  final TokenUsageStats tokenUsage;

  const ThreatScenarioMetadata({
    required this.matrixId,
    required this.generatedAt,
    required this.modelVersion,
    required this.promptFingerprint,
    required this.tokenUsage,
  });

  factory ThreatScenarioMetadata.fromJson(Map<String, dynamic> json) {
    return ThreatScenarioMetadata(
      matrixId: json['matrixId'] as String? ?? '',
      generatedAt: json['generatedAt'] as String? ?? '',
      modelVersion: json['modelVersion'] as String? ?? '',
      promptFingerprint: json['promptFingerprint'] as String? ?? '',
      tokenUsage: TokenUsageStats.fromJson(
        (json['tokenUsage'] as Map<String, dynamic>?) ?? const {},
      ),
    );
  }
}

class TokenUsageStats {
  final int promptTokens;
  final int completionTokens;
  final int totalTokens;

  const TokenUsageStats({
    required this.promptTokens,
    required this.completionTokens,
    required this.totalTokens,
  });

  factory TokenUsageStats.fromJson(Map<String, dynamic> json) {
    return TokenUsageStats(
      promptTokens: (json['promptTokens'] as num?)?.toInt() ?? 0,
      completionTokens: (json['completionTokens'] as num?)?.toInt() ?? 0,
      totalTokens: (json['totalTokens'] as num?)?.toInt() ?? 0,
    );
  }
}

// ── Monitored Target Systems ─────────────────────────────────────────────

class TargetSystemDescriptor {
  final String systemId;
  final String name;
  final String criticalityLevel;
  final List<String> requiredMandateIds;
  final String description;
  final List<String> examples;

  const TargetSystemDescriptor({
    required this.systemId,
    required this.name,
    required this.criticalityLevel,
    required this.requiredMandateIds,
    required this.description,
    required this.examples,
  });

  factory TargetSystemDescriptor.fromJson(Map<String, dynamic> json) {
    return TargetSystemDescriptor(
      systemId: json['systemId'] as String? ?? '',
      name: json['name'] as String? ?? '',
      criticalityLevel: json['criticalityLevel'] as String? ?? '',
      requiredMandateIds: (json['requiredMandateIds'] as List<dynamic>? ?? [])
          .whereType<String>()
          .toList(),
      description: json['description'] as String? ?? '',
      examples: (json['examples'] as List<dynamic>? ?? [])
          .whereType<String>()
          .toList(),
    );
  }
}

// ── Regulatory Mandates ──────────────────────────────────────────────────

class RegulatoryMandate {
  final String mandateId;
  final String name;
  final String description;
  final double weight;
  final List<RegulatoryMandate> subMandates;
  final String regulationCode;

  const RegulatoryMandate({
    required this.mandateId,
    required this.name,
    required this.description,
    required this.weight,
    required this.subMandates,
    required this.regulationCode,
  });

  factory RegulatoryMandate.fromJson(Map<String, dynamic> json) {
    return RegulatoryMandate(
      mandateId: json['mandateId'] as String? ?? '',
      name: json['name'] as String? ?? '',
      description: json['description'] as String? ?? '',
      weight: (json['weight'] as num?)?.toDouble() ?? 0.0,
      // DEFENSIVE: a malformed payload may return a plain string like
      // "Req 3.4 (Encryption)" instead of an array of objects. The .where()
      // guard prevents:
      //   TypeError: type 'String' is not a subtype of type 'Map<String, dynamic>'
      subMandates: (json['subMandates'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .map((s) => RegulatoryMandate.fromJson(s))
          .toList(),
      regulationCode: json['regulationCode'] as String? ?? '',
    );
  }
}

// ── Threat Vectors ───────────────────────────────────────────────────────

class ThreatVector {
  final String vectorId;
  final String vectorType;
  final String title;
  final String description;
  final String? language;
  final String? workspaceSeed;
  final List<DetectionRule> detectionRules;
  final List<MitigationOption> mitigations;
  final String? expectedRemediation;
  final String severity;
  final String mandateId;
  final int investigationTimeMinutes;
  final double riskScore;
  final String targetSystemId;
  final String? exploitScenario;

  const ThreatVector({
    required this.vectorId,
    required this.vectorType,
    required this.title,
    required this.description,
    required this.language,
    required this.workspaceSeed,
    required this.detectionRules,
    required this.mitigations,
    required this.expectedRemediation,
    required this.severity,
    required this.mandateId,
    required this.investigationTimeMinutes,
    required this.riskScore,
    required this.targetSystemId,
    required this.exploitScenario,
  });

  factory ThreatVector.fromJson(Map<String, dynamic> json) {
    return ThreatVector(
      vectorId: json['vectorId'] as String? ?? '',
      vectorType: json['vectorType'] as String? ?? '',
      title: json['title'] as String? ?? '',
      description: json['description'] as String? ?? '',
      language: json['language'] as String?,
      workspaceSeed: json['workspaceSeed'] as String?,
      detectionRules: (json['detectionRules'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .map((t) => DetectionRule.fromJson(t))
          .toList(),
      // The server does not emit mitigation options on a threat vector.
      // They are parsed defensively from the same legacy JSON key so the
      // existing panel keeps rendering (an empty list) when absent.
      mitigations: (json['options'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .map((o) => MitigationOption.fromJson(o))
          .toList(),
      expectedRemediation: json['expectedRemediation'] as String?,
      severity: json['severity'] as String? ?? '',
      mandateId: json['mandateId'] as String? ?? '',
      investigationTimeMinutes:
          (json['investigationTimeMinutes'] as num?)?.toInt() ?? 0,
      riskScore: (json['riskScore'] as num?)?.toDouble() ?? 0.0,
      targetSystemId: json['targetSystemId'] as String? ?? '',
      exploitScenario: json['exploitScenario'] as String?,
    );
  }
}

// ── Detection Rules (telemetry patterns attached to a vector) ────────────

class DetectionRule {
  final String ruleId;
  final String signalPattern;
  final String expectedSignal;
  final bool isBaseline;
  final int evaluationWindowMs;

  const DetectionRule({
    required this.ruleId,
    required this.signalPattern,
    required this.expectedSignal,
    required this.isBaseline,
    required this.evaluationWindowMs,
  });

  factory DetectionRule.fromJson(Map<String, dynamic> json) {
    return DetectionRule(
      ruleId: json['ruleId'] as String? ?? '',
      signalPattern: json['signalPattern'] as String? ?? '',
      expectedSignal: json['expectedSignal'] as String? ?? '',
      isBaseline: json['isBaseline'] as bool? ?? false,
      evaluationWindowMs: (json['evaluationWindowMs'] as num?)?.toInt() ?? 0,
    );
  }
}

// ── Mitigation Options ───────────────────────────────────────────────────

class MitigationOption {
  final String optionId;
  final String text;
  final bool isRecommended;
  final String? rationale;

  const MitigationOption({
    required this.optionId,
    required this.text,
    required this.isRecommended,
    required this.rationale,
  });

  factory MitigationOption.fromJson(Map<String, dynamic> json) {
    return MitigationOption(
      optionId: json['optionId'] as String? ?? '',
      text: json['text'] as String? ?? '',
      isRecommended: json['isRecommended'] as bool? ?? false,
      rationale: json['rationale'] as String?,
    );
  }
}

// ── Penetration Scenarios ────────────────────────────────────────────────

class PenetrationScenarioDescriptor {
  final String scenarioId;
  final String vectorId;
  final List<String> mandateIds;
  final String description;
  final String? exploitCode;
  final ScoringFormula scoringFormula;
  final AntiExfiltrationThresholds antiExfiltrationThresholds;

  const PenetrationScenarioDescriptor({
    required this.scenarioId,
    required this.vectorId,
    required this.mandateIds,
    required this.description,
    required this.exploitCode,
    required this.scoringFormula,
    required this.antiExfiltrationThresholds,
  });

  factory PenetrationScenarioDescriptor.fromJson(Map<String, dynamic> json) {
    return PenetrationScenarioDescriptor(
      scenarioId: json['scenarioId'] as String? ?? '',
      vectorId: json['vectorId'] as String? ?? '',
      mandateIds: (json['mandateIds'] as List<dynamic>? ?? [])
          .whereType<String>()
          .toList(),
      description: json['description'] as String? ?? '',
      exploitCode: json['exploitCode'] as String?,
      scoringFormula: ScoringFormula.fromJson(
        (json['scoringFormula'] as Map<String, dynamic>?) ?? const {},
      ),
      antiExfiltrationThresholds: AntiExfiltrationThresholds.fromJson(
        (json['antiExfiltrationThresholds'] as Map<String, dynamic>?) ??
            const {},
      ),
    );
  }
}

class ScoringFormula {
  final String type;
  final Map<String, double> weights;

  const ScoringFormula({required this.type, required this.weights});

  factory ScoringFormula.fromJson(Map<String, dynamic> json) {
    final rawWeights = json['weights'] as Map<String, dynamic>? ?? const {};
    final weights = <String, double>{};
    rawWeights.forEach((key, value) {
      if (value is num) weights[key] = value.toDouble();
    });
    return ScoringFormula(
      type: json['type'] as String? ?? '',
      weights: weights,
    );
  }
}

/// Telemetry thresholds that define a data-exfiltration breach for one
/// penetration scenario. Every value has a safe default so a partial or
/// absent object never throws during parsing.
class AntiExfiltrationThresholds {
  final int maxPasteEvents;
  final int maxTimeBetweenKeystrokesMs;
  final double dataLeakageSimilarityThreshold;
  final double behavioralAnomalySensitivity;
  final int maxCopyAttempts;
  final int maxWindowBlurEvents;

  const AntiExfiltrationThresholds({
    this.maxPasteEvents = 0,
    this.maxTimeBetweenKeystrokesMs = 0,
    this.dataLeakageSimilarityThreshold = 0.0,
    this.behavioralAnomalySensitivity = 0.0,
    this.maxCopyAttempts = 0,
    this.maxWindowBlurEvents = 0,
  });

  factory AntiExfiltrationThresholds.fromJson(Map<String, dynamic> json) {
    return AntiExfiltrationThresholds(
      maxPasteEvents: (json['maxPasteEvents'] as num?)?.toInt() ?? 0,
      maxTimeBetweenKeystrokesMs:
          (json['maxTimeBetweenKeystrokesMs'] as num?)?.toInt() ?? 0,
      dataLeakageSimilarityThreshold:
          (json['dataLeakageSimilarityThreshold'] as num?)?.toDouble() ?? 0.0,
      behavioralAnomalySensitivity:
          (json['behavioralAnomalySensitivity'] as num?)?.toDouble() ?? 0.0,
      maxCopyAttempts: (json['maxCopyAttempts'] as num?)?.toInt() ?? 0,
      maxWindowBlurEvents: (json['maxWindowBlurEvents'] as num?)?.toInt() ?? 0,
    );
  }
}

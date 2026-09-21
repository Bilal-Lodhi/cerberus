// ═══════════════════════════════════════════════════════════════════
// Cerberus FinSec — Compliance Policy & Threat Matrix Generator Model
// ═══════════════════════════════════════════════════════════════════
// Models the structured JSON output contract from the Hono API
// Orchestrator backed by Gemini 3 Flash Preview.
//
// Field names match the TypeScript types in
// sandbox/hono-api/src/types.ts exactly (camelCase).
// The API response envelope is:
//   { success: bool, matrix: ComplianceMatrix, mcpCorrelationId: string }
//
// DEFENSIVE PARSING: All .map() chains over List<dynamic> include a
// .where((e) => e is Map<String, dynamic>) guard so that Gemini
// returning a plain string in place of an array-of-objects does not
// crash the Flutter app (TypeError: type 'String' is not a subtype
// of type 'Map<String, dynamic>').

class ComplianceMatrix {
  final MatrixMetadata metadata;
  final List<TargetSystemDescriptor> targetSystems;
  final List<RegulatoryMandate> regulatoryMandates;
  final List<ThreatVector> threatVectors;
  final List<AuditTrailMatrix> auditTrailMatrices;

  const ComplianceMatrix({
    required this.metadata,
    required this.targetSystems,
    required this.regulatoryMandates,
    required this.threatVectors,
    required this.auditTrailMatrices,
  });

  factory ComplianceMatrix.fromJson(Map<String, dynamic> json) {
    return ComplianceMatrix(
      metadata: MatrixMetadata.fromJson(
        (json['metadata'] as Map<String, dynamic>?) ?? const {},
      ),
      targetSystems: (json['targetSystems'] as List<dynamic>? ?? [])
          .where((e) => e is Map<String, dynamic>)
          .map(
            (r) => TargetSystemDescriptor.fromJson(r as Map<String, dynamic>),
          )
          .toList(),
      regulatoryMandates: (json['regulatoryMandates'] as List<dynamic>? ?? [])
          .where((e) => e is Map<String, dynamic>)
          .map((c) => RegulatoryMandate.fromJson(c as Map<String, dynamic>))
          .toList(),
      threatVectors: (json['threatVectors'] as List<dynamic>? ?? [])
          .where((e) => e is Map<String, dynamic>)
          .map((p) => ThreatVector.fromJson(p as Map<String, dynamic>))
          .toList(),
      auditTrailMatrices: (json['auditTrailMatrices'] as List<dynamic>? ?? [])
          .where((e) => e is Map<String, dynamic>)
          .map((m) => AuditTrailMatrix.fromJson(m as Map<String, dynamic>))
          .toList(),
    );
  }
}

// ── Metadata ─────────────────────────────────────────────────────────────

class MatrixMetadata {
  final String matrixId;
  final String generatedAt;
  final String modelVersion;
  final String promptFingerprint;
  final TokenUsageStats tokenUsage;

  const MatrixMetadata({
    required this.matrixId,
    required this.generatedAt,
    required this.modelVersion,
    required this.promptFingerprint,
    required this.tokenUsage,
  });

  factory MatrixMetadata.fromJson(Map<String, dynamic> json) {
    return MatrixMetadata(
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
      promptTokens: json['promptTokens'] as int? ?? 0,
      completionTokens: json['completionTokens'] as int? ?? 0,
      totalTokens: json['totalTokens'] as int? ?? 0,
    );
  }
}

// ── Target Systems (was Roles/Domains) ───────────────────────────────────

class TargetSystemDescriptor {
  final String systemId;
  final String title;
  final String criticalityTier;
  final List<String> requiredMandateIds;

  const TargetSystemDescriptor({
    required this.systemId,
    required this.title,
    required this.criticalityTier,
    required this.requiredMandateIds,
  });

  factory TargetSystemDescriptor.fromJson(Map<String, dynamic> json) {
    return TargetSystemDescriptor(
      systemId: json['systemId'] as String? ?? '',
      title: json['title'] as String? ?? '',
      criticalityTier: json['criticalityTier'] as String? ?? '',
      requiredMandateIds: (json['requiredMandateIds'] as List<dynamic>? ?? [])
          .whereType<String>()
          .toList(),
    );
  }
}

// ── Regulatory Mandates (was Competencies) ───────────────────────────────

class RegulatoryMandate {
  final String mandateId;
  final String name;
  final String description;
  final double weight;
  final List<RegulatoryMandate> subMandates;

  const RegulatoryMandate({
    required this.mandateId,
    required this.name,
    required this.description,
    required this.weight,
    required this.subMandates,
  });

  factory RegulatoryMandate.fromJson(Map<String, dynamic> json) {
    return RegulatoryMandate(
      mandateId: json['mandateId'] as String? ?? '',
      name: json['name'] as String? ?? '',
      description: json['description'] as String? ?? '',
      weight: (json['weight'] as num?)?.toDouble() ?? 0.0,
      // DEFENSIVE: Gemini may return a plain string like "Req 3.4 (Encryption)"
      // instead of an array of objects. The .where() guard prevents:
      //   TypeError: type 'String' is not a subtype of type 'Map<String, dynamic>'
      subMandates: (json['subMandates'] as List<dynamic>? ?? [])
          .where((e) => e is Map<String, dynamic>)
          .map((s) => RegulatoryMandate.fromJson(s as Map<String, dynamic>))
          .toList(),
    );
  }
}

// ── Threat Vectors (was Problems/Test Cases) ─────────────────────────────

class ThreatVector {
  final String vectorId;
  final String vectorType;
  final String title;
  final String body;
  final String? language;
  final String? starterCode;
  final List<PenetrationScenario> scenarios;
  final List<MitigationOption> options;
  final String? expectedAnswer;
  final String severityLevel;
  final String mandateId;
  final int auditWindowSeconds;
  final int maxRiskScore;

  const ThreatVector({
    required this.vectorId,
    required this.vectorType,
    required this.title,
    required this.body,
    required this.language,
    required this.starterCode,
    required this.scenarios,
    required this.options,
    required this.expectedAnswer,
    required this.severityLevel,
    required this.mandateId,
    required this.auditWindowSeconds,
    required this.maxRiskScore,
  });

  factory ThreatVector.fromJson(Map<String, dynamic> json) {
    return ThreatVector(
      vectorId: json['vectorId'] as String? ?? '',
      vectorType: json['vectorType'] as String? ?? '',
      title: json['title'] as String? ?? '',
      body: json['body'] as String? ?? '',
      language: json['language'] as String?,
      starterCode: json['starterCode'] as String?,
      scenarios: (json['scenarios'] as List<dynamic>? ?? [])
          .where((e) => e is Map<String, dynamic>)
          .map((t) => PenetrationScenario.fromJson(t as Map<String, dynamic>))
          .toList(),
      options: (json['options'] as List<dynamic>? ?? [])
          .where((e) => e is Map<String, dynamic>)
          .map((o) => MitigationOption.fromJson(o as Map<String, dynamic>))
          .toList(),
      expectedAnswer: json['expectedAnswer'] as String?,
      severityLevel: json['severityLevel'] as String? ?? '',
      mandateId: json['mandateId'] as String? ?? '',
      auditWindowSeconds: json['auditWindowSeconds'] as int? ?? 0,
      maxRiskScore: json['maxRiskScore'] as int? ?? 0,
    );
  }
}

// ── Penetration Scenarios (was Test Cases) ───────────────────────────────

class PenetrationScenario {
  final String scenarioId;
  final String input;
  final String expectedOutput;
  final bool isExample;
  final String explanation;

  const PenetrationScenario({
    required this.scenarioId,
    required this.input,
    required this.expectedOutput,
    required this.isExample,
    required this.explanation,
  });

  factory PenetrationScenario.fromJson(Map<String, dynamic> json) {
    return PenetrationScenario(
      scenarioId: json['scenarioId'] as String? ?? '',
      input: json['input'] as String? ?? '',
      expectedOutput: json['expectedOutput'] as String? ?? '',
      isExample: json['isExample'] as bool? ?? false,
      explanation: json['explanation'] as String? ?? '',
    );
  }
}

// ── Mitigation Options (was MCQ Options) ─────────────────────────────────

class MitigationOption {
  final String optionId;
  final String text;
  final bool isCorrectMitigation;
  final String? rationale;

  const MitigationOption({
    required this.optionId,
    required this.text,
    required this.isCorrectMitigation,
    required this.rationale,
  });

  factory MitigationOption.fromJson(Map<String, dynamic> json) {
    return MitigationOption(
      optionId: json['optionId'] as String? ?? '',
      text: json['text'] as String? ?? '',
      isCorrectMitigation: json['isCorrectMitigation'] as bool? ?? false,
      rationale: json['rationale'] as String?,
    );
  }
}

// ── Audit Trail Matrices (was Testing Matrices) ──────────────────────────

class AuditTrailMatrix {
  final String matrixId;
  final String mandateId;
  final String vectorId;
  final String trailName;
  final String description;
  final List<String> logSources;
  final List<String> detectionRules;
  final String severityMapping;
  final int escalationThreshold;

  const AuditTrailMatrix({
    required this.matrixId,
    required this.mandateId,
    required this.vectorId,
    required this.trailName,
    required this.description,
    required this.logSources,
    required this.detectionRules,
    required this.severityMapping,
    required this.escalationThreshold,
  });

  factory AuditTrailMatrix.fromJson(Map<String, dynamic> json) {
    return AuditTrailMatrix(
      matrixId: json['matrixId'] as String? ?? '',
      mandateId: json['mandateId'] as String? ?? '',
      vectorId: json['vectorId'] as String? ?? '',
      trailName: json['trailName'] as String? ?? '',
      description: json['description'] as String? ?? '',
      logSources: (json['logSources'] as List<dynamic>? ?? [])
          .whereType<String>()
          .toList(),
      detectionRules: (json['detectionRules'] as List<dynamic>? ?? [])
          .whereType<String>()
          .toList(),
      severityMapping: json['severityMapping'] as String? ?? '',
      escalationThreshold: json['escalationThreshold'] as int? ?? 0,
    );
  }
}

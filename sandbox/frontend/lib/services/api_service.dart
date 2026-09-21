import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

import '../models/health_model.dart';
import '../models/generate_model.dart';
import '../models/guardian_model.dart';
import '../models/identity_model.dart';

/// ─── Cerberus FinSec — API Service ────────────────────────────────────────
/// Thin HTTP / SSE connectivity layer targeting the Hono API gateway.
/// Every call routes through Google Cloud-native fetch bindings (via Dart http)
/// with zero legacy dependencies.

class ComplianceMatrixResult {
  final ComplianceMatrix? matrix;
  final String? generationRequestId;
  final bool cancelled;
  final String? error;

  ComplianceMatrixResult({
    this.matrix,
    this.generationRequestId,
    this.cancelled = false,
    this.error,
  });

  factory ComplianceMatrixResult.fromJson(Map<String, dynamic> json) {
    final cancelled = json['cancelled'] == true;
    final matrixJson = json['matrix'] as Map<String, dynamic>?;
    return ComplianceMatrixResult(
      matrix: matrixJson != null ? ComplianceMatrix.fromJson(matrixJson) : null,
      generationRequestId: json['generationRequestId'] as String?,
      cancelled: cancelled,
      error: json['error'] as String?,
    );
  }
}

class ApiService {
  final String baseUrl;
  final http.Client _client;

  /// Ephemeral session token injected into all API requests after
  /// identity is set. Null = anonymous/no identity.
  String? sessionToken;

  /// Caches the last risk payload yielded from the polling fallback so
  /// that duplicate yields are suppressed when the backend payload has
  /// not changed between poll intervals.
  RiskAssessmentPayload? _lastPolledRiskPayload;

  ApiService({required this.baseUrl}) : _client = http.Client();

  /// Returns headers common to all API calls, including the session
  /// token when an identity has been established.
  Map<String, String> _commonHeaders() {
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (sessionToken != null && sessionToken!.isNotEmpty) {
      headers['X-Session-Token'] = sessionToken!;
    }
    return headers;
  }

  // ── Identity ───────────────────────────────────────────────────────────────
  /// POST /api/v1/identity/set — registers an employee operator identity,
  /// returns ephemeral session token.
  Future<OperatorIdentity> setIdentity({
    required String displayName,
    required String employeeId,
    String? role,
  }) async {
    final uri = Uri.parse('$baseUrl/api/v1/identity/set');
    final body = <String, dynamic>{
      'displayName': displayName,
      'employeeId': employeeId,
    };
    if (role != null && role.isNotEmpty) {
      body['role'] = role;
    }
    final response = await _client
        .post(uri, headers: _commonHeaders(), body: jsonEncode(body))
        .timeout(const Duration(seconds: 10));
    final responseBody = jsonDecode(response.body) as Map<String, dynamic>;
    if (response.statusCode == 201) {
      // Extract nested identity object and session token from the
      // backend envelope: { success, identity: {...}, sessionToken }
      final identityJson =
          responseBody['identity'] as Map<String, dynamic>? ?? {};
      final token = responseBody['sessionToken'] as String?;
      if (token != null && token.isNotEmpty) {
        sessionToken = token;
      }
      return OperatorIdentity.fromJson(identityJson);
    }
    throw ApiException(
      response.statusCode,
      (responseBody['error'] as String?) ?? 'Identity registration failed',
    );
  }

  // ── Health ─────────────────────────────────────────────────────────────────
  Future<HealthStatus> fetchHealth() async {
    final uri = Uri.parse('$baseUrl/health');
    final response = await _client
        .get(uri, headers: _commonHeaders())
        .timeout(const Duration(seconds: 10));
    if (response.statusCode != 200) {
      throw ApiException(response.statusCode, 'Health check failed');
    }
    final body = jsonDecode(response.body) as Map<String, dynamic>;
    return HealthStatus.fromJson(body);
  }

  // ── Compliance Policy & Threat Matrix Generator ────────────────────────────
  Future<ComplianceMatrixResult> generateMatrix(
    String prompt, {
    required int vectorCount,
    required String targetSystemContext,
    String? generationRequestId,
  }) async {
    final uri = Uri.parse('$baseUrl/api/v1/generate');
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (generationRequestId != null && generationRequestId.isNotEmpty) {
      headers['X-Generation-Request-Id'] = generationRequestId;
    }
    http.Response response;
    try {
      response = await _client
          .post(
            uri,
            headers: {..._commonHeaders(), ...headers},
            body: jsonEncode({
              'prompt': prompt,
              'roleContext': targetSystemContext,
              'problemCount': vectorCount,
            }),
          )
          .timeout(const Duration(seconds: 120));
    } on TimeoutException {
      throw ApiException(
        503,
        'Threat matrix generation timed out — Gemini may be overloaded',
      );
    }

    final body = jsonDecode(response.body) as Map<String, dynamic>;

    if (response.statusCode == 200 || response.statusCode == 201) {
      return ComplianceMatrixResult.fromJson(body);
    }

    // ── Extract server-side error detail for better UX ────────────────────
    String detail;
    try {
      detail = (body['error'] as String?) ?? response.body;
      if (detail.isEmpty) detail = response.body;
    } catch (_) {
      detail = response.body.isNotEmpty
          ? response.body.substring(0, Math.min(response.body.length, 256))
          : 'Compliance matrix generation failed';
    }

    throw ApiException(response.statusCode, detail);
  }

  // ── Cancel in-flight generation ─────────────────────────────────────────
  Future<void> cancelGeneration(String generationRequestId) async {
    final uri = Uri.parse('$baseUrl/api/v1/generate/cancel');
    try {
      await _client
          .post(
            uri,
            headers: _commonHeaders(),
            body: jsonEncode({'generationRequestId': generationRequestId}),
          )
          .timeout(const Duration(seconds: 10));
    } catch (_) {
      // If cancel request itself fails (e.g. network), the generation
      // will still complete or time out naturally — safe to ignore.
    }
  }

  // ── Live Audit Stream (SSE with Polling Fallback) ──────────────────────────
  Stream<RiskAssessmentPayload> streamAuditEvents(
    String sessionId, {
    Duration pollInterval = const Duration(seconds: 5),
  }) async* {
    final uri = Uri.parse('$baseUrl/api/v1/guardian/stream/$sessionId');

    try {
      final request = http.Request('GET', uri);
      request.headers.addAll(_commonHeaders());
      final streamedResponse = await _client
          .send(request)
          .timeout(const Duration(seconds: 15));

      if (streamedResponse.statusCode == 200) {
        // ── SSE streaming active ─────────────────────────────────────────────
        final lineStream = streamedResponse.stream
            .transform(utf8.decoder)
            .transform(const LineSplitter());

        await for (final line in lineStream) {
          if (line.startsWith('data: ')) {
            final raw = line.substring(6).trim();
            if (raw.isEmpty || raw == '[DONE]') continue;
            try {
              final json = jsonDecode(raw) as Map<String, dynamic>;
              yield RiskAssessmentPayload.fromJson(json);
            } catch (_) {
              // Skip malformed events
            }
          }
        }
        return; // SSE stream ended naturally
      }
    } on Exception {
      // SSE unavailable — fall through to polling
    }

    // ── Polling Fallback ────────────────────────────────────────────────────
    while (true) {
      try {
        final review = await fetchAuditRecord(sessionId);
        final payload = review.lastRiskPayload;
        if (payload != null && _isNewPolledPayload(payload)) {
          _lastPolledRiskPayload = payload;
          yield payload;
        }
      } catch (_) {
        // Silently swallow polling errors to keep the stream alive
      }
      await Future.delayed(pollInterval);
    }
  }

  // ── Ingest Micro-Events ────────────────────────────────────────────────────
  /// Submits employee terminal behavioral telemetry events to the Hono Guardian
  /// endpoint for real-time risk analysis. Returns the ingestion response
  /// with anomaly risk index scoring.
  Future<IngestMicroEventResponse> ingestMicroEvents(
    List<MicroEvent> events,
  ) async {
    final uri = Uri.parse('$baseUrl/api/v1/guardian/ingest');

    final response = await _client
        .post(
          uri,
          headers: _commonHeaders(),
          body: jsonEncode({'events': events.map((e) => e.toJson()).toList()}),
        )
        .timeout(const Duration(seconds: 15));

    final body = jsonDecode(response.body) as Map<String, dynamic>;
    if (response.statusCode == 200 || response.statusCode == 201) {
      return IngestMicroEventResponse.fromJson(body);
    }
    throw ApiException(
      response.statusCode,
      (body['error'] as String?) ?? 'Micro-event ingestion failed',
    );
  }

  /// POST /api/v1/guardian/deploy — deploys a guardrail matrix to a live
  /// employee terminal session, returning the initialized audit session.
  Future<AuditSession> deployGuardrail({
    required String employeeId,
    required String sessionId,
    required String matrixId,
    String? targetSystem,
  }) async {
    final uri = Uri.parse('$baseUrl/api/v1/guardian/deploy');
    final response = await _client
        .post(
          uri,
          headers: _commonHeaders(),
          body: jsonEncode({
            'employeeUid': employeeId,
            'sessionId': sessionId,
            'matrixId': matrixId,
            'targetSystem': targetSystem ?? 'Core Trading Ledger',
          }),
        )
        .timeout(const Duration(seconds: 15));

    final body = jsonDecode(response.body) as Map<String, dynamic>;
    if (response.statusCode == 200 || response.statusCode == 201) {
      return AuditSession.fromJson(body);
    }
    throw ApiException(
      response.statusCode,
      (body['error'] as String?) ?? 'Guardrail deployment failed',
    );
  }

  // ── Fetch Audit Record ─────────────────────────────────────────────────────
  /// Fetches a single session's full audit review payload.
  /// Calls the review endpoint GET /api/v1/sessions/:sessionId
  /// (returns { success, data: SessionReviewResponse }) first.
  /// Falls back to the guardian session endpoint if the review
  /// endpoint is unavailable (e.g. no MongoDB MCP sidecar).
  Future<ReviewRecord> fetchAuditRecord(String sessionId) async {
    // ── Primary: review endpoint (full timeline + risk reports) ──
    try {
      final reviewUri = Uri.parse('$baseUrl/api/v1/sessions/$sessionId');
      final reviewRes = await _client
          .get(reviewUri, headers: _commonHeaders())
          .timeout(const Duration(seconds: 15));

      if (reviewRes.statusCode == 200) {
        final reviewBody = jsonDecode(reviewRes.body) as Map<String, dynamic>;
        final data = reviewBody['data'] as Map<String, dynamic>?;
        if (data != null) {
          // Map SessionReviewResponse fields to ReviewRecord contract
          return ReviewRecord(
            sessionId: data['sessionId'] as String? ?? sessionId,
            employeeId: data['employeeId'] as String? ?? 'unknown',
            auditId: data['auditId'] as String? ?? '',
            status: data['status'] as String? ?? 'active',
            startedAt: data['startedAt'] as String? ?? '',
            endedAt: data['endedAt'] as String?,
            overallRiskScore:
                (data['finalRiskScore'] as num?)?.toDouble() ?? 0.0,
            lastRiskPayload: _extractLatestRisk(
              data['riskSummary'] as List<dynamic>?,
            ),
            eventCount: (data['timeline'] as List<dynamic>?)?.length ?? 0,
            pasteCount: _countEvents(
              data['timeline'] as List<dynamic>?,
              'PASTE_TRIGGER',
            ),
            tabSwitchCount: _countEvents(
              data['timeline'] as List<dynamic>?,
              'TAB_SWITCH',
            ),
            copyAttemptCount: _countEvents(
              data['timeline'] as List<dynamic>?,
              'COPY_ATTEMPT',
            ),
            timeline:
                (data['timeline'] as List<dynamic>?)
                    ?.map((e) => e as Map<String, dynamic>)
                    .toList() ??
                [],
            codeSubmission: data['terminalContent'] as String? ?? '',
            peakRiskScore: _extractPeakRisk(
              data['riskSummary'] as List<dynamic>?,
            ),
          );
        }
      }
    } catch (_) {
      // Fall through to guardian session endpoint
    }

    // ── Fallback: guardian session endpoint ──
    final uri = Uri.parse('$baseUrl/api/v1/guardian/sessions/$sessionId');
    final response = await _client
        .get(uri, headers: _commonHeaders())
        .timeout(const Duration(seconds: 15));
    if (response.statusCode != 200) {
      throw ApiException(response.statusCode, 'Audit record fetch failed');
    }
    final body = jsonDecode(response.body) as Map<String, dynamic>;

    // Guardian may wrap result under 'session' or 'data' key, or
    // return fields at the top level directly (re-branded schema).
    final session =
        (body['session'] as Map<String, dynamic>?) ??
        (body['data'] as Map<String, dynamic>?) ??
        body;

    return ReviewRecord(
      sessionId: session['sessionId'] as String? ?? sessionId,
      employeeId:
          session['employeeId'] as String? ??
          session['employeeUid'] as String? ??
          'unknown',
      auditId: session['auditId'] as String? ?? '',
      status: session['status'] as String? ?? 'active',
      startedAt:
          session['startedAt'] as String? ??
          session['deployedAt'] as String? ??
          '',
      endedAt: session['endedAt'] as String?,
      eventCount: session['eventCount'] as int? ?? 0,
      pasteCount: session['pasteCount'] as int? ?? 0,
      tabSwitchCount: session['tabSwitchCount'] as int? ?? 0,
      copyAttemptCount: session['copyAttemptCount'] as int? ?? 0,
      overallRiskScore:
          (session['riskIndex'] as num?)?.toDouble() ??
          (session['overallRiskScore'] as num?)?.toDouble() ??
          0.0,
      lastRiskPayload: session['lastRiskPayload'] != null
          ? RiskAssessmentPayload.fromJson(
              session['lastRiskPayload'] as Map<String, dynamic>,
            )
          : null,
      codeSubmission:
          session['currentCode'] as String? ??
          session['codeSubmission'] as String? ??
          '',
      targetSystem:
          session['targetSystem'] as String? ??
          session['targetSystemLabel'] as String? ??
          '',
      timeline:
          (session['timeline'] as List<dynamic>?)
              ?.map((e) => e as Map<String, dynamic>)
              .toList() ??
          [],
      peakRiskScore: (session['peakRiskScore'] as num?)?.toDouble() ?? 0.0,
    );
  }

  /// Extracts the most recent risk payload from the riskSummary array.
  static RiskAssessmentPayload? _extractLatestRisk(List<dynamic>? riskSummary) {
    if (riskSummary == null || riskSummary.isEmpty) return null;
    final latest = riskSummary.last as Map<String, dynamic>?;
    if (latest == null) return null;
    return RiskAssessmentPayload.fromJson(latest);
  }

  /// Counts events of a specific type from the timeline list.
  static int _countEvents(List<dynamic>? timeline, String eventType) {
    if (timeline == null) return 0;
    return timeline
        .where((e) => (e as Map<String, dynamic>)['eventType'] == eventType)
        .length;
  }

  /// Extracts the peak risk score from the riskSummary array.
  static double _extractPeakRisk(List<dynamic>? riskSummary) {
    if (riskSummary == null || riskSummary.isEmpty) return 0.0;
    double peak = 0.0;
    for (final r in riskSummary) {
      final score =
          ((r as Map<String, dynamic>)['overallRiskScore'] as num?)
              ?.toDouble() ??
          0.0;
      if (score > peak) peak = score;
    }
    return peak;
  }

  // ── List All Active Audits (Drawer) ────────────────────────────────────────
  /// Fetches the audit session list from GET /api/v1/sessions (MongoDB-backed
  /// review endpoint) which returns { success, data: [...] }.
  ///
  /// Also queries GET /api/v1/guardian/sessions (in-memory registry) and merges
  /// counts so the drawer always shows accurate event/paste/tab metrics. MCP
  /// enrichment in the review endpoint can silently zero out counts on timeout;
  /// the guardian in-memory data is the authoritative live source.
  Future<List<SessionSummary>> fetchSessions() async {
    // Fetch from BOTH endpoints concurrently
    List<SessionSummary> reviewSessions = [];
    List<SessionSummary> guardianSessions = [];

    // ── MongoDB-backed review endpoint (durable, has all session history) ──
    try {
      final reviewUri = Uri.parse('$baseUrl/api/v1/sessions');
      final reviewRes = await _client
          .get(reviewUri, headers: _commonHeaders())
          .timeout(const Duration(seconds: 15));

      if (reviewRes.statusCode == 200) {
        final reviewBody = jsonDecode(reviewRes.body) as Map<String, dynamic>;
        final data = reviewBody['data'] as List<dynamic>? ?? [];
        reviewSessions = data
            .map((s) => SessionSummary.fromJson(s as Map<String, dynamic>))
            .toList();
      }
    } catch (_) {
      // Non-fatal — guardian in-memory data will serve as fallback
    }

    // ── In-memory guardian session registry (authoritative live counts) ──
    try {
      final guardianUri = Uri.parse('$baseUrl/api/v1/guardian/sessions');
      final guardianRes = await _client
          .get(guardianUri, headers: _commonHeaders())
          .timeout(const Duration(seconds: 15));

      if (guardianRes.statusCode == 200) {
        final guardianBody =
            jsonDecode(guardianRes.body) as Map<String, dynamic>;
        final items = guardianBody['data'] as List<dynamic>? ?? [];
        guardianSessions = items
            .map((s) => SessionSummary.fromJson(s as Map<String, dynamic>))
            .toList();
      }
    } catch (_) {
      // Non-fatal
    }

    // ── Merge: guardian in-memory counts override review MCP-enriched counts ──
    // The guardian endpoint always has accurate event/paste/tab counts because
    // they come from the in-memory sessionStore (never times out).
    final guardianBySessionId = <String, SessionSummary>{};
    for (final gs in guardianSessions) {
      guardianBySessionId[gs.sessionId] = gs;
    }

    if (reviewSessions.isEmpty && guardianSessions.isEmpty) {
      return []; // Both endpoints empty/failed
    }

    // Start with review sessions (durable, has all session metadata)
    // then overlay guardian in-memory counts where available.
    final merged = reviewSessions.map((rs) {
      final gs = guardianBySessionId[rs.sessionId];
      if (gs == null) return rs; // No in-memory enrichment available
      // Override live counters from the in-memory session store
      return SessionSummary(
        sessionId: rs.sessionId,
        employeeId: rs.employeeId,
        employeeUid: rs.employeeUid.isNotEmpty
            ? rs.employeeUid
            : gs.employeeUid,
        auditId: rs.auditId.isNotEmpty ? rs.auditId : gs.auditId,
        matrixId: rs.matrixId.isNotEmpty ? rs.matrixId : gs.matrixId,
        targetSystem: rs.targetSystem.isNotEmpty
            ? rs.targetSystem
            : gs.targetSystem,
        status: rs.status,
        startedAt: rs.startedAt.isNotEmpty ? rs.startedAt : gs.startedAt,
        createdAt: rs.createdAt.isNotEmpty ? rs.createdAt : gs.createdAt,
        lastEventTimestamp: rs.lastEventTimestamp.isNotEmpty
            ? rs.lastEventTimestamp
            : gs.lastEventTimestamp,
        peakRiskScore: gs.peakRiskScore > rs.peakRiskScore
            ? gs.peakRiskScore
            : rs.peakRiskScore,
        suspicionScore: gs.suspicionScore > rs.suspicionScore
            ? gs.suspicionScore
            : rs.suspicionScore,
        eventCount: gs.eventCount > 0 ? gs.eventCount : rs.eventCount,
        pasteCount: gs.pasteCount > 0 ? gs.pasteCount : rs.pasteCount,
        tabSwitchCount: gs.tabSwitchCount > 0
            ? gs.tabSwitchCount
            : rs.tabSwitchCount,
        alertTriggered: gs.alertTriggered || rs.alertTriggered,
      );
    }).toList();

    // Append any guardian-only sessions not in the review list.
    // Collect them first, then sort merged list by startedAt descending
    // so the newest deployed sessions always appear at the top.
    final reviewIds = merged.map((s) => s.sessionId).toSet();
    for (final gs in guardianSessions) {
      if (!reviewIds.contains(gs.sessionId)) {
        merged.add(gs);
      }
    }

    // Sort entire merged list by startedAt descending (newest first)
    merged.sort((a, b) {
      final aTime = DateTime.tryParse(a.startedAt) ?? DateTime(1970);
      final bTime = DateTime.tryParse(b.startedAt) ?? DateTime(1970);
      return bTime.compareTo(aTime);
    });

    return merged;
  }

  /// Sends a POST request to TERMINATE (stop) a live session WITHOUT deleting it.
  /// Marks the session as "terminated" in all layers but preserves the audit trail.
  /// The session remains visible in the drawer and review endpoint as terminated.
  Future<void> terminateSession(String sessionId) async {
    final uri = Uri.parse(
      '$baseUrl/api/v1/guardian/sessions/$sessionId/terminate',
    );
    final res = await _client
        .post(uri, headers: _commonHeaders())
        .timeout(const Duration(seconds: 15));
    if (res.statusCode != 200 && res.statusCode != 404) {
      throw ApiException(
        res.statusCode,
        'Failed to terminate session: ${res.body}',
      );
    }
  }

  /// Sends a DELETE request to PERMANENTLY delete a session from all layers.
  /// Removes the session from in-memory registries AND MongoDB (session doc +
  /// all associated micro-events + suspicion reports). The session will no
  /// longer appear in the drawer or review endpoint.
  Future<void> deleteSession(String sessionId) async {
    final uri = Uri.parse('$baseUrl/api/v1/guardian/sessions/$sessionId');
    final res = await _client
        .delete(uri, headers: _commonHeaders())
        .timeout(const Duration(seconds: 15));
    if (res.statusCode != 200 && res.statusCode != 404) {
      throw ApiException(
        res.statusCode,
        'Failed to delete session: ${res.body}',
      );
    }
  }

  /// Returns true when [payload] differs from [_lastPolledRiskPayload] by
  /// value (not reference), using the UUID [riskAssessmentId] as the
  /// primary identity key.  Falls back to comparing [generatedAt],
  /// [overallRiskScore], and flag sets when UUIDs are empty.
  bool _isNewPolledPayload(RiskAssessmentPayload payload) {
    final last = _lastPolledRiskPayload;
    if (last == null) return true;

    // Primary: unique risk assessment ID (UUID v4).
    if (last.riskAssessmentId.isNotEmpty &&
        payload.riskAssessmentId.isNotEmpty) {
      return last.riskAssessmentId != payload.riskAssessmentId;
    }

    // Fallback: structural equality on the stable signal fields.
    if (last.generatedAt != payload.generatedAt) return true;
    if (last.overallRiskScore != payload.overallRiskScore) return true;

    final lastKeys = last.flags.map((f) => '${f.flagId}|${f.category}').toSet();
    final newKeys = payload.flags
        .map((f) => '${f.flagId}|${f.category}')
        .toSet();
    if (lastKeys.length != newKeys.length) return true;
    if (!lastKeys.containsAll(newKeys)) return true;

    return false; // structurally identical → suppress
  }

  /// Resets the polling fallback cache so that the next poll always yields
  /// fresh data for a new session, even if the payload happens to be
  /// structurally identical to the previous session's last payload.
  void resetPollingCache() {
    _lastPolledRiskPayload = null;
  }

  void dispose() {
    _client.close();
  }
}

class Math {
  static int min(int a, int b) => a < b ? a : b;
}

class ApiException implements Exception {
  final int statusCode;
  final String message;

  const ApiException(this.statusCode, this.message);

  /// 503 Service Unavailable or 504 Gateway Timeout — temporary,
  /// downstream service (Gemini) may recover.
  bool get isRetryable =>
      statusCode == 503 ||
      statusCode == 504 ||
      (statusCode >= 500 && message.toLowerCase().contains('timed out')) ||
      message.toLowerCase().contains('overloaded');

  /// True when auto-retries are appropriate (5xx except explicitly terminal).
  bool get isTransient => statusCode >= 500 && statusCode < 600;

  @override
  String toString() => 'ApiException($statusCode): $message';
}

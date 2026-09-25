import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:cerberus_console/models/severity_mix.dart';
import 'package:cerberus_console/services/api_service.dart';

/// Asserts the exact JSON body the console sends to `POST /api/v1/scenarios`.
///
/// The console used to fold the three risk-distribution sliders into the prompt
/// string and send no structured weights at all. These tests pin the wire
/// contract so the structured `severityMix` cannot silently disappear again.
void main() {
  /// The API's response envelope, reduced to what `authorScenario` parses.
  const responseBody = {
    'success': true,
    'matrix': {
      'metadata': {'matrixId': 'matrix-1'},
      'targetSystems': <dynamic>[],
      'regulatoryMandates': <dynamic>[],
      'threatVectors': <dynamic>[],
      'penetrationScenarios': <dynamic>[],
    },
    'mcpCorrelationId': 'corr-1',
    'generationRequestId': 'gen-1',
  };

  /// Captures the request the service produced.
  ({ApiService api, List<http.Request> requests}) buildService({
    int statusCode = 201,
  }) {
    final requests = <http.Request>[];
    final client = MockClient((request) async {
      requests.add(request);
      return http.Response(
        jsonEncode(responseBody),
        statusCode,
        headers: {'content-type': 'application/json'},
      );
    });
    return (
      api: ApiService(
        baseUrl: 'http://api.test',
        apiKey: 'test-key',
        client: client,
      ),
      requests: requests,
    );
  }

  Future<Map<String, dynamic>> capturedBody(
    Future<void> Function(ApiService api) call,
  ) async {
    final harness = buildService();
    await call(harness.api);
    expect(harness.requests, hasLength(1));
    return jsonDecode(harness.requests.single.body) as Map<String, dynamic>;
  }

  test('sends severityMix as a structured four-key object', () async {
    final body = await capturedBody(
      (api) => api.authorScenario(
        'Audit the SWIFT Gateway',
        vectorCount: 3,
        targetSystemContext: 'swift-gateway',
        severityMix: severityMixFromSliders(
          routine: 0.3,
          elevated: 0.5,
          severe: 0.2,
        ),
      ),
    );

    expect(body.keys.toSet(), {
      'prompt',
      'roleContext',
      'vectorCount',
      'severityMix',
    });

    final mix = body['severityMix'] as Map<String, dynamic>;
    expect(mix.keys.toSet(), {'low', 'medium', 'high', 'critical'});
    expect(mix['low'], closeTo(0.30, 1e-9));
    expect(mix['medium'], closeTo(0.50, 1e-9));
    expect(mix['high'], closeTo(0.12, 1e-9));
    expect(mix['critical'], closeTo(0.08, 1e-9));
  });

  test('the sent mix always sums to one', () async {
    final body = await capturedBody(
      (api) => api.authorScenario(
        'Audit the SWIFT Gateway',
        vectorCount: 1,
        targetSystemContext: 'swift-gateway',
        severityMix: severityMixFromSliders(
          routine: 0.2,
          elevated: 0.2,
          severe: 0.2,
        ),
      ),
    );

    final mix = body['severityMix'] as Map<String, dynamic>;
    final total = mix.values.cast<num>().fold<double>(
      0,
      (sum, value) => sum + value.toDouble(),
    );
    expect(total, closeTo(1.0, 1e-9));
  });

  test('changing the sliders changes the request body', () async {
    Future<Map<String, dynamic>> mixFor({
      required double routine,
      required double elevated,
      required double severe,
    }) => capturedBody(
      (api) => api.authorScenario(
        'Audit the SWIFT Gateway',
        vectorCount: 1,
        targetSystemContext: 'swift-gateway',
        severityMix: severityMixFromSliders(
          routine: routine,
          elevated: elevated,
          severe: severe,
        ),
      ),
    );

    final lowSevere = await mixFor(routine: 0.3, elevated: 0.5, severe: 0.2);
    final highSevere = await mixFor(routine: 0.1, elevated: 0.1, severe: 0.8);

    final before = lowSevere['severityMix'] as Map<String, dynamic>;
    final after = highSevere['severityMix'] as Map<String, dynamic>;

    expect(after['high'] as num, greaterThan(before['high'] as num));
    expect(after['critical'] as num, greaterThan(before['critical'] as num));
    expect(after['low'] as num, lessThan(before['low'] as num));
  });

  test('does not smuggle the risk distribution through the prompt', () async {
    final body = await capturedBody(
      (api) => api.authorScenario(
        'Target System: SWIFT Gateway\n'
        'Number of threat vectors: 3\n'
        'Audit requirements: check token injection',
        vectorCount: 3,
        targetSystemContext: 'swift-gateway',
        severityMix: severityMixFromSliders(
          routine: 0.3,
          elevated: 0.5,
          severe: 0.2,
        ),
      ),
    );

    final prompt = body['prompt'] as String;
    expect(prompt.toLowerCase(), isNot(contains('risk distribution')));
    expect(prompt, isNot(contains('% routine')));
    expect(prompt, isNot(contains('% elevated')));
    // The distribution travels structurally and only structurally.
    expect(body['severityMix'], isNotNull);
  });

  test('sends the generation request id header when supplied', () async {
    final harness = buildService();
    await harness.api.authorScenario(
      'Audit the SWIFT Gateway',
      vectorCount: 1,
      targetSystemContext: 'swift-gateway',
      severityMix: defaultSeverityMix,
      generationRequestId: 'gen-abc',
    );

    final request = harness.requests.single;
    expect(request.url.path, '/api/v1/scenarios');
    expect(request.headers['X-Generation-Request-Id'], 'gen-abc');
    expect(request.headers['Authorization'], 'Bearer test-key');
  });

  test('surfaces a server rejection as an ApiException', () async {
    final client = MockClient(
      (request) async => http.Response(
        jsonEncode({'success': false, 'error': 'classifier rejected'}),
        422,
        headers: {'content-type': 'application/json'},
      ),
    );
    final api = ApiService(
      baseUrl: 'http://api.test',
      apiKey: 'test-key',
      client: client,
    );

    await expectLater(
      api.authorScenario(
        'Audit the SWIFT Gateway',
        vectorCount: 1,
        targetSystemContext: 'swift-gateway',
        severityMix: defaultSeverityMix,
      ),
      throwsA(
        isA<ApiException>()
            .having((e) => e.statusCode, 'statusCode', 422)
            .having(
              (e) => e.message,
              'message',
              contains('classifier rejected'),
            ),
      ),
    );
  });
}

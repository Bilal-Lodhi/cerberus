import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';

import 'package:cerberus_console/models/reference_document.dart';
import 'package:cerberus_console/providers/reference_corpus_provider.dart';
import 'package:cerberus_console/services/api_service.dart';
import 'package:cerberus_console/widgets/reference_corpus_panel.dart';

/// Tests for the operator-managed reference corpus surface.
///
/// The corpus is the text that local similarity matching compares paste content
/// against, and the console is the only place an operator can write to it. These
/// tests pin the wire contract — path, method and body — and the local
/// validation that stands in front of the API's own limits, so a rejected
/// document is reported as a message rather than an exception.
///
/// Every request is served by a `MockClient`: no server, no sleeps.
void main() {
  /// One corpus row exactly as `GET /api/v1/reference-documents` returns it.
  Map<String, dynamic> row({
    String referenceId = 'ref-1',
    String label = 'internal-ledger-snippet',
    List<String> tags = const ['ledger'],
    int charCount = 42,
    String preview = 'ledger reconciliation text',
  }) => {
    'referenceId': referenceId,
    'label': label,
    'tags': tags,
    'charCount': charCount,
    'preview': preview,
    'createdAt': '2026-01-01T00:00:00.000Z',
    'updatedAt': '2026-01-01T00:00:00.000Z',
  };

  http.Response json(Object body, int statusCode) => http.Response(
    jsonEncode(body),
    statusCode,
    headers: {'content-type': 'application/json'},
  );

  /// A provider over a MockClient, plus the requests it produced.
  ({
    ApiService api,
    ReferenceCorpusProvider corpus,
    List<http.Request> requests,
  })
  build({required Future<http.Response> Function(http.Request) handler}) {
    final requests = <http.Request>[];
    final client = MockClient((request) async {
      requests.add(request);
      return handler(request);
    });
    final api = ApiService(
      baseUrl: 'http://api.test',
      apiKey: 'test-key',
      client: client,
    );
    return (api: api, corpus: ReferenceCorpusProvider(api), requests: requests);
  }

  // ── Listing ─────────────────────────────────────────────────────────────────

  test('lists the corpus with labels, tags, sizes and previews', () async {
    final harness = build(
      handler: (_) async => json({
        'success': true,
        'total': 2,
        'data': [
          row(),
          row(
            referenceId: 'ref-2',
            label: 'swift-memo',
            tags: ['swift', 'payments'],
            charCount: 120,
            preview: 'wire instructions for the gateway',
          ),
        ],
      }, 200),
    );

    await harness.corpus.load();

    expect(harness.corpus.error, isNull);
    expect(harness.corpus.isLoading, isFalse);
    expect(harness.corpus.documents, hasLength(2));

    final first = harness.corpus.documents.first;
    expect(first.referenceId, 'ref-1');
    expect(first.label, 'internal-ledger-snippet');
    expect(first.tags, ['ledger']);
    expect(first.charCount, 42);
    expect(first.preview, 'ledger reconciliation text');
    expect(first.createdAt, '2026-01-01T00:00:00.000Z');

    final request = harness.requests.single;
    expect(request.method, 'GET');
    expect(request.url.path, '/api/v1/reference-documents');
    expect(request.headers['Authorization'], 'Bearer test-key');
  });

  test('an empty corpus is an empty list, not an error', () async {
    final harness = build(
      handler: (_) async =>
          json({'success': true, 'total': 0, 'data': <dynamic>[]}, 200),
    );

    await harness.corpus.load();

    expect(harness.corpus.documents, isEmpty);
    expect(harness.corpus.error, isNull);
    expect(harness.corpus.isAtCapacity, isFalse);
  });

  test('the read ceiling is reported once the corpus reaches it', () async {
    final harness = build(
      handler: (_) async => json({
        'success': true,
        'total': maxReferenceDocuments,
        'data': List.generate(
          maxReferenceDocuments,
          (index) => row(referenceId: 'ref-$index'),
        ),
      }, 200),
    );

    await harness.corpus.load();

    expect(harness.corpus.documents, hasLength(maxReferenceDocuments));
    expect(harness.corpus.isAtCapacity, isTrue);
  });

  // ── Adding ──────────────────────────────────────────────────────────────────

  test('adding a document posts the trimmed label, content and tags', () async {
    final harness = build(
      handler: (request) async {
        if (request.method == 'POST') {
          return json({
            'success': true,
            'referenceId': 'ref-9',
            'label': 'ledger-snippet',
            'charCount': 11,
            'tags': ['ledger', 'internal'],
          }, 201);
        }
        return json({
          'success': true,
          'total': 1,
          'data': [
            row(
              referenceId: 'ref-9',
              label: 'ledger-snippet',
              tags: ['ledger', 'internal'],
            ),
          ],
        }, 200);
      },
    );

    final added = await harness.corpus.add(
      label: '  ledger-snippet  ',
      content: '  ledger text  ',
      tags: ['ledger', 'internal'],
    );

    expect(added, isTrue);
    expect(harness.corpus.error, isNull);

    final post = harness.requests.first;
    expect(post.method, 'POST');
    expect(post.url.path, '/api/v1/reference-documents');
    expect(jsonDecode(post.body), {
      'label': 'ledger-snippet',
      'content': 'ledger text',
      'tags': ['ledger', 'internal'],
    });

    // The 201 is the stored row, not a list row (no preview, no timestamps), so
    // the corpus is re-read rather than patched locally.
    expect(harness.requests.last.method, 'GET');
    expect(harness.corpus.documents.single.referenceId, 'ref-9');
  });

  test('the comma-separated tag field drops blanks and trims entries', () {
    expect(parseReferenceTags(' ledger , ,  swift ,, internal '), [
      'ledger',
      'swift',
      'internal',
    ]);
    expect(parseReferenceTags(''), isEmpty);
  });

  // ── Validation (mirrors the API's own limits) ───────────────────────────────

  test('the corpus ceiling mirrors the API, which enforces it server-side', () {
    // The API rejects a create past `MAX_REFERENCE_DOCUMENTS` with
    // `REFERENCE_CORPUS_LIMIT_REACHED`; this is the client's pre-flight copy, so the
    // operator is told before filling in a form. A drift would let the console offer an
    // add the server refuses — or refuse one it would accept.
    expect(maxReferenceDocuments, 200);
  });

  test('a server-side full-corpus refusal is shown to the operator', () async {
    // The pre-flight check cannot know about a corpus another operator filled in the
    // meantime, so the server's own refusal has to reach the operator with its reason.
    final harness = build(
      handler: (_) async => json({
        'success': false,
        'error': 'The reference corpus is full (200 documents). '
            'Remove a document before adding another.',
        'code': 'REFERENCE_CORPUS_LIMIT_REACHED',
        'limit': 200,
      }, 409),
    );

    final added = await harness.corpus.add(
      label: 'one too many',
      content: 'ledger text',
    );

    expect(added, isFalse);
    expect(harness.corpus.error, contains('full'));
    expect(harness.corpus.error, contains('200'));
  });

  test('an over-long label is rejected without sending a request', () async {
    final harness = build(
      handler: (_) async =>
          json({'success': true, 'total': 0, 'data': <dynamic>[]}, 200),
    );

    final added = await harness.corpus.add(
      label: 'l' * (maxReferenceLabelChars + 1),
      content: 'ledger text',
    );

    expect(added, isFalse);
    expect(harness.corpus.error, contains('$maxReferenceLabelChars'));
    expect(harness.requests, isEmpty);
  });

  test('over-long content is rejected without sending a request', () async {
    final harness = build(
      handler: (_) async =>
          json({'success': true, 'total': 0, 'data': <dynamic>[]}, 200),
    );

    final added = await harness.corpus.add(
      label: 'ledger-snippet',
      content: 'c' * (maxReferenceContentChars + 1),
    );

    expect(added, isFalse);
    expect(harness.corpus.error, contains('$maxReferenceContentChars'));
    expect(harness.requests, isEmpty);
  });

  test('too many tags are rejected without sending a request', () async {
    final harness = build(
      handler: (_) async =>
          json({'success': true, 'total': 0, 'data': <dynamic>[]}, 200),
    );

    final added = await harness.corpus.add(
      label: 'ledger-snippet',
      content: 'ledger text',
      tags: List.generate(maxReferenceTags + 1, (index) => 'tag-$index'),
    );

    expect(added, isFalse);
    expect(harness.corpus.error, contains('$maxReferenceTags'));
    expect(harness.requests, isEmpty);
  });

  test('an over-long tag is rejected without sending a request', () async {
    final harness = build(
      handler: (_) async =>
          json({'success': true, 'total': 0, 'data': <dynamic>[]}, 200),
    );

    final added = await harness.corpus.add(
      label: 'ledger-snippet',
      content: 'ledger text',
      tags: ['t' * (maxReferenceTagChars + 1)],
    );

    expect(added, isFalse);
    expect(harness.corpus.error, contains('$maxReferenceTagChars'));
    expect(harness.requests, isEmpty);
  });

  test('an empty label or content is rejected locally', () async {
    final harness = build(
      handler: (_) async =>
          json({'success': true, 'total': 0, 'data': <dynamic>[]}, 200),
    );

    expect(await harness.corpus.add(label: '   ', content: 'text'), isFalse);
    expect(harness.corpus.error, 'Label is required');

    expect(await harness.corpus.add(label: 'label', content: '   '), isFalse);
    expect(harness.corpus.error, 'Content is required');
    expect(harness.requests, isEmpty);
  });

  // ── Deleting ────────────────────────────────────────────────────────────────

  test(
    'deleting calls DELETE on the reference id and re-reads the list',
    () async {
      var lists = 0;
      final harness = build(
        handler: (request) async {
          if (request.method == 'DELETE') {
            return json({
              'success': true,
              'referenceId': 'ref-1',
              'deleted': true,
            }, 200);
          }
          lists++;
          return json({
            'success': true,
            'total': lists == 1 ? 1 : 0,
            'data': lists == 1 ? [row()] : <dynamic>[],
          }, 200);
        },
      );

      await harness.corpus.load();
      expect(harness.corpus.documents, hasLength(1));

      final removed = await harness.corpus.remove('ref-1');

      expect(removed, isTrue);
      expect(harness.corpus.error, isNull);

      final delete = harness.requests.firstWhere(
        (request) => request.method == 'DELETE',
      );
      expect(delete.url.path, '/api/v1/reference-documents/ref-1');
      expect(harness.corpus.documents, isEmpty);
    },
  );

  // ── Failures ────────────────────────────────────────────────────────────────

  test(
    'an unavailable corpus surfaces as an error, not an exception',
    () async {
      final harness = build(
        handler: (_) async => json({
          'success': false,
          'error': 'The reference corpus is currently unavailable.',
          'code': 'REFERENCE_STORE_UNAVAILABLE',
        }, 503),
      );

      // Must complete rather than throw: the panel renders `error`, and an
      // unhandled exception would take the whole dashboard down with it.
      await harness.corpus.load();

      expect(
        harness.corpus.error,
        'The reference corpus is currently unavailable.',
      );
      expect(harness.corpus.isLoading, isFalse);
      expect(harness.corpus.documents, isEmpty);
    },
  );

  test(
    'a rejected add surfaces the server message and keeps the corpus',
    () async {
      final harness = build(
        handler: (_) async => json({
          'success': false,
          'error': "Field 'label' must not be empty",
          'code': 'INVALID_REFERENCE_DOCUMENT',
        }, 400),
      );

      final added = await harness.corpus.add(
        label: 'ledger-snippet',
        content: 'ledger text',
      );

      expect(added, isFalse);
      expect(harness.corpus.error, "Field 'label' must not be empty");
      expect(harness.corpus.documents, isEmpty);
    },
  );

  test('a rejected delete surfaces as an error, not an exception', () async {
    final harness = build(
      handler: (_) async => json({
        'success': false,
        'error': "Reference document 'ref-1' not found",
      }, 404),
    );

    final removed = await harness.corpus.remove('ref-1');

    expect(removed, isFalse);
    expect(harness.corpus.error, "Reference document 'ref-1' not found");
  });

  // ── Panel ───────────────────────────────────────────────────────────────────

  testWidgets('the panel loads on first build and states the provenance', (
    WidgetTester tester,
  ) async {
    final requests = <http.Request>[];
    final client = MockClient((request) async {
      requests.add(request);
      return json({'success': true, 'total': 0, 'data': <dynamic>[]}, 200);
    });
    final api = ApiService(
      baseUrl: 'http://api.test',
      apiKey: 'test-key',
      client: client,
    );
    final corpus = ReferenceCorpusProvider(api);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ChangeNotifierProvider<ReferenceCorpusProvider>.value(
            value: corpus,
            child: const ReferenceCorpusPanel(),
          ),
        ),
      ),
    );
    // One frame for the post-frame load, one for the rebuild it triggers.
    await tester.pump();
    await tester.pump();

    expect(requests.single.url.path, '/api/v1/reference-documents');
    expect(find.text('REFERENCE CORPUS'), findsOneWidget);
    expect(find.text('The corpus is empty'), findsOneWidget);
    // An empty corpus must not read as "nothing to compare against by design":
    // the operator has to be told that Cerberus never fills it in itself.
    expect(
      find.textContaining('Cerberus never populates the corpus itself'),
      findsOneWidget,
    );
  });
}

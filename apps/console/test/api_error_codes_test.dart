/// The console's error-code contract.
///
/// `docs/api-errors.md` §1 states the rule: **a code is a contract, a message is not.** The
/// console used to show the server's `error` string verbatim, which made its wording depend
/// on API prose that the compatibility policy explicitly does not freeze.
///
/// These tests pin the resolution order — code first, then the server's message, then a
/// generic fallback — and pin the codes the console claims to explain, so a code that the
/// API stops returning or renames is a visible failure rather than a panel that quietly
/// degrades to a raw server string.
library;

import 'package:cerberus_console/services/api_error_codes.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('describeApiError', () {
    test('a known code wins over the server message', () {
      // The whole point: the console's wording is its own, so the API may reword freely.
      final message = describeApiError({
        'code': 'SESSION_TERMINATED',
        'error': 'some server prose that may change',
      });

      expect(message, isNot(contains('server prose')));
      expect(message, contains('terminated'));
    });

    test('a known code is explained even with no server message', () {
      final message = describeApiError({
        'code': 'REFERENCE_CORPUS_LIMIT_REACHED',
      });
      expect(message, contains('full'));
      expect(message, contains('Remove a document'));
    });

    test('an unknown code falls back to the server message', () {
      // Degrading to the server's own words is better than a generic string: the server
      // understood the problem and the console did not.
      final message = describeApiError({
        'code': 'SOME_FUTURE_CODE',
        'error': 'The server said something specific.',
      });
      expect(message, 'The server said something specific.');
    });

    test('no code and no message falls back to the caller-supplied text', () {
      expect(
        describeApiError({}, fallback: 'Ingestion failed'),
        'Ingestion failed',
      );
      expect(
        describeApiError(null, fallback: 'Ingestion failed'),
        'Ingestion failed',
      );
    });

    test('an empty server message does not become the displayed error', () {
      expect(
        describeApiError({'error': '   '}, fallback: 'Ingestion failed'),
        'Ingestion failed',
      );
    });

    test('a non-string code or message is ignored rather than crashing', () {
      // A gateway error, a proxy page or a future shape must not throw inside an error
      // handler — that would turn a shown error into an unhandled exception.
      expect(
        describeApiError({
          'code': 42,
          'error': <String>[],
        }, fallback: 'fallback'),
        'fallback',
      );
    });

    test('a known code wins even when the server message is absent', () {
      expect(
        describeApiError({'code': 'RATE_LIMITED'}),
        contains('Too many requests'),
      );
    });
  });

  group('the code census', () {
    /// Every code the console claims to explain.
    ///
    /// Mirrors `docs/api-errors.md`. A code added to the API without an entry here still
    /// works — it falls back to the server message — but the console cannot word it.
    const documented = {
      'UNAUTHENTICATED',
      'PAYLOAD_TOO_LARGE',
      'RATE_LIMITED',
      'NOT_FOUND',
      'INTERNAL_ERROR',
      'SESSION_EXPIRED',
      'SESSION_TERMINATED',
      'SESSION_CONFLICT',
      'SESSION_NOT_FOUND',
      'SESSION_STORE_UNAVAILABLE',
      'INVALID_SESSION_TRANSITION',
      'BATCH_TOO_LARGE',
      'MISSING_EVENT_ID',
      'PROMPT_TOO_LONG',
      'ROLE_CONTEXT_TOO_LONG',
      'CLASSIFIER_UNAVAILABLE',
      'AI_UNAVAILABLE',
      'SCENARIO_GENERATION_FAILED',
      'QUESTION_TOO_LONG',
      'AUDITOR_STORE_UNAVAILABLE',
      'AUDITOR_QUERY_FAILED',
      'INVALID_IDEMPOTENCY_KEY',
      'IDEMPOTENCY_CONFLICT',
      'IDEMPOTENCY_IN_PROGRESS',
      'IDEMPOTENCY_STATE_UNAVAILABLE',
      'INVALID_REFERENCE_DOCUMENT',
      'REFERENCE_CORPUS_LIMIT_REACHED',
      'REFERENCE_STORE_UNAVAILABLE',
      'INVALID_IDENTITY_FIELD',
    };

    test('the console explains every documented code', () {
      final missing = documented.difference(apiErrorMessages.keys.toSet());
      expect(
        missing,
        isEmpty,
        reason: 'the console has no text for: ${missing.join(", ")}',
      );
    });

    test('the console explains no code the API does not document', () {
      final extra = apiErrorMessages.keys.toSet().difference(documented);
      expect(
        extra,
        isEmpty,
        reason:
            'the console explains codes that are not documented: ${extra.join(", ")}',
      );
    });

    test('every message is operator-facing text, not a code echo', () {
      for (final entry in apiErrorMessages.entries) {
        expect(
          entry.value.trim(),
          isNotEmpty,
          reason: '${entry.key} has an empty message',
        );
        expect(
          entry.value,
          isNot(entry.key),
          reason: '${entry.key} just echoes its own code',
        );
        expect(
          entry.value,
          isNot(contains('_')),
          reason: '${entry.key} leaks an identifier into operator-facing text',
        );
      }
    });
  });
}

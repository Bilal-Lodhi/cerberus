/// Stable API error codes, and the text the console shows for each.
///
/// ── Why this exists ───────────────────────────────────────────────────
///
/// The console used to show the server's `error` string verbatim. That works today only
/// because the messages are written for a human — but it makes the console's wording depend
/// on the API's prose, which `docs/api-errors.md` explicitly does **not** treat as a
/// contract. A reworded message would silently change what an operator reads.
///
/// `docs/api-errors.md` §1 states the rule this file implements: **a code is a contract, a
/// message is not.** So the console maps the code to its own text, and falls back to the
/// server's message only for a code it does not know — which is the one case where the
/// server's own words are the best available answer.
///
/// The code list mirrors the API's. `apps/api/test/mcp-tool-mapping.test.ts` asserts the
/// API and the MCP adapter agree on the codes they share; this file is the client's copy,
/// and `test/api_error_codes_test.dart` asserts the ones it knows about are the documented
/// set.
library;

/// The stable codes the console knows how to explain.
///
/// A code absent from this map is shown using the server's message, so an unrecognised code
/// degrades to the previous behaviour rather than to a blank panel.
const Map<String, String> apiErrorMessages = {
  // ── Authentication and transport ──
  'UNAUTHENTICATED':
      'The operator key was not accepted. Check the key this console was built with.',
  'PAYLOAD_TOO_LARGE':
      'The request was too large for the server to accept. Split it and try again.',
  'RATE_LIMITED': 'Too many requests. Wait a moment and try again.',
  'NOT_FOUND': 'That endpoint does not exist.',
  'INTERNAL_ERROR':
      'The server hit an unexpected problem. The details are in its log.',

  // ── Session lifecycle ──
  'SESSION_EXPIRED':
      'This session\'s monitoring window has closed. Reactivate it, or deploy a new one. '
      'Its recorded evidence is retained and still readable.',
  'SESSION_TERMINATED':
      'This session has been terminated, which cannot be undone. Deploy a new session '
      'to resume monitoring. Its recorded evidence is retained.',
  'SESSION_CONFLICT':
      'This session changed while the request was in flight, so nothing was applied. '
      'Reload and try again.',
  'SESSION_NOT_FOUND': 'No session with that id exists.',
  'SESSION_STORE_UNAVAILABLE':
      'The database did not answer, so nothing was changed. Try again shortly.',
  'INVALID_SESSION_TRANSITION':
      'That is not a legal change for this session\'s current state.',

  // ── Telemetry ──
  'BATCH_TOO_LARGE': 'Too many events in one batch. Split it and try again.',
  'MISSING_EVENT_ID':
      'An event arrived without an id. Every event needs one so a retry can be recognised.',

  // ── Scenario authoring ──
  'PROMPT_TOO_LONG': 'The prompt is too long. Shorten it and try again.',
  'ROLE_CONTEXT_TOO_LONG':
      'The system context is too long. Shorten it and try again.',
  'CLASSIFIER_UNAVAILABLE':
      'The request could not be validated because the classifier is unavailable, so '
      'nothing was generated. Try again shortly.',
  'AI_UNAVAILABLE': 'The AI service is busy or unreachable. Try again shortly.',
  'SCENARIO_GENERATION_FAILED': 'Scenario generation failed. Try again.',

  // ── Auditor ──
  'QUESTION_TOO_LONG': 'The question is too long. Shorten it and try again.',
  'AUDITOR_QUERY_FAILED': 'The audit query failed. Try again.',

  // ── Reference corpus ──
  'INVALID_REFERENCE_DOCUMENT':
      'The document was rejected. Check its fields and try again.',
  'REFERENCE_CORPUS_LIMIT_REACHED':
      'The reference corpus is full. Remove a document before adding another.',
  'REFERENCE_STORE_UNAVAILABLE':
      'The reference corpus is unavailable. Try again shortly.',

  // ── Identity ──
  'INVALID_IDENTITY_FIELD':
      'An identity field was rejected. Check it and try again.',
};

/// Codes whose server message carries detail the console cannot supply.
///
/// A code is a *category*; for some categories the specific answer is only in the server's
/// message. `INVALID_REFERENCE_DOCUMENT` covers every bad field, and the server's message
/// names which field and which bound — showing only the console's generic text would lose
/// that, which is a worse experience than the code-first rule is a compatibility win.
///
/// So for these codes the console shows **its own lead sentence, then the server's detail**:
/// the console's framing does not depend on API prose, and the operator still gets the
/// specific field. Neither concern is traded away.
const Set<String> codesThatCarryDetail = {
  'INVALID_REFERENCE_DOCUMENT',
  'INVALID_IDENTITY_FIELD',
  'MISSING_EVENT_ID',
};

/// The message to show for a parsed API error body.
///
/// Resolution order, and the order matters:
///
///   1. **The code**, when the console knows it. This is the contract, so the console's
///      wording does not change when the API rewords a message.
///   2. For a code in [codesThatCarryDetail], the code's lead sentence **plus** the
///      server's message — because there the detail is the actionable part.
///   3. **The server's `error` string**, when the code is unknown or absent. Better than a
///      generic message, because the server understood the problem and the console did not.
///   4. **A generic fallback**, when neither is present — so a panel never shows an empty
///      error.
///
/// `fallback` lets a caller name the operation ("Ingestion failed") for case 4.
String describeApiError(
  Map<String, dynamic>? body, {
  String fallback = 'Request failed',
}) {
  final serverMessage = body?['error'];
  final detail = serverMessage is String && serverMessage.trim().isNotEmpty
      ? serverMessage
      : null;

  final code = body?['code'];
  if (code is String) {
    final known = apiErrorMessages[code];
    if (known != null) {
      if (detail != null && codesThatCarryDetail.contains(code)) {
        return '$known $detail';
      }
      return known;
    }
  }

  return detail ?? fallback;
}

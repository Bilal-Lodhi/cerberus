/// ─── CERBERUS — Reference document ────────────────────────────────────────
///
/// One entry in the operator-managed reference corpus that local text-similarity
/// matching compares paste content against.
///
/// The corpus is an input this console **only ever writes at an operator's
/// request**. Cerberus has no crawler, no bundled corpus and no external
/// reference service, so every document in it arrived through the add form in
/// `widgets/reference_corpus_panel.dart`. That is why the panel states the
/// provenance where the operator can read it: a similarity match is evidence
/// that two pieces of text share phrasing, not a finding that anything was
/// copied.
///
/// The limits below mirror the API's own (`MAX_REFERENCE_*` in
/// `apps/api/src/routes/reference.ts`). They are duplicated deliberately: the
/// operator gets a field-level message while typing, and the server keeps the
/// authoritative check. A client that discovered the limits from a 400 would
/// make every typo cost a round trip.
library;

/// Maximum length of a document's label.
const int maxReferenceLabelChars = 200;

/// Maximum length of a document's content.
const int maxReferenceContentChars = 20000;

/// Maximum number of tags on one document.
const int maxReferenceTags = 20;

/// Maximum length of a single tag.
const int maxReferenceTagChars = 50;

/// How many documents the API will list and compare.
///
/// This is a **read** ceiling, not a store rejection: the list route and the
/// risk-analysis path both load at most this many documents, newest first. A
/// document added past it is stored but never listed here and never compared,
/// which is why the panel warns at the ceiling instead of quietly accepting the
/// add and letting the operator believe it is in force.
const int maxReferenceDocuments = 200;

/// One corpus document as the list endpoint returns it.
class ReferenceDocument {
  final String referenceId;
  final String label;
  final List<String> tags;

  /// Length of the stored content in characters.
  ///
  /// The content itself is never returned by the list endpoint — only
  /// [preview] — because the corpus is re-read in full on every risk analysis
  /// and echoing it back would grow this response with the corpus.
  final int charCount;

  /// A bounded leading slice of the content, for recognition rather than
  /// reading.
  final String preview;

  final String? createdAt;
  final String? updatedAt;

  const ReferenceDocument({
    required this.referenceId,
    required this.label,
    required this.tags,
    required this.charCount,
    required this.preview,
    this.createdAt,
    this.updatedAt,
  });

  factory ReferenceDocument.fromJson(Map<String, dynamic> json) {
    return ReferenceDocument(
      referenceId: json['referenceId'] as String? ?? '',
      label: json['label'] as String? ?? '',
      // Non-string entries are dropped rather than thrown on: one malformed row
      // must not make the whole corpus unreadable in the console.
      tags:
          (json['tags'] as List<dynamic>?)?.whereType<String>().toList() ??
          const <String>[],
      charCount: (json['charCount'] as num?)?.toInt() ?? 0,
      preview: json['preview'] as String? ?? '',
      createdAt: _asTimestamp(json['createdAt']),
      updatedAt: _asTimestamp(json['updatedAt']),
    );
  }
}

/// Splits the panel's comma-separated tag field into the API's `tags` array.
///
/// Blank entries are dropped rather than reported: a trailing comma is a typo,
/// and the API rejects empty tags outright, so forwarding one would turn a
/// harmless keystroke into a 400.
List<String> parseReferenceTags(String raw) => raw
    .split(',')
    .map((tag) => tag.trim())
    .where((tag) => tag.isNotEmpty)
    .toList(growable: false);

/// The message to show for [label], or null when it is acceptable.
///
/// The wording mirrors the API's own rejection text so the same mistake reads
/// the same whether it was caught here or by the server.
String? validateReferenceLabel(String label) {
  final trimmed = label.trim();
  if (trimmed.isEmpty) return 'Label is required';
  if (trimmed.length > maxReferenceLabelChars) {
    return 'Label must be at most $maxReferenceLabelChars characters '
        '(got ${trimmed.length}).';
  }
  return null;
}

/// The message to show for [content], or null when it is acceptable.
String? validateReferenceContent(String content) {
  final trimmed = content.trim();
  if (trimmed.isEmpty) return 'Content is required';
  if (trimmed.length > maxReferenceContentChars) {
    return 'Content must be at most $maxReferenceContentChars characters '
        '(got ${trimmed.length}).';
  }
  return null;
}

/// The message to show for [tags], or null when they are acceptable.
///
/// [tags] is expected in parsed form — see [parseReferenceTags].
String? validateReferenceTags(List<String> tags) {
  if (tags.length > maxReferenceTags) {
    return 'At most $maxReferenceTags tags are allowed (got ${tags.length}).';
  }
  for (final tag in tags) {
    if (tag.length > maxReferenceTagChars) {
      return 'Each tag must be at most $maxReferenceTagChars characters '
          '(got ${tag.length}).';
    }
  }
  return null;
}

/// Accepts the ISO-8601 string the route promises, an epoch-millis number, or
/// null.
///
/// The route forwards whatever the local store held, so a document written
/// before a timestamp format change must not make the whole list fail to parse.
String? _asTimestamp(dynamic value) {
  if (value is String) return value.isEmpty ? null : value;
  if (value is num) {
    return DateTime.fromMillisecondsSinceEpoch(
      value.toInt(),
    ).toUtc().toIso8601String();
  }
  return null;
}

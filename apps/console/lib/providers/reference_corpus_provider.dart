import 'package:flutter/foundation.dart';

import '../models/reference_document.dart';
import '../services/api_service.dart';

/// ─── CERBERUS — Reference corpus provider ─────────────────────────────────
/// State for the operator-managed reference corpus: the local text that paste
/// content is compared against during risk analysis.
///
/// This provider is the only writer in the console. It validates a document
/// against the same limits the API enforces *before* sending it, so an
/// over-long label or tag list costs the operator a message rather than a round
/// trip that ends in a 400. The server still checks — this is convenience, not
/// the boundary.
class ReferenceCorpusProvider extends ChangeNotifier {
  final ApiService _api;

  List<ReferenceDocument> _documents = const <ReferenceDocument>[];
  bool _isLoading = false;
  String? _error;

  ReferenceCorpusProvider(this._api);

  // ── Public state ────────────────────────────────────────────────────────────

  List<ReferenceDocument> get documents => _documents;
  bool get isLoading => _isLoading;
  String? get error => _error;

  /// True once the corpus has reached the API's read ceiling.
  ///
  /// Not a store rejection — the API stores a document past this point but
  /// never lists or compares it — so the panel disables the add and says why,
  /// instead of accepting text the operator would never see again.
  bool get isAtCapacity => _documents.length >= maxReferenceDocuments;

  // ── Load ────────────────────────────────────────────────────────────────────

  /// Re-reads the corpus. Never throws: a failure lands in [error].
  Future<void> load() async {
    _isLoading = true;
    _error = null;
    notifyListeners();

    await _refresh();

    _isLoading = false;
    notifyListeners();
  }

  // ── Add ─────────────────────────────────────────────────────────────────────

  /// Adds one document after validating it locally.
  ///
  /// Returns true when the document was stored. The list is then re-read rather
  /// than patched locally: the store response is not a list row (no preview, no
  /// timestamps), and reconstructing one here would mean this client
  /// re-implementing the server's preview rule and drifting from it.
  Future<bool> add({
    required String label,
    required String content,
    List<String> tags = const <String>[],
  }) async {
    final validationError =
        validateReferenceLabel(label) ??
        validateReferenceContent(content) ??
        validateReferenceTags(tags);
    if (validationError != null) {
      // No request is sent: the API would answer with the same complaint, and
      // the operator would wait a round trip to be told something this client
      // already knows.
      _error = validationError;
      notifyListeners();
      return false;
    }

    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      await _api.storeReferenceDocument(
        label: label.trim(),
        content: content.trim(),
        tags: tags,
      );
    } on ApiException catch (e) {
      _error = e.message;
      _isLoading = false;
      notifyListeners();
      return false;
    } catch (_) {
      _error = 'Could not add the reference document';
      _isLoading = false;
      notifyListeners();
      return false;
    }

    await _refresh();
    _isLoading = false;
    notifyListeners();
    return true;
  }

  // ── Remove ──────────────────────────────────────────────────────────────────

  /// Removes one document. Returns true when it was deleted.
  Future<bool> remove(String referenceId) async {
    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      await _api.deleteReferenceDocument(referenceId);
    } on ApiException catch (e) {
      _error = e.message;
      _isLoading = false;
      notifyListeners();
      return false;
    } catch (_) {
      _error = 'Could not delete the reference document';
      _isLoading = false;
      notifyListeners();
      return false;
    }

    await _refresh();
    _isLoading = false;
    notifyListeners();
    return true;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /// Reads the corpus into [_documents], mapping a failure to [error].
  ///
  /// Separate from [load] so a store or delete can re-read without toggling the
  /// loading flag a second time.
  Future<void> _refresh() async {
    try {
      _documents = await _api.listReferenceDocuments();
    } on ApiException catch (e) {
      _error = e.message;
    } catch (_) {
      _error = 'Could not load the reference corpus';
    }
  }
}

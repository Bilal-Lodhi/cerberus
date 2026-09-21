import 'package:flutter/foundation.dart';
import '../models/guardian_model.dart';
import '../services/api_service.dart';

/// ─── Cerberus FinSec — Review Provider ───────────────────────────────────────
/// Loads session summaries (drawer list) and full audit review records
/// (detail view) for the split-panel live terminal session audit log.

class ReviewProvider extends ChangeNotifier {
  final ApiService _api;

  List<SessionSummary> _sessions = [];
  ReviewRecord? _selected;
  String? _error;
  bool _isLoading = false;

  ReviewProvider(this._api);

  List<SessionSummary> get sessions => _sessions;
  ReviewRecord? get selected => _selected;
  String? get error => _error;
  bool get isLoading => _isLoading;

  Future<void> loadSessions() async {
    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      _sessions = await _api.fetchSessions();
    } on ApiException catch (e) {
      _error = e.message;
    } catch (e) {
      _error = 'Failed to load active audits: $e';
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<void> loadAuditRecord(String sessionId) async {
    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      _selected = await _api.fetchAuditRecord(sessionId);
    } on ApiException catch (e) {
      _error = e.message;
    } catch (e) {
      _error = 'Failed to load audit record: $e';
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  void selectSession(String sessionId) {
    if (_sessions.any((s) => s.sessionId == sessionId)) {
      loadAuditRecord(sessionId);
    }
  }

  void clearSelection() {
    _selected = null;
    notifyListeners();
  }

  Future<void> deleteSession(String sessionId) async {
    try {
      await _api.deleteSession(sessionId);
    } on ApiException catch (_) {
      // Even if the backend call fails, remove from local list and refresh
    } finally {
      _sessions.removeWhere((s) => s.sessionId == sessionId);
      if (_selected?.sessionId == sessionId) {
        _selected = null;
      }
      notifyListeners();
      // Refresh from backend to stay in sync
      loadSessions();
    }
  }
}

import 'package:flutter/foundation.dart';
import '../models/health_model.dart';
import '../services/api_service.dart';

/// ─── Cerberus AI — Health Provider ──────────────────────────────────────────
/// Polls the Hono API gateway health endpoint and surfaces connectivity
/// status for MongoDB, Gemini 3 Flash Preview, and the MCP server.

class HealthProvider extends ChangeNotifier {
  final ApiService _api;
  HealthStatus? _status;
  String? _error;
  bool _isLoading = false;

  HealthProvider(this._api);

  HealthStatus? get status => _status;
  String? get error => _error;
  bool get isLoading => _isLoading;

  Future<void> checkHealth() async {
    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      _status = await _api.fetchHealth();
    } on ApiException catch (e) {
      _error = e.message;
      _status = null;
    } catch (e) {
      _error = 'Health check unreachable: $e';
      _status = null;
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }
}

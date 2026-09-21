import 'package:flutter/foundation.dart';
import '../services/api_service.dart';

/// ─── Cerberus FinSec — Identity Provider ─────────────────────────────────────
/// Lightweight employee/operator identity state management.
/// Stores display name + employee ID + ephemeral session token.
/// Persisted in-memory only; resets on app restart.
///
/// In production, replace this with Firebase Auth or Google Cloud Identity Platform.

class IdentityProvider extends ChangeNotifier {
  final ApiService _apiService;

  String? _displayName;
  String? _employeeId;
  String? _role;
  String? _sessionToken;
  bool _isLoading = false;
  String? _error;

  IdentityProvider(this._apiService);

  // ── Getters ─────────────────────────────────────────────────────────────────

  String? get displayName => _displayName;
  String? get employeeId => _employeeId;
  String? get role => _role;
  String? get sessionToken => _sessionToken;
  bool get isIdentified => _sessionToken != null && _displayName != null;
  bool get isLoading => _isLoading;
  String? get error => _error;

  // ── Register employee identity with the backend ─────────────────────────────

  Future<bool> setIdentity({
    required String displayName,
    required String employeeId,
    String? role,
  }) async {
    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      final response = await _apiService.setIdentity(
        displayName: displayName,
        employeeId: employeeId,
        role: role,
      );

      _sessionToken = _apiService.sessionToken;
      _displayName = response.displayName;
      _employeeId = response.employeeId;
      _role = response.role;

      // Tell ApiService to attach this token to all future requests
      _apiService.sessionToken = _sessionToken;

      _isLoading = false;
      notifyListeners();
      return true;
    } on ApiException catch (e) {
      _error = e.message;
      _isLoading = false;
      notifyListeners();
      return false;
    } catch (e) {
      _error = 'Failed to connect to identity service';
      _isLoading = false;
      notifyListeners();
      return false;
    }
  }

  /// Clear identity (for demo reset).
  void clearIdentity() {
    _sessionToken = null;
    _displayName = null;
    _employeeId = null;
    _role = null;
    _error = null;
    _apiService.sessionToken = null;
    notifyListeners();
  }
}

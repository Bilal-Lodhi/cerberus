import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../models/generate_model.dart';
import '../services/api_service.dart';

/// ─── Cerberus FinSec — Generate Provider ─────────────────────────────────────
/// Holds the state for the Compliance Policy & Threat Matrix Generator.
///
/// Retry strategy:
///   1. On transient 5xx / timeout errors, auto-retry up to 2 more times
///      with exponential backoff + jitter (500ms–4s delay).
///   2. If auto-retries are exhausted, surface a user-facing error state
///      that includes a "Retry" action — the user can manually re-trigger.
///   3. Manual retries send the exact same prompt again; they do NOT
///      count toward the auto-retry limit (the user is in control).

class GenerateProvider extends ChangeNotifier {
  final ApiService _api;

  static const int _maxAutoRetries = 2;
  static const Duration _initialDelay = Duration(seconds: 2);
  static const Duration _maxDelay = Duration(seconds: 8);

  ComplianceMatrix? _matrix;
  String? _error;
  bool _isLoading = false;
  bool _isCancelled = false;
  int _attempt = 0;
  String _lastPrompt = '';
  int _lastVectorCount = 5;
  String _lastTargetSystemContext = '';
  String? _generationRequestId;
  int _generationSeq = 0;

  GenerateProvider(this._api);

  // ── Public getters ──────────────────────────────────────────────────────────

  ComplianceMatrix? get matrix => _matrix;
  String? get error => _error;
  bool get isLoading => _isLoading;
  bool get isCancelled => _isCancelled;
  String? get generationRequestId => _generationRequestId;

  bool get canManualRetry =>
      !_isLoading && _error != null && _lastPrompt.isNotEmpty;

  bool get canResume => _isCancelled && _lastPrompt.isNotEmpty;

  // ── Generate — entry point (auto-retry loop) ────────────────────────────────

  Future<void> generate(
    String prompt, {
    required int vectorCount,
    required String targetSystemContext,
  }) async {
    final trimmed = prompt.trim();
    if (trimmed.isEmpty) {
      _error = 'Prompt must not be empty';
      notifyListeners();
      return;
    }

    _lastPrompt = trimmed;
    _lastVectorCount = vectorCount;
    _lastTargetSystemContext = targetSystemContext;
    _attempt = 0;
    _matrix = null;
    _error = null;
    _isLoading = true;
    _isCancelled = false;

    _generationRequestId = _generateRequestId();
    final seq = ++_generationSeq;

    notifyListeners();

    await _generateWithAutoRetry(
      trimmed,
      vectorCount,
      targetSystemContext,
      seq,
    );
  }

  // ── Manual retry (from UI button) ───────────────────────────────────────────

  Future<void> retry() async {
    if (_lastPrompt.isEmpty) return;
    _isCancelled = false;
    _attempt = 0;
    _matrix = null;
    _error = null;
    _isLoading = true;
    notifyListeners();

    _generationRequestId = _generateRequestId();
    final seq = ++_generationSeq;
    await _generateWithAutoRetry(
      _lastPrompt,
      _lastVectorCount,
      _lastTargetSystemContext,
      seq,
    );
  }

  // ── Cancel in-flight generation ─────────────────────────────────────────────

  Future<void> cancel() async {
    if (_generationRequestId == null) return;
    await _api.cancelGeneration(_generationRequestId!);

    _isCancelled = true;
    _isLoading = false;
    _error = 'Generation cancelled. You can resume with the same settings.';
    _generationRequestId = null;
    notifyListeners();
  }

  // ── Resume after cancellation ───────────────────────────────────────────────

  Future<void> resume() async {
    if (!canResume) return;
    _isCancelled = false;
    _matrix = null;
    _error = null;
    _isLoading = true;
    _attempt = 0;
    notifyListeners();

    _generationRequestId = _generateRequestId();
    final seq = ++_generationSeq;
    await _generateWithAutoRetry(
      _lastPrompt,
      _lastVectorCount,
      _lastTargetSystemContext,
      seq,
    );
  }

  void reset() {
    _matrix = null;
    _error = null;
    _isLoading = false;
    _isCancelled = false;
    _attempt = 0;
    _lastPrompt = '';
    _lastTargetSystemContext = '';
    _generationRequestId = null;
    notifyListeners();
  }

  // ── Internal: auto-retry loop ───────────────────────────────────────────────

  Future<void> _generateWithAutoRetry(
    String prompt,
    int vectorCount,
    String targetSystemContext,
    int seq,
  ) async {
    while (_attempt <= _maxAutoRetries) {
      _attempt++;
      try {
        final result = await _api.generateMatrix(
          prompt,
          vectorCount: vectorCount,
          targetSystemContext: targetSystemContext,
          generationRequestId: _generationRequestId,
        );

        if (result.cancelled) {
          if (seq == _generationSeq) {
            _isCancelled = true;
            _error =
                'Generation cancelled. You can resume with the same settings.';
          }
          break;
        }

        _matrix = result.matrix;
        _generationRequestId = result.generationRequestId;
        _error = null;
        _isCancelled = false;
        break;
      } on ApiException catch (e) {
        if (!e.isTransient || _attempt > _maxAutoRetries) {
          _error = _buildUserMessage(e);
          break;
        }
        await _backoff(_attempt);
      } catch (e) {
        _error = 'Generation failed: $e';
        break;
      }
    }

    if (seq == _generationSeq) {
      _isLoading = false;
      notifyListeners();
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  String _generateRequestId() {
    final r = Random();
    String hex(int length) =>
        List.generate(length, (_) => r.nextInt(16).toRadixString(16)).join();
    return '${hex(8)}-${hex(4)}-4${hex(3)}-${hex(3)}-${hex(12)}';
  }

  Future<void> _backoff(int attempt) async {
    final rng = Random();
    final jitter = rng.nextInt(500);
    final base = _initialDelay * pow(2, attempt - 1);
    final delay = Duration(
      milliseconds: (base.inMilliseconds + jitter).clamp(
        _initialDelay.inMilliseconds,
        _maxDelay.inMilliseconds,
      ),
    );
    debugPrint(
      '[GenerateProvider] Auto-retry in ${delay.inMilliseconds}ms (attempt $attempt/$_maxAutoRetries)',
    );
    await Future<void>.delayed(delay);
  }

  String _buildUserMessage(ApiException e) {
    if (e.statusCode == 503) {
      return 'Gemini is currently busy. Please try again in a moment.';
    }
    if (e.statusCode == 504) {
      return 'Gemini is taking too long to respond. Please try again shortly.';
    }
    if (e.statusCode == 429) {
      return 'Rate limit reached. Please wait and retry.';
    }
    if (e.statusCode >= 500) {
      return 'A server error occurred (${e.statusCode}). Tap Retry to try again.';
    }
    if (e.statusCode >= 400) {
      return e.message.length > 200 ? e.message.substring(0, 200) : e.message;
    }
    return e.message;
  }
}

/// ─── CERBERUS — Severity mix ──────────────────────────────────────────────
///
/// The scenario panel exposes **three** risk-distribution sliders, but the API
/// contract (`ThreatScenarioRequest.severityMix` in
/// `apps/api/src/types.ts`) has **four** severity keys: `low`, `medium`, `high`
/// and `critical`.
///
/// This library is the single place that mapping lives. The panel, the request
/// body and the tests all read it from here, so the UI cannot drift away from
/// what is actually sent.
///
/// ## Mapping
///
/// | Slider     | Severity           |
/// | ---------- | ------------------ |
/// | `routine`  | `low`              |
/// | `elevated` | `medium`           |
/// | `severe`   | `high` + `critical` |
///
/// The third slider is deliberately labelled **"Severe"**, not "Critical". Only
/// [severeCriticalShare] of its budget becomes `critical`; the rest becomes
/// `high`. Labelling the whole slider "Critical" would misdescribe what the
/// operator is choosing, which is a budget across the two most severe bands.
/// The split is a documented constant, not a hidden one, and the panel shows it
/// next to the sliders.
///
/// The four weights are normalised to sum to exactly 1.0 before they are sent,
/// mirroring `normalizeSeverityMix()` on the server so the client never sends a
/// mix the server would silently reinterpret.
library;

/// Share of the third slider's budget that becomes `high`.
const double severeHighShare = 0.60;

/// Share of the third slider's budget that becomes `critical`.
///
/// `severeHighShare + severeCriticalShare == 1.0`, so the whole budget is
/// distributed and nothing is dropped.
const double severeCriticalShare = 0.40;

/// Fallback used when every slider is zero, so a request is never sent with no
/// severity distribution at all.
///
/// Deliberately identical to `DEFAULT_SEVERITY_MIX` in
/// `apps/api/src/routes/scenarios.ts`.
const SeverityMix defaultSeverityMix = SeverityMix(
  low: 0.25,
  medium: 0.35,
  high: 0.25,
  critical: 0.15,
);

/// The four severity weights the API accepts, normalised to sum to 1.0.
class SeverityMix {
  final double low;
  final double medium;
  final double high;
  final double critical;

  const SeverityMix({
    required this.low,
    required this.medium,
    required this.high,
    required this.critical,
  });

  /// The exact JSON object the API expects. Keys are the API's severity names,
  /// never the panel's slider names.
  Map<String, dynamic> toJson() => <String, dynamic>{
    'low': low,
    'medium': medium,
    'high': high,
    'critical': critical,
  };

  /// Sum of the four weights. Exactly 1.0 for any mix produced by
  /// [severityMixFromSliders], up to floating-point rounding.
  double get total => low + medium + high + critical;

  @override
  String toString() =>
      'SeverityMix(low: $low, medium: $medium, high: $high, critical: $critical)';

  @override
  bool operator ==(Object other) =>
      other is SeverityMix &&
      other.low == low &&
      other.medium == medium &&
      other.high == high &&
      other.critical == critical;

  @override
  int get hashCode => Object.hash(low, medium, high, critical);
}

/// Builds the API severity mix from the three scenario-panel sliders.
///
/// Each slider is expected in `0.0..1.0`. Non-finite and negative values are
/// treated as zero rather than propagating `NaN` into the request body, which
/// would make the server reject the whole mix and fall back to its default.
///
/// Returns [defaultSeverityMix] when the three sliders carry no weight at all.
SeverityMix severityMixFromSliders({
  required double routine,
  required double elevated,
  required double severe,
}) {
  double usable(double value) => value.isFinite && value > 0 ? value : 0.0;

  final routineWeight = usable(routine);
  final elevatedWeight = usable(elevated);
  final severeBudget = usable(severe);

  final low = routineWeight;
  final medium = elevatedWeight;
  final high = severeBudget * severeHighShare;
  final critical = severeBudget * severeCriticalShare;

  final sum = low + medium + high + critical;
  if (sum <= 0) return defaultSeverityMix;

  return SeverityMix(
    low: low / sum,
    medium: medium / sum,
    high: high / sum,
    critical: critical / sum,
  );
}

import 'package:flutter_test/flutter_test.dart';

import 'package:cerberus_console/models/severity_mix.dart';

/// The scenario panel has three risk-distribution sliders; the API contract has
/// four severity keys. These tests pin the mapping so the UI and the request
/// body cannot drift apart.
void main() {
  group('severityMixFromSliders', () {
    test('maps routine to low and elevated to medium', () {
      final mix = severityMixFromSliders(
        routine: 0.25,
        elevated: 0.25,
        severe: 0.5,
      );

      expect(mix.low, closeTo(0.25, 1e-9));
      expect(mix.medium, closeTo(0.25, 1e-9));
    });

    test('splits the severe budget 60/40 across high and critical', () {
      // An isolated severe budget: nothing else is set, so the split is exactly
      // the documented ratio.
      final mix = severityMixFromSliders(routine: 0, elevated: 0, severe: 1.0);

      expect(mix.high, closeTo(0.60, 1e-9));
      expect(mix.critical, closeTo(0.40, 1e-9));
      expect(mix.low, 0);
      expect(mix.medium, 0);
    });

    test('the high:critical ratio is 3:2 for any severe budget', () {
      for (final budget in <double>[0.1, 0.2, 0.35, 0.7, 1.0]) {
        final mix = severityMixFromSliders(
          routine: 0.2,
          elevated: 0.2,
          severe: budget,
        );
        expect(
          mix.high / mix.critical,
          closeTo(severeHighShare / severeCriticalShare, 1e-9),
          reason: 'ratio drifted for severe budget $budget',
        );
      }
    });

    test('maps the panel defaults to a concrete four-key mix', () {
      // The panel starts at 30% routine / 50% elevated / 20% severe.
      final mix = severityMixFromSliders(
        routine: 0.3,
        elevated: 0.5,
        severe: 0.2,
      );

      expect(mix.low, closeTo(0.30, 1e-9));
      expect(mix.medium, closeTo(0.50, 1e-9));
      expect(mix.high, closeTo(0.12, 1e-9));
      expect(mix.critical, closeTo(0.08, 1e-9));
      expect(mix.total, closeTo(1.0, 1e-9));
    });

    test('always normalises the four weights to sum to one', () {
      final cases = <List<double>>[
        [0.3, 0.5, 0.2],
        [0.1, 0.1, 0.1],
        [1.0, 1.0, 1.0],
        [0.3, 0.3, 0.2],
        [0.0, 0.0, 1.0],
        [0.05, 0.05, 0.05],
      ];

      for (final c in cases) {
        final mix = severityMixFromSliders(
          routine: c[0],
          elevated: c[1],
          severe: c[2],
        );
        expect(
          mix.total,
          closeTo(1.0, 1e-9),
          reason: 'mix did not sum to 1 for $c',
        );
      }
    });

    test('a partial slider sum is normalised, preserving the ratios', () {
      // The sliders can sum to less than 1. The server renormalises, so the
      // client must send the same proportions the operator sees.
      final mix = severityMixFromSliders(
        routine: 0.3,
        elevated: 0.3,
        severe: 0.2,
      );

      // 0.3 : 0.3 : 0.12 : 0.08 over a total of 0.8
      expect(mix.low, closeTo(0.375, 1e-9));
      expect(mix.medium, closeTo(0.375, 1e-9));
      expect(mix.high, closeTo(0.15, 1e-9));
      expect(mix.critical, closeTo(0.10, 1e-9));
      expect(mix.total, closeTo(1.0, 1e-9));
    });

    test('falls back to the server default when every slider is zero', () {
      final mix = severityMixFromSliders(routine: 0, elevated: 0, severe: 0);

      expect(mix, defaultSeverityMix);
      expect(mix.total, closeTo(1.0, 1e-9));
    });

    test('treats negative and non-finite slider values as zero', () {
      // A negative and a NaN slider drop out; the valid severe budget is the
      // only weight left, so it takes the whole mix.
      final mix = severityMixFromSliders(
        routine: -1,
        elevated: double.nan,
        severe: 0.5,
      );

      expect(mix.low, 0);
      expect(mix.medium, 0);
      expect(mix.high, closeTo(0.60, 1e-9));
      expect(mix.critical, closeTo(0.40, 1e-9));
      expect(mix.total, closeTo(1.0, 1e-9));
    });

    test('treats an infinite slider value as zero', () {
      final mix = severityMixFromSliders(
        routine: double.infinity,
        elevated: 0.5,
        severe: 0,
      );

      expect(mix.low, 0);
      expect(mix.medium, 1.0);
      expect(mix.total, closeTo(1.0, 1e-9));
    });

    test('never produces NaN in the request body', () {
      final mix = severityMixFromSliders(
        routine: double.nan,
        elevated: double.nan,
        severe: double.nan,
      );

      expect(mix, defaultSeverityMix);
      for (final value in mix.toJson().values) {
        expect(value, isA<double>());
        expect((value as double).isFinite, isTrue);
      }
    });
  });

  group('SeverityMix', () {
    test('serialises with the API severity keys, not the slider names', () {
      final mix = severityMixFromSliders(
        routine: 0.3,
        elevated: 0.5,
        severe: 0.2,
      );

      final json = mix.toJson();

      expect(json.keys.toSet(), {'low', 'medium', 'high', 'critical'});
      expect(json['low'], closeTo(0.30, 1e-9));
      expect(json['medium'], closeTo(0.50, 1e-9));
      expect(json['high'], closeTo(0.12, 1e-9));
      expect(json['critical'], closeTo(0.08, 1e-9));
      // The panel's own vocabulary must not leak into the wire format.
      expect(json.containsKey('routine'), isFalse);
      expect(json.containsKey('elevated'), isFalse);
      expect(json.containsKey('severe'), isFalse);
    });

    test('compares by value', () {
      const a = SeverityMix(low: 0.1, medium: 0.2, high: 0.3, critical: 0.4);
      const b = SeverityMix(low: 0.1, medium: 0.2, high: 0.3, critical: 0.4);
      const c = SeverityMix(low: 0.1, medium: 0.2, high: 0.3, critical: 0.5);

      expect(a, b);
      expect(a.hashCode, b.hashCode);
      expect(a, isNot(c));
    });
  });

  group('shares', () {
    test('the two severe shares are a partition of the budget', () {
      expect(severeHighShare + severeCriticalShare, closeTo(1.0, 1e-9));
      expect(severeHighShare, greaterThan(severeCriticalShare));
    });

    test('the default mix matches the server default', () {
      // apps/api/src/routes/scenarios.ts DEFAULT_SEVERITY_MIX
      expect(defaultSeverityMix.low, 0.25);
      expect(defaultSeverityMix.medium, 0.35);
      expect(defaultSeverityMix.high, 0.25);
      expect(defaultSeverityMix.critical, 0.15);
      expect(defaultSeverityMix.total, closeTo(1.0, 1e-9));
    });
  });
}

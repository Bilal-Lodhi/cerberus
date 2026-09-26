/// Console surfaces that the release notes make claims about.
///
/// ── Why these exist ───────────────────────────────────────────────────
///
/// The browser QA pass for `v0.3.0` rendered the identity gate and the dashboard, and
/// caught a claim that no test could: the footnote said *"Production deployments integrate
/// with Google Cloud Identity Platform."* Cerberus has no identity provider, no sign-in, no
/// roles and no per-user attribution — accounts and RBAC are an explicit owner decision to
/// stay out of scope. The sentence described a capability that does not exist, in text an
/// operator reads.
///
/// A screenshot caught it once. These tests keep it caught.
///
/// The Focus Loss check is here for the other reason: the risk-notification surface only
/// appears when an analysis produces a payload, so the browser pass could not reach it
/// without driving a paid provider. A widget test renders it directly, which is both
/// cheaper and repeatable.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:cerberus_console/models/guardian_model.dart';
import 'package:cerberus_console/providers/identity_provider.dart';
import 'package:cerberus_console/providers/theme_provider.dart';
import 'package:cerberus_console/screens/identity_setup_screen.dart';
import 'package:cerberus_console/services/api_service.dart';
import 'package:cerberus_console/widgets/risk_notification.dart';

/// Phrases the console must never claim.
///
/// Each one asserts a capability this project either does not have or has decided not to
/// build. Kept as data so a future surface can be checked against the same list.
const forbiddenClaims = <String>[
  'Identity Platform',
  'identity provider',
  'sign-in with',
  'single sign-on',
  'OAuth',
  'SSO',
];

void main() {
  ApiService buildApiService() {
    final api = ApiService(
      baseUrl: 'http://localhost:8787',
      apiKey: 'test-key',
    );
    addTearDown(api.dispose);
    return api;
  }

  /// Every string the rendered tree displays.
  List<String> renderedText(WidgetTester tester) {
    return tester
        .widgetList<Text>(find.byType(Text))
        .map((widget) => widget.data ?? '')
        .where((text) => text.isNotEmpty)
        .toList();
  }

  group('the operator identity gate', () {
    testWidgets('makes no identity-provider claim', (
      WidgetTester tester,
    ) async {
      final api = buildApiService();

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider(create: (_) => ThemeProvider()),
            ChangeNotifierProvider(create: (_) => IdentityProvider(api)),
          ],
          child: const MaterialApp(home: IdentitySetupScreen()),
        ),
      );
      await tester.pump();

      final texts = renderedText(tester);
      expect(texts, isNotEmpty, reason: 'the screen rendered no text at all');

      for (final claim in forbiddenClaims) {
        for (final text in texts) {
          expect(
            text.toLowerCase().contains(claim.toLowerCase()),
            isFalse,
            reason: 'the identity gate claims "$claim" in: $text',
          );
        }
      }
    });

    testWidgets('states the truthful posture instead', (
      WidgetTester tester,
    ) async {
      final api = buildApiService();

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider(create: (_) => ThemeProvider()),
            ChangeNotifierProvider(create: (_) => IdentityProvider(api)),
          ],
          child: const MaterialApp(home: IdentitySetupScreen()),
        ),
      );
      await tester.pump();

      final joined = renderedText(tester).join(' ').toLowerCase();

      // The two durable facts an operator needs, and which the footnote must carry:
      // it does not survive a refresh, and nothing downstream attributes an action to a
      // person.
      expect(joined, contains('ephemeral'));
      expect(joined, contains('no per-user attribution'));
      expect(joined, contains('not an account'));
    });
  });

  group('the risk notification', () {
    /// A payload shaped like a real API response, with a focus-loss count.
    RiskAssessmentPayload payloadWithFocusLoss(int focusLosses) {
      return RiskAssessmentPayload.fromJson({
        'riskAssessmentId': '11111111-1111-4111-8111-111111111111',
        'sessionId': 'ses-widget',
        'employeeId': 'op-trader-001',
        'auditId': 'audit-widget',
        'overallRiskScore': 88,
        'dimensionScores': {'dataExfiltration': 88},
        'flags': <dynamic>[],
        'exfiltrationReport': null,
        'behavioralAnomalies': <dynamic>[],
        'generatedAt': '2026-09-26T00:00:00.000Z',
        'behavioralContext': {
          'totalPasteEvents': 3,
          'totalFocusBreaches': focusLosses,
          'totalCopyAttempts': 1,
          'totalDevToolsOpens': 0,
          'totalFocusLosses': focusLosses,
        },
      });
    }

    Future<void> openNotification(
      WidgetTester tester,
      RiskAssessmentPayload payload,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showRiskNotificationDialog(context, payload),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      // The overlay is tabbed (FLAGS | INCIDENT) and `TabBarView` builds only the visible
      // tab, so the behaviour-context grid — where the renamed counter lives — is not in
      // the tree until its tab is selected.
      await tester.tap(find.text('INCIDENT'));
      await tester.pumpAndSettle();
    }

    testWidgets('says "Focus Loss", not "Fullscreen Exit"', (
      WidgetTester tester,
    ) async {
      // The counter is incremented by WINDOW_BLUR as well as FULLSCREEN_EXIT, so a label
      // saying "Fullscreen Exit" describes one of the two events that produced it. The
      // browser pass could not reach this surface without driving a paid provider; this
      // renders it directly.
      await openNotification(tester, payloadWithFocusLoss(2));

      expect(
        find.text('Focus Loss'),
        findsWidgets,
        reason: 'the counter is not labelled for what it measures',
      );
      expect(
        find.text('Fullscreen Exit'),
        findsNothing,
        reason: 'the deprecated wording is still shown to an operator',
      );
    });

    testWidgets('shows the focus-loss value it was given', (
      WidgetTester tester,
    ) async {
      await openNotification(tester, payloadWithFocusLoss(4));
      expect(find.text('4'), findsWidgets);
    });

    testWidgets('renders no overflow at a narrow width', (
      WidgetTester tester,
    ) async {
      // The behaviour-context grid is where the renamed counter lives, and a rename is
      // exactly the kind of change that can push a row past its box.
      tester.view.physicalSize = const Size(900, 1400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await openNotification(tester, payloadWithFocusLoss(1));
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
    });
  });
}

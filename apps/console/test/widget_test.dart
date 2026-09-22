import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:cerberus_console/app.dart';
import 'package:cerberus_console/screens/dashboard_screen.dart';
import 'package:cerberus_console/services/api_service.dart';
import 'package:cerberus_console/providers/theme_provider.dart';
import 'package:cerberus_console/providers/health_provider.dart';
import 'package:cerberus_console/providers/scenario_provider.dart';
import 'package:cerberus_console/providers/guardian_provider.dart';
import 'package:cerberus_console/providers/review_provider.dart';
import 'package:cerberus_console/providers/identity_provider.dart';

/// Console smoke tests.
///
/// These run on the Dart VM, which also proves the widget tree no longer
/// depends on web-only libraries such as `dart:html` — that dependency used to
/// make the whole suite uncompilable for the VM target.
///
/// All HTTP is intercepted by the Flutter test binding and fails harmlessly,
/// so no server is required.
void main() {
  ApiService buildApiService() {
    final api = ApiService(
      baseUrl: 'http://localhost:8787',
      apiKey: 'test-key',
    );
    addTearDown(api.dispose);
    return api;
  }

  Widget wrap(ApiService api, Widget child) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => ThemeProvider()),
        ChangeNotifierProvider(create: (_) => HealthProvider(api)),
        ChangeNotifierProvider(create: (_) => ScenarioProvider(api)),
        ChangeNotifierProvider(create: (_) => GuardianProvider(api)),
        ChangeNotifierProvider(create: (_) => ReviewProvider(api)),
        ChangeNotifierProvider(create: (_) => IdentityProvider(api)),
      ],
      child: child,
    );
  }

  testWidgets('a fresh launch shows the operator identity gate', (
    WidgetTester tester,
  ) async {
    final api = buildApiService();

    await tester.pumpWidget(wrap(api, const CerberusApp()));
    await tester.pump();

    // With no identity established the root widget routes to the setup screen.
    expect(find.text('CERBERUS'), findsWidgets);
    expect(find.text('Operator Identity'), findsWidgets);
  });

  testWidgets('the dashboard shell builds inside the provider tree', (
    WidgetTester tester,
  ) async {
    final api = buildApiService();

    await tester.pumpWidget(
      wrap(api, const MaterialApp(home: DashboardScreen())),
    );
    await tester.pump();

    // The dashboard chrome renders. We assert on the shell's own labels rather
    // than on telemetry, because no backend is reachable from a test.
    expect(find.byType(AppBar), findsOneWidget);
    expect(find.text('CERBERUS'), findsWidgets);
    expect(find.text('Terminal'), findsWidgets);
    expect(find.text('Telemetry'), findsWidgets);
  });
}

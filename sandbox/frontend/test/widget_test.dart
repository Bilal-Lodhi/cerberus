import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:frontend/app.dart';
import 'package:frontend/services/api_service.dart';
import 'package:frontend/providers/theme_provider.dart';
import 'package:frontend/providers/health_provider.dart';
import 'package:frontend/providers/generate_provider.dart';
import 'package:frontend/providers/guardian_provider.dart';
import 'package:frontend/providers/review_provider.dart';

void main() {
  testWidgets('CerberusApp renders DashboardScreen', (
    WidgetTester tester,
  ) async {
    final apiService = ApiService(baseUrl: 'http://localhost:8787');

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider(create: (_) => ThemeProvider()),
          ChangeNotifierProvider(create: (_) => HealthProvider(apiService)),
          ChangeNotifierProvider(create: (_) => GenerateProvider(apiService)),
          ChangeNotifierProvider(create: (_) => GuardianProvider(apiService)),
          ChangeNotifierProvider(create: (_) => ReviewProvider(apiService)),
        ],
        child: const CerberusApp(),
      ),
    );

    // Verify the app renders with the expected title
    expect(find.text('Cerberus AI — Review Log'), findsOneWidget);
    expect(find.byIcon(Icons.security), findsWidgets);
  });
}

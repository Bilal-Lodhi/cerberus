import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'app.dart';
import 'services/api_service.dart';
import 'providers/theme_provider.dart';
import 'providers/health_provider.dart';
import 'providers/generate_provider.dart';
import 'providers/guardian_provider.dart';
import 'providers/review_provider.dart';
import 'providers/identity_provider.dart';

/// ─── Cerberus AI — Entry Point ──────────────────────────────────────────────
/// Initializes the Provider tree with ApiService and all feature providers,
/// then hands control to the CerberusApp root widget.

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  await Firebase.initializeApp(
    options: FirebaseOptions(
      apiKey: const String.fromEnvironment('FIREBASE_API_KEY'),
      appId: const String.fromEnvironment('FIREBASE_APP_ID'),
      messagingSenderId: const String.fromEnvironment(
        'FIREBASE_MESSAGING_SENDER_ID',
      ),
      projectId: const String.fromEnvironment('FIREBASE_PROJECT_ID'),
    ),
  );

  const apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://cerberus-api-35663052294.us-central1.run.app',
  );

  final apiService = ApiService(baseUrl: apiBaseUrl);

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => ThemeProvider()),
        ChangeNotifierProvider(create: (_) => HealthProvider(apiService)),
        ChangeNotifierProvider(create: (_) => GenerateProvider(apiService)),
        ChangeNotifierProvider(create: (_) => GuardianProvider(apiService)),
        ChangeNotifierProvider(create: (_) => ReviewProvider(apiService)),
        ChangeNotifierProvider(create: (_) => IdentityProvider(apiService)),
      ],
      child: const CerberusApp(),
    ),
  );
}

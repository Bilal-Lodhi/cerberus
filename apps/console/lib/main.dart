import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'app.dart';
import 'services/api_service.dart';
import 'providers/theme_provider.dart';
import 'providers/health_provider.dart';
import 'providers/scenario_provider.dart';
import 'providers/guardian_provider.dart';
import 'providers/review_provider.dart';
import 'providers/identity_provider.dart';
import 'providers/reference_corpus_provider.dart';

/// Cerberus console entry point.
///
/// Configuration is supplied at build time with `--dart-define`:
///
/// ```
/// flutter run -d chrome \
///   --dart-define=API_BASE_URL=http://localhost:8080 \
///   --dart-define=CERBERUS_API_KEY=<operator-key>
/// ```
///
/// Both have safe local defaults. There is no baked-in deployment address and
/// no default credential.
void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  const apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://localhost:8080',
  );

  // Empty by default: the API only accepts unauthenticated calls when it is
  // running with CERBERUS_DEV_MODE=true.
  const apiKey = String.fromEnvironment('CERBERUS_API_KEY', defaultValue: '');

  final apiService = ApiService(baseUrl: apiBaseUrl, apiKey: apiKey);

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => ThemeProvider()),
        ChangeNotifierProvider(create: (_) => HealthProvider(apiService)),
        ChangeNotifierProvider(create: (_) => ScenarioProvider(apiService)),
        ChangeNotifierProvider(create: (_) => GuardianProvider(apiService)),
        ChangeNotifierProvider(create: (_) => ReviewProvider(apiService)),
        ChangeNotifierProvider(create: (_) => IdentityProvider(apiService)),
        ChangeNotifierProvider(
          create: (_) => ReferenceCorpusProvider(apiService),
        ),
      ],
      child: const CerberusApp(),
    ),
  );
}

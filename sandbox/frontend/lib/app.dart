import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'providers/theme_provider.dart';
import 'providers/identity_provider.dart';
import 'screens/dashboard_screen.dart';
import 'screens/identity_setup_screen.dart';

/// ─── Cerberus AI — Root Application Widget ──────────────────────────────────
/// Configures the MaterialApp with dynamic theme support and routes to the
/// split-panel Analytical Review Log dashboard. Shows identity setup screen
/// when no session is active.

class CerberusApp extends StatelessWidget {
  const CerberusApp({super.key});

  @override
  Widget build(BuildContext context) {
    final themeProvider = context.watch<ThemeProvider>();
    final identity = context.watch<IdentityProvider>();

    return MaterialApp(
      title: 'Cerberus AI — Agentic Assessment Platform',
      debugShowCheckedModeBanner: false,
      theme: themeProvider.lightTheme,
      darkTheme: themeProvider.darkTheme,
      themeMode: themeProvider.themeMode,
      home: identity.isIdentified
          ? const DashboardScreen()
          : const IdentitySetupScreen(),
    );
  }
}

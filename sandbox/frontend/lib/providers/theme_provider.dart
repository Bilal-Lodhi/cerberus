import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// ─── Cerberus AI — Theme Provider ───────────────────────────────────────────
/// Manages light/dark/system theme toggling across the review panel.
/// Defaults to dark mode so the icon and toggle behaviour are consistent
/// from the very first render.

class ThemeProvider extends ChangeNotifier {
  ThemeMode _themeMode = ThemeMode.dark;

  ThemeMode get themeMode => _themeMode;

  ThemeData get lightTheme => AppTheme.light;
  ThemeData get darkTheme => AppTheme.dark;

  bool get isDarkMode => _themeMode == ThemeMode.dark;

  void setThemeMode(ThemeMode mode) {
    _themeMode = mode;
    notifyListeners();
  }

  void toggleDarkMode() {
    _themeMode = _themeMode == ThemeMode.dark
        ? ThemeMode.light
        : ThemeMode.dark;
    notifyListeners();
  }
}

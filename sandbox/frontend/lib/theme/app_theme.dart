import 'package:flutter/material.dart';

/// ─── Cerberus AI — Light & Dark Theme Definitions ───────────────────────────
/// Professional, high-utility developer-centric palette with deep charcoal
/// backgrounds for dark mode and crisp paper tones for light mode.

class AppTheme {
  AppTheme._();

  // ── Semantic brand colors ──────────────────────────────────────────────────
  static const Color _cerberusTeal = Color(0xFF00BFA5);
  static const Color _cerberusAmber = Color(0xFFFFAB00);
  static const Color _cerberusRed = Color(0xFFEF5350);
  static const Color _cerberusGreen = Color(0xFF66BB6A);

  // ── Light Theme ────────────────────────────────────────────────────────────
  static ThemeData get light => ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    colorSchemeSeed: _cerberusTeal,
    scaffoldBackgroundColor: const Color(0xFFF5F7FA),
    appBarTheme: const AppBarTheme(
      elevation: 0,
      scrolledUnderElevation: 1,
      centerTitle: false,
      backgroundColor: Colors.white,
      foregroundColor: Color(0xFF1A1A2E),
      titleTextStyle: TextStyle(
        fontSize: 18,
        fontWeight: FontWeight.w700,
        color: Color(0xFF1A1A2E),
        letterSpacing: -0.3,
      ),
    ),
    cardTheme: CardThemeData(
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: Color(0xFFE8ECF1), width: 1),
      ),
      color: Colors.white,
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
    ),
    navigationRailTheme: const NavigationRailThemeData(
      backgroundColor: Colors.white,
      indicatorColor: Color(0xFFE0F7FA),
      selectedIconTheme: IconThemeData(color: _cerberusTeal, size: 22),
      unselectedIconTheme: IconThemeData(color: Color(0xFF90A4AE), size: 22),
      selectedLabelTextStyle: TextStyle(
        color: _cerberusTeal,
        fontSize: 11,
        fontWeight: FontWeight.w600,
      ),
      unselectedLabelTextStyle: TextStyle(
        color: Color(0xFF90A4AE),
        fontSize: 11,
      ),
    ),
    extensions: const <ThemeExtension<dynamic>>[
      _StatusColors(
        critical: _cerberusRed,
        warning: _cerberusAmber,
        nominal: _cerberusGreen,
        info: _cerberusTeal,
      ),
    ],
  );

  // ── Dark Theme ─────────────────────────────────────────────────────────────
  static ThemeData get dark => ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    colorSchemeSeed: _cerberusTeal,
    scaffoldBackgroundColor: const Color(0xFF0D1117),
    appBarTheme: const AppBarTheme(
      elevation: 0,
      scrolledUnderElevation: 1,
      centerTitle: false,
      backgroundColor: Color(0xFF161B22),
      foregroundColor: Color(0xFFE6EDF3),
      titleTextStyle: TextStyle(
        fontSize: 18,
        fontWeight: FontWeight.w700,
        color: Color(0xFFE6EDF3),
        letterSpacing: -0.3,
      ),
    ),
    cardTheme: CardThemeData(
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: Color(0xFF21262D), width: 1),
      ),
      color: const Color(0xFF161B22),
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
    ),
    navigationRailTheme: const NavigationRailThemeData(
      backgroundColor: Color(0xFF161B22),
      indicatorColor: Color(0xFF1B3A3A),
      selectedIconTheme: IconThemeData(color: _cerberusTeal, size: 22),
      unselectedIconTheme: IconThemeData(color: Color(0xFF484F58), size: 22),
      selectedLabelTextStyle: TextStyle(
        color: _cerberusTeal,
        fontSize: 11,
        fontWeight: FontWeight.w600,
      ),
      unselectedLabelTextStyle: TextStyle(
        color: Color(0xFF484F58),
        fontSize: 11,
      ),
    ),
    extensions: const <ThemeExtension<dynamic>>[
      _StatusColors(
        critical: _cerberusRed,
        warning: _cerberusAmber,
        nominal: _cerberusGreen,
        info: _cerberusTeal,
      ),
    ],
  );
}

/// Custom theme extension for semantic status colors used across all panels.
class _StatusColors extends ThemeExtension<_StatusColors> {
  final Color critical;
  final Color warning;
  final Color nominal;
  final Color info;

  const _StatusColors({
    required this.critical,
    required this.warning,
    required this.nominal,
    required this.info,
  });

  @override
  _StatusColors copyWith({
    Color? critical,
    Color? warning,
    Color? nominal,
    Color? info,
  }) {
    return _StatusColors(
      critical: critical ?? this.critical,
      warning: warning ?? this.warning,
      nominal: nominal ?? this.nominal,
      info: info ?? this.info,
    );
  }

  @override
  _StatusColors lerp(covariant ThemeExtension<_StatusColors>? other, double t) {
    if (other is! _StatusColors) return this;
    return _StatusColors(
      critical: Color.lerp(critical, other.critical, t)!,
      warning: Color.lerp(warning, other.warning, t)!,
      nominal: Color.lerp(nominal, other.nominal, t)!,
      info: Color.lerp(info, other.info, t)!,
    );
  }
}

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/guardian_model.dart';

/// ─── Cerberus FinSec — Risk Notification Dialog ──────────────────────────
/// A clean, expandable notification UI that appears when the Guardian detects
/// a data-exfiltration risk. Shows a compact banner with 1-2 line summary
/// that the reviewer can tap to expand into a full incident detail dialog.
///
/// The full expanded view includes:
///   • Incident summary & timestamp
///   • Anomaly risk score gauge
///   • Flagged behavioral indicators with evidence snippets
///   • Behavioral context tallies (pastes, tabs, copies, devtools)
///   • Full paste content snippets (collapsed by default for large pastes)
///   • Complete terminal code snapshot at detection time
///
/// All incident data is persisted to MongoDB on the server side, so the
/// same expanded view is available even after browser/session restart.
///
/// ── Usage ──
/// Call `RiskNotificationBanner.show(context, payload)` from wherever
/// you detect a new risk. The banner slides in from the top and auto-dismisses
/// after 12s. The user can tap it to open the full dialog at any point.
///
/// Or use `RiskNotificationDialog.show(context, payload)` directly to
/// skip the banner and open the full detail view immediately.

// ═══════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════

/// Shows the full risk incident detail dialog directly (e.g., from a
/// "review" button or when opening a stored incident from history).
void showRiskNotificationDialog(
  BuildContext context,
  RiskAssessmentPayload payload,
) {
  Navigator.of(context).push(
    PageRouteBuilder(
      opaque: false,
      barrierDismissible: true,
      barrierColor: Colors.black54,
      transitionDuration: const Duration(milliseconds: 280),
      reverseTransitionDuration: const Duration(milliseconds: 200),
      pageBuilder: (_, __, ___) => _RiskNotificationOverlay(payload: payload),
      transitionsBuilder: (_, animation, __, child) {
        return FadeTransition(
          opacity: animation,
          child: ScaleTransition(
            scale: Tween<double>(begin: 0.92, end: 1.0).animate(
              CurvedAnimation(parent: animation, curve: Curves.easeOutBack),
            ),
            child: child,
          ),
        );
      },
    ),
  );
}

/// ─── Inline Banner (Embeddable Widget) ──────────────────────────────
/// Use this inside a Column or Stack wherever you want a non-intrusive
/// compact risk alert banner to appear.
class RiskNotificationBanner extends StatelessWidget {
  final RiskAssessmentPayload payload;
  final VoidCallback? onDismiss;

  const RiskNotificationBanner({
    super.key,
    required this.payload,
    this.onDismiss,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final score = payload.overallRiskScore;
    final color = _riskColor(score);

    return GestureDetector(
      onTap: () => showRiskNotificationDialog(context, payload),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 350),
        curve: Curves.easeOutCubic,
        margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          gradient: LinearGradient(
            colors: [
              color.withValues(alpha: 0.15),
              color.withValues(alpha: 0.06),
            ],
            begin: Alignment.centerLeft,
            end: Alignment.centerRight,
          ),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: color.withValues(alpha: 0.4), width: 1.2),
          boxShadow: [
            BoxShadow(
              color: color.withValues(alpha: 0.15),
              blurRadius: 16,
              offset: const Offset(0, 4),
            ),
          ],
        ),
        child: Row(
          children: [
            // Risk icon
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: color.withValues(alpha: 0.15),
              ),
              child: Center(
                child: Icon(
                  score >= 75 ? Icons.gpp_bad : Icons.warning_amber_rounded,
                  size: 20,
                  color: color,
                ),
              ),
            ),
            const SizedBox(width: 12),
            // Summary text
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      Text(
                        'THREAT DETECTED',
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: color,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 0.8,
                        ),
                      ),
                      const SizedBox(width: 8),
                      _ScoreBadge(score: score),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    payload.incidentSummary.isNotEmpty
                        ? payload.incidentSummary
                        : 'Anomalous behavior detected — Risk score ${score.toStringAsFixed(0)}%',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurface,
                      height: 1.3,
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${payload.employeeDisplayName} · ${payload.incidentTimeLabel}',
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.outline,
                      fontSize: 10,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            // DETAILS button — permanent, non-dismissible
            SizedBox(
              height: 36,
              child: ElevatedButton.icon(
                onPressed: () => showRiskNotificationDialog(context, payload),
                icon: const Icon(Icons.visibility, size: 18),
                label: const Text(
                  'DETAILS',
                  style: TextStyle(fontWeight: FontWeight.w700, fontSize: 12),
                ),
                style: ElevatedButton.styleFrom(
                  backgroundColor: color,
                  foregroundColor: Colors.white,
                  elevation: 2,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 0,
                  ),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(8),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Full Expandable Dialog (Overlay)
// ═══════════════════════════════════════════════════════════════════════

class _RiskNotificationOverlay extends StatefulWidget {
  final RiskAssessmentPayload payload;

  const _RiskNotificationOverlay({required this.payload});

  @override
  State<_RiskNotificationOverlay> createState() =>
      _RiskNotificationOverlayState();
}

class _RiskNotificationOverlayState extends State<_RiskNotificationOverlay>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  bool _showAllPastes = false;
  bool _showCode = false;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final payload = widget.payload;
    final score = payload.overallRiskScore;
    final color = _riskColor(score);
    final size = MediaQuery.of(context).size;

    return SafeArea(
      child: Center(
        child: SingleChildScrollView(
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: 640,
              maxHeight: size.height * 0.88,
            ),
            child: Material(
              color: Colors.transparent,
              child: Container(
                margin: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  color: theme.colorScheme.surface,
                  borderRadius: BorderRadius.circular(20),
                  boxShadow: [
                    BoxShadow(
                      color: color.withValues(alpha: 0.25),
                      blurRadius: 40,
                      offset: const Offset(0, 12),
                    ),
                    BoxShadow(
                      color: Colors.black.withValues(alpha: 0.15),
                      blurRadius: 80,
                      offset: const Offset(0, 24),
                    ),
                  ],
                ),
                clipBehavior: Clip.antiAlias,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    // ── Header ──
                    _buildHeader(theme, payload, color),

                    // ── Tab bar: Flags | Incident Details ──
                    Container(
                      color: theme.colorScheme.surfaceContainerLow,
                      child: TabBar(
                        controller: _tabController,
                        indicatorColor: color,
                        labelColor: color,
                        unselectedLabelColor: theme.colorScheme.outline,
                        labelStyle: theme.textTheme.labelMedium?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                        tabs: const [
                          Tab(text: 'FLAGS'),
                          Tab(text: 'INCIDENT'),
                        ],
                      ),
                    ),

                    // ── Tab content ──
                    Flexible(
                      child: ConstrainedBox(
                        constraints: BoxConstraints(
                          maxHeight: size.height * 0.5,
                        ),
                        child: TabBarView(
                          controller: _tabController,
                          children: [
                            _buildFlagsTab(theme, payload, color),
                            _buildIncidentTab(theme, payload, color),
                          ],
                        ),
                      ),
                    ),

                    // ── Footer actions ──
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 12,
                      ),
                      decoration: BoxDecoration(
                        color: theme.colorScheme.surfaceContainerLow,
                        border: Border(
                          top: BorderSide(
                            color: theme.colorScheme.outlineVariant,
                          ),
                        ),
                      ),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          TextButton.icon(
                            onPressed: () => Navigator.of(context).pop(),
                            icon: const Icon(Icons.close, size: 18),
                            label: const Text('Dismiss'),
                          ),
                          const SizedBox(width: 8),
                          FilledButton.icon(
                            onPressed: () => _copyIncident(context, payload),
                            icon: const Icon(Icons.copy, size: 18),
                            label: const Text('Copy Report'),
                            style: FilledButton.styleFrom(
                              backgroundColor: color,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  // ── Header ──────────────────────────────────────────────────────────

  Widget _buildHeader(
    ThemeData theme,
    RiskAssessmentPayload payload,
    Color color,
  ) {
    final score = payload.overallRiskScore;
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 20, 16, 16),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [color.withValues(alpha: 0.12), color.withValues(alpha: 0.0)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Top row: icon + score + close
          Row(
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: color.withValues(alpha: 0.15),
                ),
                child: Center(
                  child: Icon(
                    score >= 75 ? Icons.gpp_bad : Icons.warning_amber_rounded,
                    size: 24,
                    color: color,
                  ),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Threat Detected',
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w800,
                        color: color,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      payload.incidentTimeLabel,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.outline,
                      ),
                    ),
                  ],
                ),
              ),
              _AnomalyGauge(score: score, color: color, size: 56),
            ],
          ),
          const SizedBox(height: 12),
          // Incident summary
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.06),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: color.withValues(alpha: 0.2)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'INCIDENT SUMMARY',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.outline,
                    letterSpacing: 0.6,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  payload.incidentSummary.isNotEmpty
                      ? payload.incidentSummary
                      : 'Risk score of ${score.toStringAsFixed(0)}% with ${payload.flags.length} behavioral flags.',
                  style: theme.textTheme.bodyMedium?.copyWith(height: 1.4),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          // Quick metrics row
          Row(
            children: [
              _QuickMetric(
                icon: Icons.content_paste,
                label: 'Pastes',
                value: payload.pasteLineCount > 0
                    ? '${payload.pasteSnippets.length} (${payload.pasteLineCount} lines)'
                    : '${payload.pasteSnippets.length}',
                color: color,
              ),
              const SizedBox(width: 16),
              _QuickMetric(
                icon: Icons.flag,
                label: 'Flags',
                value: '${payload.flags.length}',
                color: color,
              ),
              const SizedBox(width: 16),
              _QuickMetric(
                icon: Icons.person,
                label: 'Operator',
                value: payload.employeeDisplayName,
                color: color,
              ),
            ],
          ),
          const SizedBox(height: 4),
          // Gemini reasoning badge
          if (payload.auditReasoning.isNotEmpty)
            Container(
              margin: const EdgeInsets.only(top: 2),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: theme.colorScheme.tertiaryContainer,
                borderRadius: BorderRadius.circular(6),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.psychology,
                    size: 14,
                    color: theme.colorScheme.onTertiaryContainer,
                  ),
                  const SizedBox(width: 4),
                  Flexible(
                    child: Text(
                      payload.auditReasoning,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.onTertiaryContainer,
                        fontSize: 10,
                      ),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  // ── Flags Tab ───────────────────────────────────────────────────────

  Widget _buildFlagsTab(
    ThemeData theme,
    RiskAssessmentPayload payload,
    Color color,
  ) {
    if (payload.flags.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.check_circle_outline, size: 40, color: Colors.green),
            const SizedBox(height: 8),
            Text(
              'No individual flags raised',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.outline,
              ),
            ),
          ],
        ),
      );
    }

    // Sort flags newest-first by timestamp (ISO-8601 string comparison).
    final sortedFlags = List<AnomalyFlag>.from(payload.flags)
      ..sort((a, b) => b.timestamp.compareTo(a.timestamp));

    return ListView.separated(
      padding: const EdgeInsets.all(12),
      itemCount: sortedFlags.length,
      separatorBuilder: (_, __) => const SizedBox(height: 8),
      itemBuilder: (context, index) {
        final flag = sortedFlags[index];
        return _FlagCard(flag: flag);
      },
    );
  }

  // ── Incident Tab (full context) ─────────────────────────────────────

  Widget _buildIncidentTab(
    ThemeData theme,
    RiskAssessmentPayload payload,
    Color color,
  ) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // ── Behavioral Context ──
          _SectionTitle(title: 'BEHAVIORAL CONTEXT'),
          const SizedBox(height: 8),
          if (payload.behavioralContext != null) ...[
            _BehaviorContextGrid(payload: payload, color: color),
            const SizedBox(height: 16),
          ],

          // ── Keystroke Metrics ──
          if (payload.keystrokeMetrics != null) ...[
            _SectionTitle(title: 'KEYSTROKE RHYTHM'),
            const SizedBox(height: 8),
            _buildKeystrokeRow(theme, payload),
            const SizedBox(height: 16),
          ],

          // ── Paste Content ──
          if (payload.pasteSnippets.isNotEmpty) ...[
            _SectionTitle(
              title:
                  'PASTE CONTENT (${payload.pasteSnippets.length} · ${payload.pasteLineCount} lines · ${payload.pasteCharCount} chars)',
            ),
            const SizedBox(height: 8),
            _buildPasteContent(theme, payload, color),
            const SizedBox(height: 16),
          ],

          // ── Code Snapshot ──
          if (payload.codeSnapshot.isNotEmpty) ...[
            _SectionTitle(
              title:
                  'CODE SNAPSHOT (${payload.codeSnapshot.split('\n').length} lines · ${payload.codeSnapshot.length} chars)',
            ),
            const SizedBox(height: 8),
            _buildCodeSnapshot(theme, payload, color),
            const SizedBox(height: 16),
          ],

          // ── Dimension Scores ──
          _SectionTitle(title: 'DIMENSION SCORES'),
          const SizedBox(height: 8),
          _DimensionScoreBars(payload: payload),
        ],
      ),
    );
  }

  Widget _buildKeystrokeRow(ThemeData theme, RiskAssessmentPayload payload) {
    final km = payload.keystrokeMetrics!;
    return Row(
      children: [
        _MiniStat(
          label: 'Avg IKM',
          value: '${km.averageInterKeyMs.toStringAsFixed(0)} ms',
          icon: Icons.speed,
        ),
        const SizedBox(width: 16),
        _MiniStat(
          label: 'Min IKM',
          value: '${km.minInterKeyMs.toStringAsFixed(0)} ms',
          icon: Icons.timer,
        ),
        const SizedBox(width: 16),
        _MiniStat(
          label: 'Burst Keys',
          value: '${km.burstKeystrokes}',
          icon: Icons.flash_on,
        ),
      ],
    );
  }

  Widget _buildPasteContent(
    ThemeData theme,
    RiskAssessmentPayload payload,
    Color color,
  ) {
    final showAll = _showAllPastes;
    final snippets = showAll
        ? payload.pasteSnippets
        : payload.pasteSnippets.take(1).toList();

    return Column(
      children: [
        ...snippets.asMap().entries.map((entry) {
          final snippet = entry.value;
          final lines = snippet.split('\n');
          // Collapse long content
          final displayText = lines.length > 15 && !showAll
              ? '${lines.take(15).join('\n')}\n... (${lines.length - 15} more lines)'
              : snippet;

          return Container(
            width: double.infinity,
            margin: const EdgeInsets.only(bottom: 8),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: theme.colorScheme.surfaceContainerLow,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: theme.colorScheme.outlineVariant),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(
                      Icons.content_paste,
                      size: 14,
                      color: theme.colorScheme.outline,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      'Paste #${entry.key + 1}  — ${lines.length} lines · ${snippet.length} chars',
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.outline,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                SelectableText(
                  displayText,
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontFamily: 'monospace',
                    fontSize: 11,
                    height: 1.5,
                  ),
                ),
              ],
            ),
          );
        }),
        if (payload.pasteSnippets.length > 1)
          TextButton(
            onPressed: () => setState(() => _showAllPastes = !_showAllPastes),
            child: Text(
              _showAllPastes
                  ? 'Show fewer'
                  : 'Show all ${payload.pasteSnippets.length} pastes',
            ),
          ),
      ],
    );
  }

  Widget _buildCodeSnapshot(
    ThemeData theme,
    RiskAssessmentPayload payload,
    Color color,
  ) {
    final lines = payload.codeSnapshot.split('\n');
    final displayText = _showCode
        ? payload.codeSnapshot
        : lines.take(20).join('\n') +
              (lines.length > 20
                  ? '\n\n... (${lines.length - 20} more lines)'
                  : '');

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: theme.brightness == Brightness.dark
            ? Colors.black
            : const Color(0xFF1E1E1E),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SelectableText(
            displayText,
            style: const TextStyle(
              fontFamily: 'monospace',
              fontSize: 11,
              height: 1.5,
              color: Color(0xFFD4D4D4),
            ),
          ),
          if (lines.length > 20)
            TextButton(
              onPressed: () => setState(() => _showCode = !_showCode),
              style: TextButton.styleFrom(
                foregroundColor: const Color(0xFF569CD6),
              ),
              child: Text(_showCode ? 'Collapse' : 'Show full code'),
            ),
        ],
      ),
    );
  }

  void _copyIncident(BuildContext context, RiskAssessmentPayload payload) {
    final buffer = StringBuffer();
    buffer.writeln('═════ CERBERUS FINSEC INCIDENT REPORT ═════');
    buffer.writeln('Time: ${payload.incidentTimeLabel}');
    buffer.writeln('Operator: ${payload.employeeDisplayName}');
    buffer.writeln(
      'Risk Score: ${payload.overallRiskScore.toStringAsFixed(0)}%',
    );
    buffer.writeln('Summary: ${payload.incidentSummary}');
    buffer.writeln('');
    buffer.writeln('── Flags ──');
    for (final f in payload.flags) {
      buffer.writeln(
        '  [${f.category}] ${f.description} (${f.confidence.toStringAsFixed(0)}%)',
      );
      buffer.writeln('    Evidence: ${f.evidenceSnippet}');
    }
    if (payload.pasteSnippets.isNotEmpty) {
      buffer.writeln('');
      buffer.writeln(
        '── Paste Content (${payload.pasteSnippets.length} · ${payload.pasteLineCount} lines) ──',
      );
      for (var i = 0; i < payload.pasteSnippets.length; i++) {
        buffer.writeln('  #${i + 1}: ${payload.pasteSnippets[i].length} chars');
      }
    }
    buffer.writeln('');
    buffer.writeln(
      '── Code Snapshot (${payload.codeSnapshot.length} chars) ──',
    );
    buffer.writeln(payload.codeSnapshot);
    buffer.writeln('');
    buffer.writeln('── Gemini Reasoning ──');
    buffer.writeln(payload.auditReasoning);

    // Copy using clipboard
    Clipboard.setData(ClipboardData(text: buffer.toString())).then((_) {
      if (context.mounted) {
        showDialog(
          context: context,
          builder: (ctx) => AlertDialog(
            icon: const Icon(Icons.check_circle, color: Colors.green, size: 40),
            title: const Text('Copied to Clipboard'),
            content: const Text(
              'The incident report has been copied to your clipboard.',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(ctx).pop(),
                child: const Text('OK'),
              ),
            ],
          ),
        );
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Internal Widgets
// ═══════════════════════════════════════════════════════════════════════

class _AnomalyGauge extends StatelessWidget {
  final double score;
  final Color color;
  final double size;

  const _AnomalyGauge({
    required this.score,
    required this.color,
    required this.size,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: TweenAnimationBuilder<double>(
        tween: Tween(begin: 0.0, end: score / 100.0),
        duration: const Duration(milliseconds: 1000),
        curve: Curves.easeOutCubic,
        builder: (context, value, _) {
          return Stack(
            alignment: Alignment.center,
            children: [
              CircularProgressIndicator(
                value: value,
                strokeWidth: 4.5,
                backgroundColor: color.withValues(alpha: 0.1),
                valueColor: AlwaysStoppedAnimation(color),
              ),
              Text(
                score.toStringAsFixed(0),
                style: TextStyle(
                  fontSize: size * 0.28,
                  fontWeight: FontWeight.w800,
                  color: color,
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _ScoreBadge extends StatelessWidget {
  final double score;

  const _ScoreBadge({required this.score});

  @override
  Widget build(BuildContext context) {
    final color = _riskColor(score);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        '${score.toStringAsFixed(0)}%',
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w700,
          color: color,
        ),
      ),
    );
  }
}

class _QuickMetric extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final Color color;

  const _QuickMetric({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 14, color: theme.colorScheme.outline),
        const SizedBox(width: 4),
        Text(
          '$label: ',
          style: theme.textTheme.labelSmall?.copyWith(
            color: theme.colorScheme.outline,
          ),
        ),
        Text(
          value,
          style: theme.textTheme.labelSmall?.copyWith(
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final String title;

  const _SectionTitle({required this.title});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Text(
      title,
      style: theme.textTheme.labelSmall?.copyWith(
        color: theme.colorScheme.outline,
        letterSpacing: 0.6,
        fontWeight: FontWeight.w700,
      ),
    );
  }
}

class _FlagCard extends StatefulWidget {
  final AnomalyFlag flag;

  const _FlagCard({required this.flag});

  @override
  State<_FlagCard> createState() => _FlagCardState();
}

class _FlagCardState extends State<_FlagCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final flag = widget.flag;
    final catColor = _flagCategoryColor(flag.category);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: theme.colorScheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: catColor.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  flag.category.toUpperCase(),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: catColor,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              const Spacer(),
              Text(
                '${flag.confidence.toStringAsFixed(0)}% confidence',
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.outline,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            flag.description,
            style: theme.textTheme.bodyMedium?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
          // ── Time Flagged ──
          if (flag.timestamp.isNotEmpty) ...[
            const SizedBox(height: 6),
            Row(
              children: [
                Icon(
                  Icons.access_time,
                  size: 13,
                  color: theme.colorScheme.outline,
                ),
                const SizedBox(width: 5),
                Text(
                  _formatTimestamp(flag.timestamp),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.outline,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ],
            ),
          ],
          if (flag.evidenceSnippet.isNotEmpty) ...[
            const SizedBox(height: 6),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: theme.brightness == Brightness.dark
                    ? Colors.black26
                    : const Color(0xFFF5F5F5),
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text(
                flag.evidenceSnippet,
                style: theme.textTheme.bodySmall?.copyWith(
                  fontFamily: 'monospace',
                  fontSize: 11,
                  height: 1.4,
                ),
                maxLines: _expanded ? null : 4,
                overflow: _expanded ? null : TextOverflow.ellipsis,
              ),
            ),
          ],
          const SizedBox(height: 8),
          // ── Expand / Collapse "DETAILS" button ──
          Align(
            alignment: Alignment.centerRight,
            child: SizedBox(
              height: 30,
              child: TextButton.icon(
                onPressed: () => setState(() => _expanded = !_expanded),
                icon: Icon(
                  _expanded ? Icons.expand_less : Icons.expand_more,
                  size: 16,
                  color: catColor,
                ),
                label: Text(
                  _expanded ? 'COLLAPSE' : 'DETAILS',
                  style: TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 11,
                    color: catColor,
                  ),
                ),
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  visualDensity: VisualDensity.compact,
                ),
              ),
            ),
          ),
          // ── Expanded full details ──
          if (_expanded) ...[
            const SizedBox(height: 6),
            Divider(color: theme.colorScheme.outlineVariant),
            const SizedBox(height: 6),
            // Flag ID row
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Flag ID: ',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.outline,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Expanded(
                  child: Text(
                    flag.flagId,
                    style: theme.textTheme.bodySmall?.copyWith(
                      fontFamily: 'monospace',
                      fontSize: 11,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            // Category row
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Category: ',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.outline,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 6,
                    vertical: 1,
                  ),
                  decoration: BoxDecoration(
                    color: catColor.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    flag.category.toUpperCase(),
                    style: TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w700,
                      color: catColor,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            // Confidence row
            Row(
              children: [
                Text(
                  'Confidence: ',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.outline,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  '${flag.confidence.toStringAsFixed(0)}%',
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontWeight: FontWeight.w600,
                    color: catColor,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            // Time Flagged row (expanded)
            if (flag.timestamp.isNotEmpty)
              Row(
                children: [
                  Text(
                    'Time Flagged: ',
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.outline,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  Icon(
                    Icons.access_time,
                    size: 12,
                    color: theme.colorScheme.outline,
                  ),
                  const SizedBox(width: 4),
                  Text(
                    _formatTimestamp(flag.timestamp),
                    style: theme.textTheme.bodySmall?.copyWith(
                      fontWeight: FontWeight.w500,
                      color: catColor,
                    ),
                  ),
                ],
              ),
            const SizedBox(height: 4),
            // Full evidence snippet
            if (flag.evidenceSnippet.isNotEmpty) ...[
              Text(
                'Evidence:',
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.outline,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 4),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: theme.brightness == Brightness.dark
                      ? Colors.black26
                      : const Color(0xFFF5F5F5),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: theme.colorScheme.outlineVariant),
                ),
                child: SelectableText(
                  flag.evidenceSnippet,
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontFamily: 'monospace',
                    fontSize: 11,
                    height: 1.4,
                  ),
                ),
              ),
            ],
          ],
        ],
      ),
    );
  }
}

class _BehaviorContextGrid extends StatelessWidget {
  final RiskAssessmentPayload payload;
  final Color color;

  const _BehaviorContextGrid({required this.payload, required this.color});

  @override
  Widget build(BuildContext context) {
    final bc = payload.behavioralContext!;
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        _BehaviorChip(
          icon: Icons.content_paste,
          label: 'Pastes',
          value: bc.totalPasteEvents,
          color: bc.totalPasteEvents > 1 ? Colors.orange : Colors.green,
        ),
        _BehaviorChip(
          icon: Icons.tab,
          label: 'Focus Breaches',
          value: bc.totalFocusBreaches,
          color: bc.totalFocusBreaches > 2 ? Colors.orange : Colors.green,
        ),
        _BehaviorChip(
          icon: Icons.copy,
          label: 'Copy Attempts',
          value: bc.totalCopyAttempts,
          color: bc.totalCopyAttempts > 1 ? Colors.orange : Colors.green,
        ),
        _BehaviorChip(
          icon: Icons.terminal,
          label: 'Dev Tools',
          value: bc.totalDevToolsOpens,
          color: bc.totalDevToolsOpens > 0 ? Colors.red : Colors.green,
        ),
        _BehaviorChip(
          icon: Icons.fullscreen_exit,
          label: 'Fullscreen Exit',
          value: bc.totalFullscreenExits,
          color: bc.totalFullscreenExits > 0 ? Colors.red : Colors.green,
        ),
      ],
    );
  }
}

class _BehaviorChip extends StatelessWidget {
  final IconData icon;
  final String label;
  final int value;
  final Color color;

  const _BehaviorChip({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.25)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: color),
          const SizedBox(height: 4),
          Text(
            '$value',
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w800,
              color: color,
            ),
          ),
          Text(
            label,
            style: theme.textTheme.labelSmall?.copyWith(
              fontSize: 10,
              color: theme.colorScheme.outline,
            ),
          ),
        ],
      ),
    );
  }
}

class _MiniStat extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;

  const _MiniStat({
    required this.label,
    required this.value,
    required this.icon,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 14, color: theme.colorScheme.outline),
        const SizedBox(width: 4),
        Text(
          '$label: ',
          style: theme.textTheme.labelSmall?.copyWith(
            color: theme.colorScheme.outline,
          ),
        ),
        Text(
          value,
          style: theme.textTheme.labelSmall?.copyWith(
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );
  }
}

class _DimensionScoreBars extends StatelessWidget {
  final RiskAssessmentPayload payload;

  const _DimensionScoreBars({required this.payload});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dims = payload.dimensionScores;
    final entries = [
      _DimEntry('Data Exfiltration', dims.dataExfiltration, Colors.red),
      _DimEntry('Unauthorized Access', dims.unauthorizedAccess, Colors.orange),
      _DimEntry('Policy Violation', dims.policyViolation, Colors.amber),
      _DimEntry('AML Red Flag', dims.amlRedFlag, Colors.deepOrange),
      _DimEntry('Insider Trading', dims.insiderTrading, Colors.purple),
      _DimEntry('SOX Non-Compliance', dims.soxNonCompliance, Colors.blueGrey),
    ];

    return Column(
      children: entries.map((entry) {
        return Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Row(
            children: [
              SizedBox(
                width: 150,
                child: Text(
                  entry.label,
                  style: theme.textTheme.labelSmall,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(4),
                  child: LinearProgressIndicator(
                    value: entry.score / 100.0,
                    minHeight: 8,
                    backgroundColor: entry.color.withValues(alpha: 0.1),
                    valueColor: AlwaysStoppedAnimation(entry.color),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              SizedBox(
                width: 36,
                child: Text(
                  '${entry.score.toStringAsFixed(0)}%',
                  style: theme.textTheme.labelSmall?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                  textAlign: TextAlign.right,
                ),
              ),
            ],
          ),
        );
      }).toList(),
    );
  }
}

class _DimEntry {
  final String label;
  final double score;
  final Color color;

  const _DimEntry(this.label, this.score, this.color);
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

Color _riskColor(double score) {
  if (score >= 75) return Colors.red;
  if (score >= 45) return Colors.orange;
  return Colors.amber;
}

Color _flagCategoryColor(String category) {
  switch (category.toLowerCase()) {
    case 'critical':
    case 'data_exfiltration':
      return Colors.red;
    case 'elevated':
    case 'suspicious':
      return Colors.orange;
    case 'info':
      return Colors.blue;
    default:
      return Colors.grey;
  }
}

/// Formats an ISO-8601 timestamp string into a human-readable label.
/// e.g. "2026-06-07T15:30:00Z" → "Today 3:30 PM" or "Jun 7, 2026 3:30 PM"
String _formatTimestamp(String isoTimestamp) {
  try {
    final dt = DateTime.parse(isoTimestamp).toLocal();
    final now = DateTime.now();
    final isToday =
        dt.year == now.year && dt.month == now.month && dt.day == now.day;

    final hour = dt.hour > 12 ? dt.hour - 12 : (dt.hour == 0 ? 12 : dt.hour);
    final minute = dt.minute.toString().padLeft(2, '0');
    final amPm = dt.hour >= 12 ? 'PM' : 'AM';
    final timeStr = '$hour:$minute $amPm';

    if (isToday) {
      return 'Today $timeStr';
    }

    final months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    return '${months[dt.month - 1]} ${dt.day}, ${dt.year} $timeStr';
  } catch (_) {
    return isoTimestamp;
  }
}

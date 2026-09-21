import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/review_provider.dart';
import '../providers/guardian_provider.dart';
import '../models/guardian_model.dart';
import 'risk_notification.dart';

/// ─── Cerberus FinSec — Middle Panel: Real-Time Threat Metrics & SIEM Feed ────
/// Displays a live Anomaly Risk Index circular gauge (0–100), a scrolling
/// micro-event timeline stream with color-coded severity badges, and
/// dimension-level risk breakdown cards. Reacts in real-time to
/// ingest events dispatched from the employee terminal workspace.

class SecurityMetricsPanel extends StatefulWidget {
  const SecurityMetricsPanel({super.key});

  @override
  State<SecurityMetricsPanel> createState() => _SecurityMetricsPanelState();
}

class _SecurityMetricsPanelState extends State<SecurityMetricsPanel> {
  final ScrollController _scrollController = ScrollController();

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  void _scrollToFirstRiskAssessment() {
    // Scroll to the top of the timeline where live events appear first
    if (_scrollController.hasClients) {
      _scrollController.animateTo(
        0,
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeInOut,
      );
    }
  }

  // ── Derived data ──────────────────────────────────────────────────────────

  /// Merged timeline: GuardianProvider live events + ReviewRecord's static timeline
  List<_TimelineEntry> _buildTimeline(
    GuardianProvider guardian,
    ReviewRecord? record,
  ) {
    final entries = <_TimelineEntry>[];

    // Live guardian risk assessment payloads
    for (final payload in guardian.events.reversed) {
      // Derive a context-aware label from the top flag or risk score
      final topFlag = payload.flags.isNotEmpty
          ? payload.flags.first.description
          : null;
      final contextLabel =
          topFlag ??
          'Risk Score: ${payload.overallRiskScore.toStringAsFixed(1)}';
      final riskLabel =
          '$contextLabel (${payload.overallRiskScore.toStringAsFixed(0)})';

      entries.add(
        _TimelineEntry(
          timestamp: payload.generatedAt,
          eventType: 'RISK_ASSESSMENT',
          label: riskLabel,
          detail: payload.auditReasoning,
          severity: payload.overallRiskScore >= 75
              ? 'critical'
              : payload.overallRiskScore >= 45
              ? 'warning'
              : 'info',
          riskPayload: payload,
        ),
      );
    }

    if (record != null) {
      for (final tl in record.timeline.reversed) {
        final ts = _parseTimelineTimestamp(tl['timestamp']);
        entries.add(
          _TimelineEntry(
            timestamp: ts,
            eventType: tl['eventType'] as String? ?? 'unknown',
            label: tl['label'] as String? ?? '',
            detail: tl['detail'] as String? ?? '',
            severity: tl['severity'] as String? ?? 'info',
          ),
        );
      }
    }

    return entries;
  }

  @override
  Widget build(BuildContext context) {
    final review = context.watch<ReviewProvider>().selected;
    final guardian = context.watch<GuardianProvider>();

    if (review == null) {
      return _buildEmptyState(context);
    }

    return _buildMetricsView(context, review, guardian);
  }

  Widget _buildEmptyState(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.shield_outlined,
            size: 64,
            color: theme.colorScheme.outline,
          ),
          const SizedBox(height: 16),
          Text(
            'Security metrics appear here',
            style: theme.textTheme.titleMedium?.copyWith(
              color: theme.colorScheme.outline,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'Select an active audit session to view the live telemetry',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.outline.withValues(alpha: 0.7),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildMetricsView(
    BuildContext context,
    ReviewRecord record,
    GuardianProvider guardian,
  ) {
    final theme = Theme.of(context);
    final isLocked = record.isLocked;
    final liveScore = guardian.events.isNotEmpty
        ? guardian.events.last.overallRiskScore
        : (record.lastRiskPayload?.overallRiskScore ?? 0.0);
    final severity = _deriveSeverity(liveScore);
    final timeline = _buildTimeline(guardian, record);
    final lastPayload = guardian.events.isNotEmpty
        ? guardian.events.last
        : record.lastRiskPayload;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // ═══ Anomaly Risk Index Gauge (always visible) ═══
        _buildAnomalyGaugeCard(
          theme,
          liveScore,
          severity,
          lastPayload,
          isLocked: isLocked,
        ),
        const Divider(height: 1),

        // ═══ Lock Status Banner ═══
        if (isLocked && lastPayload != null)
          _buildLockStatusBanner(theme, lastPayload, context),

        // ═══ Scrollable Live Micro-Event Stream ═══
        Expanded(
          child: timeline.isEmpty
              ? _buildNoEventsPlaceholder(theme)
              : ListView.builder(
                  controller: _scrollController,
                  padding: const EdgeInsets.all(12),
                  itemCount: timeline.length,
                  itemBuilder: (context, index) {
                    return _buildTimelineTile(theme, timeline[index]);
                  },
                ),
        ),
      ],
    );
  }

  /// Red banner shown at the top of the metrics panel when the session is
  /// locked, summarizing why and providing a quick DETAILS button.
  Widget _buildLockStatusBanner(
    ThemeData theme,
    RiskAssessmentPayload lastPayload,
    BuildContext context,
  ) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            Colors.red.withValues(alpha: 0.08),
            Colors.red.withValues(alpha: 0.02),
          ],
        ),
        border: Border(
          bottom: BorderSide(color: Colors.red.withValues(alpha: 0.18)),
        ),
      ),
      child: Row(
        children: [
          const Icon(Icons.gpp_bad, size: 18, color: Colors.red),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  '⚠️ SESSION LOCKED — ${lastPayload.employeeDisplayName}',
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: Colors.red,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  lastPayload.incidentSummary.isNotEmpty
                      ? lastPayload.incidentSummary
                      : 'Risk score: ${lastPayload.overallRiskScore.toStringAsFixed(0)}% with ${lastPayload.flags.length} anomaly flags.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: Colors.red.withValues(alpha: 0.85),
                    fontSize: 11,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            height: 30,
            child: ElevatedButton.icon(
              onPressed: () => showRiskNotificationDialog(context, lastPayload),
              icon: const Icon(Icons.visibility, size: 14),
              label: const Text(
                'DETAILS',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 10),
              ),
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.red,
                foregroundColor: Colors.white,
                elevation: 1,
                padding: const EdgeInsets.symmetric(horizontal: 10),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(6),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Anomaly Risk Index Circular Gauge Card
  // ═══════════════════════════════════════════════════════════════════════════

  Widget _buildAnomalyGaugeCard(
    ThemeData theme,
    double score,
    String severity,
    RiskAssessmentPayload? lastPayload, {
    bool isLocked = false,
  }) {
    final color = _severityColor(severity, theme);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [color.withValues(alpha: 0.1), color.withValues(alpha: 0.03)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        border: Border(
          bottom: BorderSide(color: color.withValues(alpha: 0.3), width: 1),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          // Row 1: Gauge + Labels + DETAILS button
          Row(
            children: [
              // Circular progress indicator
              SizedBox(
                width: 72,
                height: 72,
                child: TweenAnimationBuilder<double>(
                  tween: Tween(begin: 0.0, end: score / 100.0),
                  duration: const Duration(milliseconds: 900),
                  curve: Curves.easeOutCubic,
                  builder: (context, value, _) {
                    return Stack(
                      alignment: Alignment.center,
                      children: [
                        CircularProgressIndicator(
                          value: value,
                          strokeWidth: 6,
                          backgroundColor:
                              theme.colorScheme.surfaceContainerHighest,
                          valueColor: AlwaysStoppedAnimation(color),
                        ),
                        Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              score.toStringAsFixed(0),
                              style: theme.textTheme.headlineSmall?.copyWith(
                                color: color,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                          ],
                        ),
                      ],
                    );
                  },
                ),
              ),
              const SizedBox(width: 16),
              // Labels + metrics
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              'ANOMALY RISK INDEX',
                              style: theme.textTheme.labelSmall?.copyWith(
                                color: theme.colorScheme.outline,
                                letterSpacing: 0.8,
                              ),
                            ),
                            if (isLocked) ...[
                              const SizedBox(width: 8),
                              Icon(Icons.lock, size: 14, color: Colors.red),
                            ],
                          ],
                        ),
                        _severityBadge(theme, severity),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        _metricChip(
                          theme,
                          Icons.event,
                          '${lastPayload?.flags.length ?? 0} flags',
                          onTap: _scrollToFirstRiskAssessment,
                        ),
                        const SizedBox(width: 12),
                        _metricChip(
                          theme,
                          Icons.timer_outlined,
                          lastPayload != null
                              ? _formatTimestamp(lastPayload.generatedAt)
                              : '—',
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 6),
              // REFRESH button
              IconButton(
                icon: const Icon(Icons.refresh, size: 20),
                tooltip: 'Refresh threat data',
                color: theme.colorScheme.outline,
                visualDensity: VisualDensity.compact,
                onPressed: () {
                  final review = context.read<ReviewProvider>().selected;
                  if (review != null) {
                    context.read<ReviewProvider>().loadAuditRecord(
                      review.sessionId,
                    );
                    // Also restart the guardian stream if active
                    final guardian = context.read<GuardianProvider>();
                    if (guardian.isStreaming) {
                      guardian.stopStreaming();
                      guardian.startStreaming(review.sessionId);
                    }
                  }
                },
              ),
              const SizedBox(width: 4),
              // DETAILS button
              if (lastPayload != null)
                SizedBox(
                  height: 38,
                  child: ElevatedButton.icon(
                    onPressed: () =>
                        showRiskNotificationDialog(context, lastPayload),
                    icon: const Icon(Icons.visibility, size: 16),
                    label: const Text(
                      'DETAILS',
                      style: TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 11,
                      ),
                    ),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: color,
                      foregroundColor: Colors.white,
                      elevation: 1,
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                    ),
                  ),
                ),
            ],
          ),
          // Row 2: Incident summary line (operator + paste info)
          if (lastPayload != null &&
              (lastPayload.incidentSummary.isNotEmpty ||
                  lastPayload.employeeDisplayName.isNotEmpty)) ...[
            const SizedBox(height: 8),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.05),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: color.withValues(alpha: 0.15)),
              ),
              child: Row(
                children: [
                  Icon(Icons.person, size: 14, color: color),
                  const SizedBox(width: 6),
                  Text(
                    lastPayload.employeeDisplayName,
                    style: theme.textTheme.labelSmall?.copyWith(
                      fontWeight: FontWeight.w600,
                      color: color,
                    ),
                  ),
                  if (lastPayload.pasteLineCount > 0) ...[
                    const SizedBox(width: 12),
                    Icon(Icons.content_paste, size: 14, color: color),
                    const SizedBox(width: 4),
                    Text(
                      '${lastPayload.pasteSnippets.length} paste(s) · ${lastPayload.pasteLineCount} lines',
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                  const Spacer(),
                  Text(
                    lastPayload.incidentTimeLabel,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.outline,
                      fontSize: 10,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildNoEventsPlaceholder(ThemeData theme) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.check_circle_outline,
            size: 40,
            color: theme.colorScheme.outline,
          ),
          const SizedBox(height: 8),
          Text(
            'No suspicious events detected',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.outline,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTimelineTile(ThemeData theme, _TimelineEntry entry) {
    final eventColor = _timelineSeverityColor(entry.severity, theme);
    final hasPayload = entry.riskPayload != null;
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      elevation: 0,
      color: theme.colorScheme.surfaceContainerLow,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Event type icon
                Container(
                  padding: const EdgeInsets.all(6),
                  decoration: BoxDecoration(
                    color: eventColor.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Icon(
                    _timelineIcon(entry.eventType),
                    size: 18,
                    color: eventColor,
                  ),
                ),
                const SizedBox(width: 12),
                // Details
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Expanded(
                            child: Text(
                              entry.label,
                              style: theme.textTheme.labelMedium?.copyWith(
                                fontWeight: FontWeight.w600,
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          _severityBadge(theme, entry.severity),
                        ],
                      ),
                      if (entry.detail.isNotEmpty) ...[
                        const SizedBox(height: 4),
                        Text(
                          entry.detail,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                            fontFamily: 'monospace',
                            fontSize: 11,
                          ),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                      const SizedBox(height: 4),
                      Text(
                        _formatTimestamp(entry.timestamp),
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: theme.colorScheme.outline,
                          fontSize: 10,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            // Anomaly flag pills — visible for risk assessment entries
            if (hasPayload && entry.riskPayload!.flags.isNotEmpty) ...[
              const SizedBox(height: 8),
              Wrap(
                spacing: 6,
                runSpacing: 4,
                children: entry.riskPayload!.flags.map((flag) {
                  return Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 3,
                    ),
                    decoration: BoxDecoration(
                      color: _flagColor(flag.category).withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: _flagColor(flag.category).withValues(alpha: 0.3),
                      ),
                    ),
                    child: Text(
                      flag.description,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: _flagColor(flag.category),
                        fontWeight: FontWeight.w600,
                        fontSize: 10,
                      ),
                    ),
                  );
                }).toList(),
              ),
            ],

            // DETAILS button for risk assessment entries
            if (hasPayload) ...[
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: SizedBox(
                  height: 32,
                  child: ElevatedButton.icon(
                    onPressed: () =>
                        showRiskNotificationDialog(context, entry.riskPayload!),
                    icon: const Icon(Icons.visibility, size: 14),
                    label: const Text(
                      'DETAILS',
                      style: TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 10,
                      ),
                    ),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: eventColor,
                      foregroundColor: Colors.white,
                      elevation: 1,
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(6),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  String _deriveSeverity(double score) {
    if (score >= 75) return 'critical';
    if (score >= 45) return 'elevated';
    return 'info';
  }

  Widget _severityBadge(ThemeData theme, String severity) {
    final color = _severityColor(severity, theme);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        severity.toUpperCase(),
        style: theme.textTheme.labelSmall?.copyWith(
          color: color,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.5,
        ),
      ),
    );
  }

  Widget _metricChip(
    ThemeData theme,
    IconData icon,
    String label, {
    VoidCallback? onTap,
  }) {
    final chip = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          icon,
          size: 14,
          color: onTap != null
              ? theme.colorScheme.primary
              : theme.colorScheme.outline,
        ),
        const SizedBox(width: 4),
        Text(
          label,
          style: theme.textTheme.labelSmall?.copyWith(
            color: onTap != null
                ? theme.colorScheme.primary
                : theme.colorScheme.outline,
          ),
        ),
      ],
    );

    if (onTap != null) {
      return InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(6),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
          child: chip,
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
      child: chip,
    );
  }

  /// Maps an anomaly flag category to a visible pill color.
  Color _flagColor(String category) {
    switch (category.toLowerCase()) {
      case 'data_exfiltration':
        return Colors.red;
      case 'unauthorized_access':
        return Colors.deepOrange;
      case 'policy_violation':
        return Colors.amber;
      case 'aml_red_flag':
        return Colors.purple;
      case 'insider_trading':
        return Colors.pink;
      case 'sox_non_compliance':
        return Colors.cyan;
      case 'paste_event':
        return Colors.orange;
      case 'keystroke_anomaly':
        return Colors.teal;
      case 'copy_attempt':
        return Colors.blueGrey;
      case 'tab_switch':
        return Colors.indigo;
      default:
        return Colors.red;
    }
  }

  Color _severityColor(String severity, ThemeData theme) {
    switch (severity) {
      case 'critical':
        return Colors.red;
      case 'elevated':
        return Colors.orange;
      default:
        return theme.colorScheme.primary;
    }
  }

  Color _timelineSeverityColor(String severity, ThemeData theme) {
    switch (severity) {
      case 'critical':
        return Colors.red;
      case 'warning':
        return Colors.orange;
      default:
        return theme.colorScheme.primary;
    }
  }

  IconData _timelineIcon(String eventType) {
    switch (eventType) {
      case 'KEYSTROKE':
        return Icons.keyboard;
      case 'PASTE_TRIGGER':
        return Icons.content_paste;
      case 'CODE_DELTA':
        return Icons.account_tree;
      case 'TAB_SWITCH':
        return Icons.tab_unselected;
      case 'WINDOW_BLUR':
        return Icons.visibility_off;
      case 'COPY_ATTEMPT':
        return Icons.copy;
      case 'DEVELOPER_TOOLS_OPEN':
        return Icons.terminal;
      case 'FULLSCREEN_EXIT':
        return Icons.fullscreen_exit;
      case 'SUBMIT':
        return Icons.send;
      case 'RISK_ASSESSMENT':
        return Icons.analytics_outlined;
      default:
        return Icons.help_outline;
    }
  }

  /// Handles timestamps that may arrive as numeric epoch (ms) or ISO-8601 strings.
  String _parseTimelineTimestamp(dynamic value) {
    if (value == null) return '';
    if (value is String) return value;
    if (value is num) {
      return DateTime.fromMillisecondsSinceEpoch(
        value.toInt(),
      ).toUtc().toIso8601String();
    }
    return value.toString();
  }

  String _formatTimestamp(String timestamp) {
    if (timestamp.isEmpty) return '—';
    try {
      final dt = DateTime.parse(timestamp).toLocal();
      final hour = dt.hour.toString().padLeft(2, '0');
      final minute = dt.minute.toString().padLeft(2, '0');
      final second = dt.second.toString().padLeft(2, '0');
      return '$hour:$minute:$second';
    } catch (_) {
      return timestamp;
    }
  }
}

/// Lightweight internal model for the merged timeline list.
class _TimelineEntry {
  final String timestamp;
  final String eventType;
  final String label;
  final String detail;
  final String severity;

  /// Carried payload for RISK_ASSESSMENT entries so we can open the full dialog.
  final RiskAssessmentPayload? riskPayload;

  const _TimelineEntry({
    required this.timestamp,
    required this.eventType,
    required this.label,
    required this.detail,
    required this.severity,
    this.riskPayload,
  });
}

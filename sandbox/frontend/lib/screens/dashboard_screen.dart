import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../providers/health_provider.dart';
import '../providers/identity_provider.dart';
import '../providers/review_provider.dart';
import '../providers/guardian_provider.dart';
import '../models/guardian_model.dart';
import '../widgets/generate_panel.dart';
import '../widgets/security_metrics_panel.dart';
import '../widgets/code_workspace_panel.dart';

/// ─── Cerberus FinSec — Dashboard Screen ───────────────────────────────────────
/// Root shell after identity setup. Provides:
///   - AppBar with operator identity badge
///   - Compliance Matrix button that opens a bottom sheet (via [ComplianceSheet])
///   - Left navigation drawer (active audit sessions)
///   - Wide layout: Code Workspace | Security Metrics
///   - Narrow layout: Tab-based switching between Terminal & Telemetry

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  bool _showOnboarding = true;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);

    // Load initial data
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final review = context.read<ReviewProvider>();
      review.loadSessions();
      final health = context.read<HealthProvider>();
      health.checkHealth();
    });
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      // ── App Bar ──────────────────────────────────────────────────────────
      appBar: AppBar(
        title: Text(
          'Cerberus FinSec',
          style: TextStyle(
            fontWeight: FontWeight.bold,
            color: theme.colorScheme.primary,
          ),
        ),
        actions: [
          // ── Get Started? Dropdown ──
          if (_showOnboarding)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: PopupMenuButton<String>(
                offset: const Offset(0, 48),
                color: theme.colorScheme.surface,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(16),
                ),
                onSelected: (value) {
                  if (value == 'start') {
                    ComplianceSheet.show(context);
                  }
                },
                itemBuilder: (ctx) => [
                  PopupMenuItem<String>(
                    enabled: false,
                    padding: EdgeInsets.zero,
                    child: _buildOnboardingPopupContent(theme),
                  ),
                  const PopupMenuDivider(height: 1),
                  PopupMenuItem<String>(
                    value: 'start',
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(
                          Icons.gavel,
                          size: 18,
                          color: theme.colorScheme.primary,
                        ),
                        const SizedBox(width: 8),
                        Text(
                          'Start Your First Audit',
                          style: TextStyle(
                            fontWeight: FontWeight.w600,
                            color: theme.colorScheme.primary,
                          ),
                        ),
                      ],
                    ),
                  ),
                  PopupMenuItem<String>(
                    value: 'dismiss',
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(
                          Icons.close,
                          size: 18,
                          color: theme.colorScheme.outline,
                        ),
                        const SizedBox(width: 8),
                        Text(
                          'Dismiss Guide',
                          style: TextStyle(color: theme.colorScheme.outline),
                        ),
                      ],
                    ),
                    onTap: () {
                      Future.microtask(
                        () => setState(() => _showOnboarding = false),
                      );
                    },
                  ),
                ],
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.primaryContainer,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(
                      color: theme.colorScheme.primary.withValues(alpha: 0.3),
                    ),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        Icons.live_help,
                        size: 18,
                        color: theme.colorScheme.primary,
                      ),
                      const SizedBox(width: 6),
                      Text(
                        'Get Started?',
                        style: TextStyle(
                          fontWeight: FontWeight.w600,
                          fontSize: 13,
                          color: theme.colorScheme.onPrimaryContainer,
                        ),
                      ),
                      const SizedBox(width: 2),
                      Icon(
                        Icons.arrow_drop_down,
                        size: 18,
                        color: theme.colorScheme.onPrimaryContainer.withValues(
                          alpha: 0.7,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          if (_showOnboarding) const SizedBox(width: 5),
          // ── Compliance Matrix — primary CTA ──
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: FilledButton.icon(
              onPressed: () => ComplianceSheet.show(context),
              icon: const Icon(Icons.gavel, size: 20),
              label: const Text(
                'Compliance',
                style: TextStyle(fontWeight: FontWeight.w600),
              ),
              style: FilledButton.styleFrom(
                backgroundColor: theme.colorScheme.primary,
                foregroundColor: theme.colorScheme.onPrimary,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(10),
                ),
                elevation: 2,
              ),
            ),
          ),
          const SizedBox(width: 5),
          // Logout / Switch Account button
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: IconButton(
              icon: const Icon(Icons.logout, size: 20),
              tooltip: 'Logout / Switch Account',
              onPressed: () {
                showDialog(
                  context: context,
                  builder: (ctx) => AlertDialog(
                    title: const Text('Switch Account'),
                    content: const Text(
                      'Clear your current identity and return to the login screen? Your session will be ended.',
                    ),
                    actions: [
                      TextButton(
                        onPressed: () => Navigator.pop(ctx),
                        child: const Text('Cancel'),
                      ),
                      FilledButton(
                        onPressed: () {
                          Navigator.pop(ctx);
                          context.read<IdentityProvider>().clearIdentity();
                        },
                        child: const Text('Logout'),
                      ),
                    ],
                  ),
                );
              },
              visualDensity: VisualDensity.compact,
            ),
          ),
        ],
      ),
      // ── Navigation Drawer (Left) ────────────────────────────────────────
      drawer: _buildDrawer(theme),
      // ── Body ─────────────────────────────────────────────────────────────
      body: LayoutBuilder(
        builder: (context, constraints) {
          if (constraints.maxWidth >= 900) {
            return _buildWideLayout();
          }
          return _buildNarrowLayout();
        },
      ),
    );
  }

  // ── Drawer ─────────────────────────────────────────────────────────────────

  Widget _buildDrawer(ThemeData theme) {
    final review = context.watch<ReviewProvider>();
    final health = context.watch<HealthProvider>();
    final identity = context.watch<IdentityProvider>();

    return Drawer(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Drawer header
          Container(
            color: theme.colorScheme.primaryContainer,
            padding: const EdgeInsets.fromLTRB(16, 48, 16, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // ── Operator name + refresh & close buttons ──
                Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(
                            Icons.verified_user,
                            size: 28,
                            color: theme.colorScheme.onPrimaryContainer,
                          ),
                          const SizedBox(height: 8),
                          Text(
                            'Active Audits',
                            style: theme.textTheme.titleMedium?.copyWith(
                              color: theme.colorScheme.onPrimaryContainer,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          Text(
                            '${review.sessions.length} session(s) monitored',
                            style: theme.textTheme.labelSmall?.copyWith(
                              color: theme.colorScheme.onPrimaryContainer
                                  .withValues(alpha: 0.6),
                            ),
                          ),
                        ],
                      ),
                    ),
                    // ── Operator name (top right) ──
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Chip(
                          avatar: Icon(
                            Icons.shield_moon,
                            size: 16,
                            color: theme.colorScheme.onPrimaryContainer,
                          ),
                          label: Text(
                            identity.displayName ?? 'Operator',
                            style: theme.textTheme.labelSmall?.copyWith(
                              color: theme.colorScheme.onPrimaryContainer,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          backgroundColor: theme.colorScheme.onPrimaryContainer
                              .withValues(alpha: 0.1),
                          side: BorderSide.none,
                          visualDensity: VisualDensity.compact,
                          padding: EdgeInsets.zero,
                        ),
                        const SizedBox(height: 4),
                        // Refresh + Close buttons
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            IconButton(
                              icon: Icon(
                                Icons.refresh,
                                size: 20,
                                color: theme.colorScheme.onPrimaryContainer
                                    .withValues(alpha: 0.7),
                              ),
                              tooltip: 'Refresh audit sessions',
                              onPressed: () => review.loadSessions(),
                              visualDensity: VisualDensity.compact,
                              padding: EdgeInsets.zero,
                              constraints: const BoxConstraints(
                                minWidth: 32,
                                minHeight: 32,
                              ),
                            ),
                            IconButton(
                              icon: Icon(
                                Icons.chevron_left,
                                size: 20,
                                color: theme.colorScheme.onPrimaryContainer
                                    .withValues(alpha: 0.7),
                              ),
                              tooltip: 'Close drawer',
                              onPressed: () => Navigator.pop(context),
                              visualDensity: VisualDensity.compact,
                              padding: EdgeInsets.zero,
                              constraints: const BoxConstraints(
                                minWidth: 32,
                                minHeight: 32,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  'Cerberus FinSec',
                  style: theme.textTheme.titleLarge?.copyWith(
                    color: theme.colorScheme.onPrimaryContainer,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                Text(
                  'Real-Time Insider Threat Guardian',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onPrimaryContainer.withValues(
                      alpha: 0.8,
                    ),
                  ),
                ),
              ],
            ),
          ),
          // Health status
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('SYSTEM HEALTH', style: theme.textTheme.labelSmall),
                const SizedBox(height: 8),
                health.isLoading
                    ? const LinearProgressIndicator()
                    : health.error != null
                    ? Row(
                        children: [
                          Icon(
                            Icons.error,
                            size: 16,
                            color: theme.colorScheme.error,
                          ),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Text(
                              health.error!,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: theme.colorScheme.error,
                              ),
                            ),
                          ),
                        ],
                      )
                    : _buildHealthGrid(theme, health),
              ],
            ),
          ),
          const Divider(),
          // ── Categorized audit session list ──
          Expanded(
            child: Builder(
              builder: (context) {
                if (review.isLoading) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (review.error != null) {
                  return Center(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.cloud_off,
                            size: 36,
                            color: theme.colorScheme.error.withValues(
                              alpha: 0.6,
                            ),
                          ),
                          const SizedBox(height: 12),
                          Text(
                            'Error: ${review.error}',
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.colorScheme.error,
                            ),
                            textAlign: TextAlign.center,
                          ),
                          const SizedBox(height: 16),
                          FilledButton.icon(
                            onPressed: () => review.loadSessions(),
                            icon: const Icon(Icons.refresh, size: 18),
                            label: const Text('Retry'),
                            style: FilledButton.styleFrom(
                              visualDensity: VisualDensity.compact,
                            ),
                          ),
                        ],
                      ),
                    ),
                  );
                }
                if (review.sessions.isEmpty) {
                  return Center(
                    child: Text(
                      'No deployed audits',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.outline,
                      ),
                    ),
                  );
                }

                // Categorize: active (eventCount > 0) vs new/inactive (eventCount == 0)
                final activeSessions = review.sessions
                    .where((s) => s.eventCount > 0)
                    .toList();
                final newSessions = review.sessions
                    .where((s) => s.eventCount == 0)
                    .toList();

                return ListView(
                  children: [
                    // ── Active Sessions Section ──
                    if (activeSessions.isNotEmpty) ...[
                      Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 16,
                          vertical: 8,
                        ),
                        child: Row(
                          children: [
                            Icon(
                              Icons.shield,
                              size: 14,
                              color: theme.colorScheme.primary,
                            ),
                            const SizedBox(width: 6),
                            Text(
                              'ACTIVE (${activeSessions.length})',
                              style: theme.textTheme.labelSmall?.copyWith(
                                color: theme.colorScheme.primary,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ],
                        ),
                      ),
                      ...activeSessions.map(
                        (session) => _buildSessionTile(theme, review, session),
                      ),
                      const Divider(indent: 16, endIndent: 16),
                    ],
                    // ── New / Inactive Sessions Section ──
                    if (newSessions.isNotEmpty) ...[
                      Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 16,
                          vertical: 8,
                        ),
                        child: Row(
                          children: [
                            Icon(
                              Icons.schedule,
                              size: 14,
                              color: theme.colorScheme.outline,
                            ),
                            const SizedBox(width: 6),
                            Text(
                              'NEW / INACTIVE (${newSessions.length})',
                              style: theme.textTheme.labelSmall?.copyWith(
                                color: theme.colorScheme.outline,
                              ),
                            ),
                          ],
                        ),
                      ),
                      ...newSessions.map(
                        (session) => _buildSessionTile(theme, review, session),
                      ),
                    ],
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildHealthGrid(ThemeData theme, HealthProvider health) {
    final status = health.status;
    if (status == null) return const SizedBox.shrink();
    return Wrap(
      spacing: 8,
      runSpacing: 4,
      children: status.services.map((svc) {
        return Chip(
          avatar: Icon(
            svc.isHealthy ? Icons.check_circle : Icons.error,
            size: 14,
            color: svc.isHealthy ? Colors.green : Colors.red,
          ),
          label: Text(
            '${svc.name} (${svc.latencyMs}ms)',
            style: theme.textTheme.labelSmall,
          ),
          backgroundColor: theme.colorScheme.surfaceContainerHighest,
          side: BorderSide.none,
        );
      }).toList(),
    );
  }

  // ── Onboarding Popup Content ──────────────────────────────────────────────
  /// Compact step-by-step guide rendered inside the AppBar dropdown.
  Widget _buildOnboardingPopupContent(ThemeData theme) {
    return Container(
      width: 320,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(16),
        color: theme.colorScheme.surface,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.rocket_launch,
                size: 22,
                color: theme.colorScheme.primary,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Get Started — Deploy Your First Audit',
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w700,
                    color: theme.colorScheme.onSurface,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          _buildOnboardingStep(
            theme,
            stepNumber: '1',
            icon: Icons.gavel,
            title: 'Click',
            boldPart: 'Compliance',
            description: 'in the top bar → matrix generator',
            isPrimary: true,
          ),
          _buildOnboardingStep(
            theme,
            stepNumber: '2',
            icon: Icons.tune,
            title: 'Configure target system, risk weights & prompt, tap',
            boldPart: 'Generate Matrix',
            description: '',
            isPrimary: false,
          ),
          _buildOnboardingStep(
            theme,
            stepNumber: '3',
            icon: Icons.rocket_launch,
            title: 'Review AI rules and tap',
            boldPart: 'Deploy',
            description: 'to create audit session',
            isPrimary: false,
          ),
          _buildOnboardingStep(
            theme,
            stepNumber: '4',
            icon: Icons.check_circle_outline,
            title: 'Select session',
            boldPart: 'from the drawer',
            description: '(☰ top left) to monitor telemetry',
            isPrimary: false,
          ),
        ],
      ),
    );
  }

  Widget _buildOnboardingStep(
    ThemeData theme, {
    required String stepNumber,
    required IconData icon,
    required String title,
    required String boldPart,
    required String description,
    required bool isPrimary,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Step circle
          Container(
            width: 26,
            height: 26,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: isPrimary
                  ? theme.colorScheme.primary
                  : theme.colorScheme.primary.withValues(alpha: 0.15),
              border: Border.all(
                color: isPrimary
                    ? theme.colorScheme.primary
                    : theme.colorScheme.primary.withValues(alpha: 0.3),
                width: 1.5,
              ),
            ),
            alignment: Alignment.center,
            child: Text(
              stepNumber,
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w700,
                color: isPrimary
                    ? theme.colorScheme.onPrimary
                    : theme.colorScheme.primary,
              ),
            ),
          ),
          const SizedBox(width: 10),
          // Step text
          Expanded(
            child: RichText(
              text: TextSpan(
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onPrimaryContainer,
                  height: 1.4,
                ),
                children: [
                  TextSpan(text: '$title '),
                  TextSpan(
                    text: boldPart,
                    style: TextStyle(
                      fontWeight: FontWeight.w700,
                      color: theme.colorScheme.primary,
                    ),
                  ),
                  if (description.isNotEmpty) TextSpan(text: ' $description'),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  // ── Wide Layout (>= 900px) ─────────────────────────────────────────────────
  Widget _buildWideLayout() {
    final theme = Theme.of(context);

    return Row(
      children: [
        // Left panel — Employee Terminal Workspace
        Expanded(
          flex: 5,
          child: Container(
            decoration: BoxDecoration(
              border: Border(
                right: BorderSide(color: theme.dividerColor, width: 2),
              ),
            ),
            child: const CodeWorkspacePanel(),
          ),
        ),
        // Right panel — Live Threat Telemetry
        Expanded(flex: 4, child: _buildTelemetryPanel(theme)),
      ],
    );
  }

  // ── Narrow Layout (< 900px) ────────────────────────────────────────────────
  Widget _buildNarrowLayout() {
    final theme = Theme.of(context);

    return Column(
      children: [
        TabBar(
          controller: _tabController,
          labelColor: theme.colorScheme.primary,
          unselectedLabelColor: theme.colorScheme.outline,
          tabs: const [
            Tab(icon: Icon(Icons.terminal), text: 'Terminal'),
            Tab(icon: Icon(Icons.shield), text: 'Telemetry'),
          ],
        ),
        Expanded(
          child: TabBarView(
            controller: _tabController,
            children: [
              const CodeWorkspacePanel(),
              const SecurityMetricsPanel(),
            ],
          ),
        ),
      ],
    );
  }

  Color _riskScoreColor(double score, ThemeData theme) {
    if (score >= 75) return Colors.red;
    if (score >= 40) return Colors.orange;
    return theme.colorScheme.primary;
  }

  Widget _buildTelemetryPanel(ThemeData theme) {
    return Container(
      color: theme.colorScheme.surface,
      child: const SecurityMetricsPanel(),
    );
  }

  // ── Shared session tile builder for drawer ───────────────────────────────

  Widget _buildSessionTile(
    ThemeData theme,
    ReviewProvider review,
    SessionSummary session,
  ) {
    final isSelected = review.selected?.sessionId == session.sessionId;
    final score = session.peakRiskScore;
    final hasEvents = session.eventCount > 0;
    final isLocked = session.status == 'locked';
    final isTerminated = session.status == 'terminated';

    // ── Status label with agentic state awareness ──
    // locked   = agent auto-locked the session on high-risk detection
    // terminated = session ended, data preserved (audit trail intact)
    final String statusText;
    final Color? statusColor;
    if (isTerminated) {
      statusText = '⛔ TERMINATED';
      statusColor = Colors.grey;
    } else if (isLocked) {
      statusText = '🔒 LOCKED';
      statusColor = Colors.red;
    } else if (hasEvents && session.alertTriggered) {
      statusText = '⚠ ALERT';
      statusColor = Colors.orange;
    } else if (hasEvents) {
      statusText = 'active';
      statusColor = null;
    } else {
      statusText = 'inactive';
      statusColor = null;
    }

    // ── Build content area (tappable) and trailing delete button ────────────
    // Uses a Card + InkWell + Row instead of ListTile to avoid Flutter's
    // gesture conflict where ListTile.onTap intercepts taps meant for the
    // trailing IconButton. See: flutter/flutter#15427, #21383.
    return Card(
      margin: EdgeInsets.zero,
      elevation: 0,
      color: isSelected
          ? theme.colorScheme.primaryContainer.withValues(alpha: 0.4)
          : Colors.transparent,
      shape: isSelected
          ? Border(left: BorderSide(color: theme.colorScheme.primary, width: 3))
          : const Border(),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          children: [
            // ── Tappable content area (InkWell only wraps this part) ──
            Expanded(
              child: InkWell(
                onTap: () {
                  // Reset guardian provider state so the right panel clears
                  // and loads the new session's timeline from scratch.
                  context.read<GuardianProvider>().resetForNewSession(
                    session.sessionId,
                  );
                  review.selectSession(session.sessionId);
                  Navigator.pop(context);
                },
                child: Row(
                  children: [
                    // ── Leading avatar / icon ──
                    if (hasEvents)
                      CircleAvatar(
                        backgroundColor: _riskScoreColor(score, theme),
                        radius: 14,
                        child: Text(
                          score.toStringAsFixed(0),
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 10,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      )
                    else
                      Icon(
                        Icons.schedule,
                        size: 28,
                        color: theme.colorScheme.outline,
                      ),
                    const SizedBox(width: 16),
                    // ── Title + subtitle ──
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            session.employeeId,
                            style: theme.textTheme.bodyMedium?.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text.rich(
                            TextSpan(
                              children: [
                                TextSpan(text: '${session.sessionId}\n'),
                                TextSpan(
                                  text: 'Events: ${session.eventCount} | ',
                                ),
                                TextSpan(
                                  text: statusText,
                                  style: TextStyle(
                                    fontWeight: FontWeight.w700,
                                    color:
                                        statusColor ??
                                        theme.colorScheme.onSurface,
                                  ),
                                ),
                              ],
                            ),
                            style: theme.textTheme.bodySmall,
                            overflow: TextOverflow.ellipsis,
                            maxLines: 2,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 8),
            // ── Delete button OUTSIDE InkWell — independent gesture zone ──
            IconButton(
              icon: Icon(
                Icons.delete_outline,
                size: 18,
                color: theme.colorScheme.error.withValues(alpha: 0.7),
              ),
              tooltip: 'Delete session',
              onPressed: () {
                showDialog(
                  context: context,
                  builder: (ctx) => AlertDialog(
                    title: const Text('Terminate Session'),
                    content: Text(
                      'Permanently delete audit session for '
                      '${session.employeeId}?\n\n'
                      'Session ID: ${session.sessionId}',
                    ),
                    actions: [
                      TextButton(
                        onPressed: () => Navigator.pop(ctx),
                        child: const Text('Cancel'),
                      ),
                      FilledButton(
                        onPressed: () {
                          Navigator.pop(ctx);
                          review.deleteSession(session.sessionId);
                        },
                        style: FilledButton.styleFrom(
                          backgroundColor: theme.colorScheme.error,
                        ),
                        child: const Text('Delete'),
                      ),
                    ],
                  ),
                );
              },
              visualDensity: VisualDensity.compact,
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
            ),
          ],
        ),
      ),
    );
  }
}

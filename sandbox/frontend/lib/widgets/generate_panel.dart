import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/generate_model.dart';
import '../providers/generate_provider.dart';
import '../providers/identity_provider.dart';
import '../providers/guardian_provider.dart';
import '../providers/review_provider.dart';

/// ─── Cerberus FinSec — Compliance Matrix Bottom Sheet ─────────────────────────
/// A self-contained bottom sheet that handles the full lifecycle:
///   Configuration → Loading → Result/Deploy → Error/Cancelled.
///
/// Called from the dashboard via [ComplianceSheet.show].
/// While generation is in-flight the sheet cannot be dismissed;
/// after a result is produced the user must deploy (or explicitly discard)
/// before the sheet can be closed.

class ComplianceSheet {
  ComplianceSheet._();

  /// Shows the compliance matrix bottom sheet.
  static void show(BuildContext context) {
    Navigator.of(context).push(
      _ComplianceSheetRoute(builder: (ctx) => const _ComplianceSheetContent()),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Deploy Dialog — pre-filled fields + manual session ID entry
// ═══════════════════════════════════════════════════════════════════════════════

class _DeployDialog extends StatefulWidget {
  final String employeeId;
  final String matrixId;
  final String targetSystem;
  final String defaultSessionId;

  const _DeployDialog({
    required this.employeeId,
    required this.matrixId,
    required this.targetSystem,
    required this.defaultSessionId,
  });

  @override
  State<_DeployDialog> createState() => _DeployDialogState();
}

class _DeployDialogState extends State<_DeployDialog> {
  late final TextEditingController _sessionIdController;
  final _formKey = GlobalKey<FormState>();

  @override
  void initState() {
    super.initState();
    _sessionIdController = TextEditingController(text: widget.defaultSessionId);
  }

  @override
  void dispose() {
    _sessionIdController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AlertDialog(
      title: Row(
        children: [
          Icon(Icons.rocket_launch, size: 22, color: theme.colorScheme.primary),
          const SizedBox(width: 8),
          const Text('Deploy Compliance Matrix'),
        ],
      ),
      content: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Employee ID (pre-filled, read-only)
            _buildReadOnlyField(
              theme,
              'Employee ID',
              widget.employeeId,
              Icons.badge_outlined,
            ),
            const SizedBox(height: 12),
            // Matrix ID (pre-filled, read-only)
            _buildReadOnlyField(
              theme,
              'Matrix ID',
              widget.matrixId,
              Icons.fingerprint,
            ),
            const SizedBox(height: 12),
            // Target System (pre-filled, read-only)
            _buildReadOnlyField(
              theme,
              'Target System',
              widget.targetSystem,
              Icons.dns_outlined,
            ),
            const SizedBox(height: 16),
            // Session ID (user must enter)
            Text(
              'Session ID',
              style: theme.textTheme.labelMedium?.copyWith(
                fontWeight: FontWeight.w600,
                color: theme.colorScheme.onSurface,
              ),
            ),
            const SizedBox(height: 6),
            TextFormField(
              controller: _sessionIdController,
              decoration: InputDecoration(
                hintText: 'e.g. session_abc123',
                filled: true,
                fillColor: theme.colorScheme.surfaceContainerHighest,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: BorderSide.none,
                ),
                prefixIcon: Icon(
                  Icons.tag,
                  size: 18,
                  color: theme.colorScheme.primary,
                ),
              ),
              validator: (value) {
                if (value == null || value.trim().isEmpty) {
                  return 'Please enter a session ID';
                }
                if (!RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(value.trim())) {
                  return 'Only alphanumeric, dash, and underscore allowed';
                }
                return null;
              },
              autofocus: true,
              textInputAction: TextInputAction.done,
              onFieldSubmitted: (_) => _onDeployPressed(),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(null),
          child: const Text('Cancel'),
        ),
        FilledButton.icon(
          onPressed: _onDeployPressed,
          icon: const Icon(Icons.rocket_launch, size: 16),
          label: const Text('Deploy'),
          style: FilledButton.styleFrom(
            backgroundColor: theme.colorScheme.primary,
          ),
        ),
      ],
    );
  }

  Widget _buildReadOnlyField(
    ThemeData theme,
    String label,
    String value,
    IconData icon,
  ) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: theme.textTheme.labelMedium?.copyWith(
            fontWeight: FontWeight.w600,
            color: theme.colorScheme.onSurface,
          ),
        ),
        const SizedBox(height: 4),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: theme.colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            children: [
              Icon(icon, size: 16, color: theme.colorScheme.outline),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  value,
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontFamily: 'monospace',
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  void _onDeployPressed() {
    if (_formKey.currentState?.validate() ?? false) {
      Navigator.of(context).pop(_sessionIdController.text.trim());
    }
  }
}

// ── Custom modal route ────────────────────────────────────────────────────────
class _ComplianceSheetRoute<T> extends PopupRoute<T> {
  _ComplianceSheetRoute({required this.builder});

  final WidgetBuilder builder;

  @override
  bool get barrierDismissible => false;

  @override
  String? get barrierLabel => null;

  @override
  Color get barrierColor => Colors.black54;

  @override
  Duration get transitionDuration => const Duration(milliseconds: 300);

  @override
  Widget buildPage(
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
  ) {
    return builder(context);
  }

  @override
  Widget buildTransitions(
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    return SlideTransition(
      position: Tween<Offset>(
        begin: const Offset(0, 1),
        end: Offset.zero,
      ).animate(CurvedAnimation(parent: animation, curve: Curves.easeOutCubic)),
      child: child,
    );
  }
}

// ── Content widget ────────────────────────────────────────────────────────────

class _ComplianceSheetContent extends StatefulWidget {
  const _ComplianceSheetContent();

  @override
  State<_ComplianceSheetContent> createState() =>
      _ComplianceSheetContentState();
}

class _ComplianceSheetContentState extends State<_ComplianceSheetContent> {
  final _promptController = TextEditingController();
  final _scrollController = ScrollController();

  String _selectedTargetSystem = '';
  int _vectorCount = 1;
  double _routineWeight = 0.3;
  double _elevatedWeight = 0.5;
  double _criticalWeight = 0.2;
  static const double _riskFloor = 0.1;

  bool _hasDeployed = false;
  String? _promptError;

  static const _targetSystemOptions = <Map<String, String>>[
    {'value': '', 'label': '- Select target system -'},
    {'value': 'core-trading-ledger', 'label': 'Core Trading Ledger'},
    {'value': 'swift-gateway', 'label': 'SWIFT Gateway'},
    {'value': 'hft-desk', 'label': 'High-Frequency Trading Desk'},
    {'value': 'aml-compliance', 'label': 'AML Compliance Engine'},
    {'value': 'fedwire-gateway', 'label': 'Fedwire Funds Gateway'},
    {'value': 'ach-processor', 'label': 'ACH Batch Processor'},
    {'value': 'treasury-mgmt', 'label': 'Treasury Management System'},
    {'value': 'kyc-onboarding', 'label': 'KYC Onboarding Platform'},
    {'value': 'fraud-detection', 'label': 'Fraud Detection Engine'},
    {'value': 'regulatory-reporting', 'label': 'Regulatory Reporting Hub'},
    {'value': 'digital-banking', 'label': 'Digital Banking Platform'},
    {'value': 'card-issuance', 'label': 'Card Issuance & Authorization'},
    {'value': 'market-data-feed', 'label': 'Market Data Feed'},
    {'value': 'risk-management', 'label': 'Risk Management Console'},
    {'value': 'clearing-settlement', 'label': 'Clearing & Settlement'},
    {'value': 'wealth-management', 'label': 'Wealth Management Portal'},
    {'value': 'insurance-underwriting', 'label': 'Insurance Underwriting'},
    {'value': 'crypto-custody', 'label': 'Digital Asset Custody'},
    {'value': 'comms-surveillance', 'label': 'Communications Surveillance'},
    {'value': 'other-finsys', 'label': 'Other / Generic FinSys'},
  ];

  static const _targetSystemIcons = <String, IconData>{
    'core-trading-ledger': Icons.account_balance,
    'swift-gateway': Icons.swap_horiz,
    'hft-desk': Icons.speed,
    'aml-compliance': Icons.gavel,
    'fedwire-gateway': Icons.currency_exchange,
    'ach-processor': Icons.receipt_long,
    'treasury-mgmt': Icons.savings,
    'kyc-onboarding': Icons.person_search,
    'fraud-detection': Icons.shield,
    'regulatory-reporting': Icons.description,
    'digital-banking': Icons.phone_android,
    'card-issuance': Icons.credit_card,
    'market-data-feed': Icons.show_chart,
    'risk-management': Icons.warning_amber,
    'clearing-settlement': Icons.compare_arrows,
    'wealth-management': Icons.diamond,
    'insurance-underwriting': Icons.health_and_safety,
    'crypto-custody': Icons.key,
    'comms-surveillance': Icons.mic,
    'other-finsys': Icons.cloud,
  };

  /// Short suggestion chips shown below the audit prompt when a target
  /// system is selected.  Tapping a chip pastes its label into the prompt.
  static const _targetSystemSuggestions = <String, List<String>>{
    'core-trading-ledger': [
      'Unauthorized trade entries',
      'Position manipulation',
      'SOX compliance gaps',
      'PnL adjustment anomalies',
    ],
    'swift-gateway': [
      'Wire transfer anomalies',
      'Sanctions screening bypasses',
      'MT/MX message tampering',
      'OFAC compliance gaps',
    ],
    'hft-desk': [
      'Quote-stuffing patterns',
      'Layering / spoofing',
      'Latency arbitrage abuse',
      'Kill-switch failures',
    ],
    'aml-compliance': [
      'SAR backlogs',
      'Threshold tuning gaps',
      'CTR aggregation failures',
      'Smurfing detection bypasses',
    ],
    'fedwire-gateway': [
      'Large-value transfer anomalies',
      'Duplicate payment attempts',
      'Daylight overdraft breaches',
      'OFAC settlement gaps',
    ],
    'ach-processor': [
      'Unauthorized batch edits',
      'Payroll fraud patterns',
      'NACHA rule violations',
      'Account takeover indicators',
    ],
    'treasury-mgmt': [
      'Liquidity reporting gaps',
      'Intercompany loan irregularities',
      'Interest-rate risk mispricing',
      'Hedge accounting breaches',
    ],
    'kyc-onboarding': [
      'CDD / EDD bypasses',
      'Document forgery',
      'Beneficial ownership gaps',
      'FinCEN disclosure failures',
    ],
    'fraud-detection': [
      'Model drift',
      'False-positive spikes',
      'Synthetic identity clusters',
      'Missed anomaly scoring',
    ],
    'regulatory-reporting': [
      'Filing timeliness violations',
      'Data completeness gaps',
      'CAT / TRACE errors',
      'Cross-jurisdiction inaccuracies',
    ],
    'digital-banking': [
      'Session hijacking',
      'Credential stuffing',
      'Unauthorized fund transfers',
      'Mobile channel exploits',
    ],
    'card-issuance': [
      'BIN attacks',
      'Velocity-check bypasses',
      'PCI-DSS violations',
      'Cardholder data exposure',
    ],
    'market-data-feed': [
      'Data-integrity tampering',
      'Quote-delay injection',
      'Unauthorized redistribution',
      'Proprietary data leaks',
    ],
    'risk-management': [
      'VaR model tampering',
      'Stress-test manipulation',
      'Limit-breach overrides',
      'Basel III/IV non-compliance',
    ],
    'clearing-settlement': [
      'DvP failures',
      'Collateral shortfalls',
      'CCP margin call gaps',
      'Settlement timing breaches',
    ],
    'wealth-management': [
      'Discretionary trade violations',
      'Suitability rule breaches',
      'Unauthorized rebalancing',
      'Reg BI non-compliance',
    ],
    'insurance-underwriting': [
      'Premium leakage',
      'Policy-lapsing anomalies',
      'Reinsurance treaty gaps',
      'Solvency II violations',
    ],
    'crypto-custody': [
      'Key-ceremony bypasses',
      'Hot-wallet drain patterns',
      'Travel-rule gaps',
      'Multi-sig misconfiguration',
    ],
    'comms-surveillance': [
      'Insider-trading lexicon hits',
      'Channel-hopping detection',
      'E-comm retention gaps',
      'SEC Rule 17a-4 violations',
    ],
    'other-finsys': [
      'Privilege escalation',
      'Data exfiltration',
      'Unauthorized API access',
      'Cloud sync bypasses',
    ],
  };

  @override
  void dispose() {
    _promptController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Close guard
  // ═════════════════════════════════════════════════════════════════════════════

  void _tryClose() {
    final gen = context.read<GenerateProvider>();

    if (gen.isLoading) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Cannot close while generation is in progress. '
            'Cancel the generation first.',
          ),
          backgroundColor: Colors.orange,
        ),
      );
      return;
    }

    if (gen.matrix != null && !_hasDeployed) {
      _showDiscardConfirmDialog();
      return;
    }

    _resetAndPop();
  }

  void _showDiscardConfirmDialog() {
    final theme = Theme.of(context);
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: Icon(
          Icons.warning_amber_rounded,
          color: theme.colorScheme.error,
          size: 32,
        ),
        title: const Text('Discard Generated Matrix?'),
        content: const Text(
          'You have not deployed this compliance matrix. '
          'If you close now, the generated result will be lost '
          'and you will need to generate it again.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Keep'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.of(ctx).pop();
              _resetAndPop();
            },
            style: FilledButton.styleFrom(
              backgroundColor: theme.colorScheme.error,
            ),
            child: const Text('Discard & Close'),
          ),
        ],
      ),
    );
  }

  void _resetAndPop() {
    context.read<GenerateProvider>().reset();
    Navigator.of(context).pop();
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Validation
  // ═════════════════════════════════════════════════════════════════════════════

  String? _validatePrompt(String prompt) {
    final trimmed = prompt.trim();
    if (trimmed.isEmpty) {
      return 'Please enter a prompt describing the compliance audit or '
          'threat matrix you want to generate.';
    }
    return null;
  }

  void _showErrorDialog(String message, {String title = 'Validation Error'}) {
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: Row(
          children: [
            Icon(Icons.error_outline, color: Theme.of(ctx).colorScheme.error),
            const SizedBox(width: 8),
            Text(title),
          ],
        ),
        content: Text(message),
        actions: [
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Generate trigger
  // ═════════════════════════════════════════════════════════════════════════════

  void _onGenerate() {
    final prompt = _promptController.text;
    if (prompt.trim().isEmpty) {
      setState(() => _promptError = 'Audit prompt is required');
      return;
    }
    if (_selectedTargetSystem.isEmpty) {
      _showErrorDialog(
        'Please select a target system (e.g. "SWIFT Gateway") before generating.',
        title: 'Missing Target System',
      );
      return;
    }
    final validationError = _validatePrompt(prompt);
    if (validationError != null) {
      _showErrorDialog(validationError);
      return;
    }
    final structuredPrompt = _buildStructuredPrompt(prompt);
    FocusScope.of(context).unfocus();
    _promptController.clear();
    _hasDeployed = false;
    context.read<GenerateProvider>().generate(
      structuredPrompt,
      vectorCount: _vectorCount,
      targetSystemContext: _selectedTargetSystem,
    );
  }

  String _buildStructuredPrompt(String userPrompt) {
    final systemLabel = _targetSystemOptions.firstWhere(
      (d) => d['value'] == _selectedTargetSystem,
      orElse: () => _targetSystemOptions.first,
    )['label']!;
    final riskDesc =
        '${(_routineWeight * 100).round()}% routine, '
        '${(_elevatedWeight * 100).round()}% elevated, '
        '${(_criticalWeight * 100).round()}% critical';
    return 'Target System: $systemLabel\n'
        'Risk distribution: $riskDesc\n'
        'Number of threat vectors: $_vectorCount\n'
        'Audit requirements: $userPrompt\n'
        '---\n'
        'IMPORTANT: Scope ALL threat vectors, regulatory mandates, and '
        'penetration scenarios exclusively within the "$systemLabel" '
        'context. Include specific regulatory rules (AML, SOX, GDPR, '
        'FINRA, etc.) where applicable.';
  }

  void _confirmCancel() {
    final theme = Theme.of(context);
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: Icon(
          Icons.warning_amber_rounded,
          color: theme.colorScheme.error,
          size: 32,
        ),
        title: const Text('Cancel Matrix Generation?'),
        content: const Text(
          'Are you sure you want to stop the current generation? '
          'Your prompt and settings will be saved so you can resume later.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Continue Generating'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.of(ctx).pop();
              context.read<GenerateProvider>().cancel();
            },
            style: FilledButton.styleFrom(
              backgroundColor: theme.colorScheme.error,
            ),
            child: const Text('Yes, Cancel'),
          ),
        ],
      ),
    );
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Build
  // ═════════════════════════════════════════════════════════════════════════════

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final gen = context.watch<GenerateProvider>();

    final bool showLoading = gen.isLoading;
    final bool showCancelled = gen.isCancelled;
    final bool showError =
        gen.error != null && gen.matrix == null && !gen.isCancelled;
    final bool showResult = gen.matrix != null;

    return GestureDetector(
      onTap: () {},
      child: SafeArea(
        child: Scaffold(
          backgroundColor: Colors.transparent,
          body: _buildDialogCard(
            theme,
            gen,
            showLoading,
            showCancelled,
            showError,
            showResult,
          ),
        ),
      ),
    );
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Dialog Card Wrapper — centered on tablet/desktop, bottom sheet on mobile
  // ═════════════════════════════════════════════════════════════════════════════

  Widget _buildDialogCard(
    ThemeData theme,
    GenerateProvider gen,
    bool showLoading,
    bool showCancelled,
    bool showError,
    bool showResult,
  ) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final isWide = constraints.maxWidth >= 600;
        Widget card = Container(
          decoration: BoxDecoration(
            color: theme.colorScheme.surface,
            borderRadius: isWide
                ? BorderRadius.circular(24)
                : const BorderRadius.vertical(top: Radius.circular(20)),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.25),
                blurRadius: isWide ? 40 : 20,
                offset: isWide ? Offset.zero : const Offset(0, -4),
              ),
            ],
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (!isWide)
                Center(
                  child: Container(
                    margin: const EdgeInsets.only(top: 10, bottom: 6),
                    width: 40,
                    height: 4,
                    decoration: BoxDecoration(
                      color: theme.colorScheme.onSurfaceVariant.withValues(
                        alpha: 0.3,
                      ),
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
              // Header
              Padding(
                padding: EdgeInsets.symmetric(
                  horizontal: 20,
                  vertical: isWide ? 16 : 4,
                ),
                child: Row(
                  children: [
                    Icon(
                      Icons.shield_moon,
                      size: 22,
                      color: theme.colorScheme.primary,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        showResult
                            ? 'Compliance Matrix Generated'
                            : showLoading
                            ? 'Generating...'
                            : showCancelled
                            ? 'Generation Cancelled'
                            : showError
                            ? 'Generation Failed'
                            : 'New Assessment Matrix',
                        style: theme.textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.close, size: 20),
                      onPressed: _tryClose,
                      visualDensity: VisualDensity.compact,
                      tooltip: gen.isLoading
                          ? 'Cancel generation first'
                          : 'Close',
                    ),
                  ],
                ),
              ),
              const Divider(height: 1),
              // Body
              Flexible(
                child: showLoading
                    ? _buildLoadingState(theme)
                    : showCancelled
                    ? _buildCancelledState(theme)
                    : showError
                    ? _buildErrorState(theme, gen)
                    : showResult
                    ? _buildResultState(theme, gen.matrix!)
                    : _buildConfigContent(theme),
              ),
            ],
          ),
        );

        if (isWide) {
          return Center(
            child: ConstrainedBox(
              constraints: BoxConstraints(
                maxWidth: 650,
                maxHeight: constraints.maxHeight * 0.9,
              ),
              child: card,
            ),
          );
        }

        return Align(
          alignment: Alignment.bottomCenter,
          child: Container(
            constraints: BoxConstraints(
              maxHeight: constraints.maxHeight * 0.88,
            ),
            child: card,
          ),
        );
      },
    );
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Config Page
  // ═════════════════════════════════════════════════════════════════════════════

  Widget _buildConfigContent(ThemeData theme) {
    return StatefulBuilder(
      builder: (sbCtx, setSheetState) {
        return ListView(
          controller: _scrollController,
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
          children: [
            _buildSheetLabel(theme, 'Target System', Icons.dns_outlined),
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              initialValue: _selectedTargetSystem.isNotEmpty
                  ? _selectedTargetSystem
                  : null,
              hint: const Text('Select target system...'),
              isExpanded: true,
              decoration: InputDecoration(
                filled: true,
                fillColor: theme.colorScheme.surfaceContainerHighest,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: BorderSide.none,
                ),
                prefixIcon: Icon(
                  _selectedTargetSystem.isNotEmpty
                      ? (_targetSystemIcons[_selectedTargetSystem] ??
                            Icons.dns_outlined)
                      : Icons.dns_outlined,
                  size: 18,
                  color: theme.colorScheme.primary,
                ),
              ),
              items: _targetSystemOptions
                  .where((d) => d['value']!.isNotEmpty)
                  .map((sys) {
                    final value = sys['value']!;
                    final icon = _targetSystemIcons[value] ?? Icons.shield;
                    return DropdownMenuItem<String>(
                      value: value,
                      child: Row(
                        children: [
                          Icon(
                            icon,
                            size: 18,
                            color: theme.colorScheme.primary,
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              sys['label']!,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        ],
                      ),
                    );
                  })
                  .toList(),
              onChanged: (value) {
                setState(() => _selectedTargetSystem = value ?? '');
                setSheetState(() {});
              },
            ),
            const SizedBox(height: 16),
            _buildSheetLabel(
              theme,
              'Threat Vectors',
              Icons.bug_report_outlined,
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                IconButton(
                  icon: Icon(
                    Icons.remove_circle_outline,
                    color: theme.colorScheme.primary,
                  ),
                  onPressed: _vectorCount <= 1
                      ? null
                      : () {
                          setState(() => _vectorCount--);
                          setSheetState(() {});
                        },
                ),
                Container(
                  width: 48,
                  alignment: Alignment.center,
                  padding: const EdgeInsets.symmetric(
                    vertical: 8,
                    horizontal: 12,
                  ),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    '$_vectorCount',
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                      color: theme.colorScheme.primary,
                    ),
                  ),
                ),
                IconButton(
                  icon: Icon(
                    Icons.add_circle_outline,
                    color: theme.colorScheme.primary,
                  ),
                  onPressed: _vectorCount >= 20
                      ? null
                      : () {
                          setState(() => _vectorCount++);
                          setSheetState(() {});
                        },
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Slider(
                    value: _vectorCount.toDouble(),
                    min: 1,
                    max: 20,
                    divisions: 19,
                    onChanged: (v) {
                      setState(() => _vectorCount = v.round());
                      setSheetState(() {});
                    },
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            _buildSheetLabel(theme, 'Risk Distribution Weights', Icons.tune),
            const SizedBox(height: 4),
            Builder(
              builder: (_) {
                final sum = _routineWeight + _elevatedWeight + _criticalWeight;
                final totalPct = (sum * 100).round();
                return Text(
                  'Total: $totalPct%',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.outline,
                  ),
                );
              },
            ),
            const SizedBox(height: 6),
            _buildSheetRiskSlider(
              theme,
              'Routine',
              _routineWeight,
              Colors.green,
              (v) {
                final remaining = 1.0 - _elevatedWeight - _criticalWeight;
                final capped = v > remaining ? remaining : v;
                setState(() => _routineWeight = capped);
                setSheetState(() {});
              },
            ),
            _buildSheetRiskSlider(
              theme,
              'Elevated',
              _elevatedWeight,
              Colors.orange,
              (v) {
                final remaining = 1.0 - _routineWeight - _criticalWeight;
                final capped = v > remaining ? remaining : v;
                setState(() => _elevatedWeight = capped);
                setSheetState(() {});
              },
            ),
            _buildSheetRiskSlider(
              theme,
              'Critical',
              _criticalWeight,
              Colors.red,
              (v) {
                final remaining = 1.0 - _routineWeight - _elevatedWeight;
                final capped = v > remaining ? remaining : v;
                setState(() => _criticalWeight = capped);
                setSheetState(() {});
              },
            ),
            const SizedBox(height: 16),
            _buildSheetLabel(
              theme,
              'Audit Prompt',
              Icons.edit_note,
              isRequired: true,
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _promptController,
              minLines: 2,
              maxLines: 5,
              onChanged: (_) {
                if (_promptError != null) {
                  setState(() => _promptError = null);
                }
              },
              decoration: InputDecoration(
                hintText:
                    'e.g. "Audit the SWIFT Gateway and Core Trading Ledger for AML and SOX compliance violations"',
                hintMaxLines: 2,
                errorText: _promptError,
                filled: true,
                fillColor: theme.colorScheme.surfaceContainerHighest,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: BorderSide.none,
                ),
                errorBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: BorderSide(
                    color: theme.colorScheme.error,
                    width: 1.5,
                  ),
                ),
                focusedErrorBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: BorderSide(
                    color: theme.colorScheme.error,
                    width: 2,
                  ),
                ),
              ),
            ),
            if (_selectedTargetSystem.isNotEmpty) ...[
              const SizedBox(height: 12),
              _buildSheetLabel(theme, 'Suggestions', Icons.lightbulb_outline),
              const SizedBox(height: 8),
              ..._buildSuggestionChips(theme, setSheetState),
            ],
            const SizedBox(height: 24),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () {
                      _promptController.clear();
                      setState(() {
                        _selectedTargetSystem = '';
                        _vectorCount = 1;
                        _routineWeight = 0.3;
                        _elevatedWeight = 0.5;
                        _criticalWeight = 0.2;
                      });
                    },
                    icon: const Icon(Icons.refresh, size: 18),
                    label: const Text('Reset'),
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size(0, 48),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: _selectedTargetSystem.isEmpty
                        ? null
                        : _onGenerate,
                    icon: const Icon(Icons.shield, size: 18),
                    label: const Text('Generate Matrix'),
                    style: FilledButton.styleFrom(
                      minimumSize: const Size(0, 48),
                      backgroundColor: theme.colorScheme.primary,
                    ),
                  ),
                ),
              ],
            ),
          ],
        );
      },
    );
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Loading State
  // ═════════════════════════════════════════════════════════════════════════════

  Widget _buildLoadingState(ThemeData theme) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(
            width: 56,
            height: 56,
            child: CircularProgressIndicator(strokeWidth: 3),
          ),
          const SizedBox(height: 24),
          Text(
            'Generating compliance matrix...',
            style: theme.textTheme.bodyLarge?.copyWith(
              color: theme.colorScheme.onSurface,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'This may take 10-30 seconds.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 32),
          OutlinedButton.icon(
            onPressed: () => _confirmCancel(),
            icon: const Icon(Icons.stop_circle_outlined, size: 18),
            label: const Text('Cancel Generation'),
            style: OutlinedButton.styleFrom(
              foregroundColor: theme.colorScheme.error,
              side: BorderSide(color: theme.colorScheme.error),
            ),
          ),
        ],
      ),
    );
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Cancelled State
  // ═════════════════════════════════════════════════════════════════════════════

  Widget _buildCancelledState(ThemeData theme) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.pause_circle_outlined,
              size: 56,
              color: theme.colorScheme.error,
            ),
            const SizedBox(height: 16),
            Text(
              'Generation Cancelled',
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              'Your prompt and settings have been saved. '
              'You can resume or start a new generation.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                OutlinedButton.icon(
                  onPressed: () {
                    context.read<GenerateProvider>().reset();
                    setState(() => _hasDeployed = false);
                  },
                  icon: const Icon(Icons.refresh, size: 18),
                  label: const Text('Start New'),
                ),
                const SizedBox(width: 12),
                FilledButton.icon(
                  onPressed: () => context.read<GenerateProvider>().resume(),
                  icon: const Icon(Icons.play_arrow, size: 18),
                  label: const Text('Resume'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Error State
  // ═════════════════════════════════════════════════════════════════════════════

  Widget _buildErrorState(ThemeData theme, GenerateProvider gen) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline, size: 56, color: theme.colorScheme.error),
            const SizedBox(height: 16),
            Text(
              'Generation Failed',
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              gen.error ?? 'An unknown error occurred.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                OutlinedButton.icon(
                  onPressed: () {
                    gen.reset();
                    setState(() => _hasDeployed = false);
                  },
                  icon: const Icon(Icons.refresh, size: 18),
                  label: const Text('Start New'),
                ),
                const SizedBox(width: 12),
                if (gen.canManualRetry)
                  FilledButton.icon(
                    onPressed: () => gen.retry(),
                    icon: const Icon(Icons.replay, size: 18),
                    label: const Text('Retry'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Result State
  // ═════════════════════════════════════════════════════════════════════════════

  Widget _buildResultState(ThemeData theme, ComplianceMatrix matrix) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
      children: [
        // ── Metadata card ──────────────────────────────────────────────────
        Card(
          elevation: 0,
          color: theme.colorScheme.primaryContainer.withValues(alpha: 0.3),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(Icons.check_circle, color: Colors.green, size: 20),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'Compliance Matrix Ready',
                        style: theme.textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w600,
                          color: theme.colorScheme.primary,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                _metadataRow(theme, 'Matrix ID', matrix.metadata.matrixId),
                _metadataRow(theme, 'Model', matrix.metadata.modelVersion),
                _metadataRow(
                  theme,
                  'Generated',
                  _formatTimestamp(matrix.metadata.generatedAt),
                ),
                _metadataRow(
                  theme,
                  'Tokens',
                  '${matrix.metadata.tokenUsage.totalTokens} total '
                      '(${matrix.metadata.tokenUsage.promptTokens} prompt + '
                      '${matrix.metadata.tokenUsage.completionTokens} completion)',
                ),
                _metadataRow(
                  theme,
                  'Summary',
                  '${matrix.targetSystems.length} system(s) · '
                      '${matrix.regulatoryMandates.length} mandate(s) · '
                      '${matrix.threatVectors.length} vector(s) · '
                      '${matrix.auditTrailMatrices.length} audit trail(s)',
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),

        // ── Target Systems ─────────────────────────────────────────────────
        if (matrix.targetSystems.isNotEmpty) ...[
          _buildSheetLabel(theme, 'Target Systems', Icons.dns_outlined),
          const SizedBox(height: 8),
          ...matrix.targetSystems.map(
            (sys) => Card(
              margin: const EdgeInsets.only(bottom: 6),
              elevation: 0,
              color: theme.colorScheme.surfaceContainerLow,
              child: ListTile(
                leading: Icon(
                  _targetSystemIcons[sys.systemId] ?? Icons.shield,
                  size: 20,
                  color: _criticalityColor(sys.criticalityTier, theme),
                ),
                title: Text(
                  sys.title,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
                subtitle: Text(
                  '${sys.criticalityTier.toUpperCase()} · '
                  '${sys.requiredMandateIds.length} mandate(s)',
                  style: theme.textTheme.labelSmall,
                ),
              ),
            ),
          ),
          const SizedBox(height: 16),
        ],

        // ── Regulatory Mandates ────────────────────────────────────────────
        if (matrix.regulatoryMandates.isNotEmpty) ...[
          _buildSheetLabel(theme, 'Regulatory Mandates', Icons.gavel),
          const SizedBox(height: 8),
          ...matrix.regulatoryMandates.map(
            (mandate) => Card(
              margin: const EdgeInsets.only(bottom: 6),
              elevation: 0,
              color: theme.colorScheme.surfaceContainerLow,
              child: ExpansionTile(
                leading: const Icon(
                  Icons.policy,
                  size: 20,
                  color: Colors.indigo,
                ),
                title: Text(
                  mandate.name,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
                subtitle: Text(
                  'Weight: ${(mandate.weight * 100).round()}%',
                  style: theme.textTheme.labelSmall,
                ),
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          mandate.description,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                        if (mandate.subMandates.isNotEmpty) ...[
                          const SizedBox(height: 8),
                          ...mandate.subMandates.map(
                            (sub) => Padding(
                              padding: const EdgeInsets.only(left: 12, top: 4),
                              child: Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text('• ', style: theme.textTheme.bodySmall),
                                  Expanded(
                                    child: Text(
                                      '${sub.name} (${(sub.weight * 100).round()}%): ${sub.description}',
                                      style: theme.textTheme.bodySmall
                                          ?.copyWith(
                                            color: theme
                                                .colorScheme
                                                .onSurfaceVariant,
                                          ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
        ],

        // ── Threat Vectors ─────────────────────────────────────────────────
        _buildSheetLabel(theme, 'Threat Vectors', Icons.bug_report_outlined),
        const SizedBox(height: 8),
        ...matrix.threatVectors.map(
          (vector) => _buildVectorCard(theme, vector),
        ),
        const SizedBox(height: 16),

        // ── Audit Trail Matrices ───────────────────────────────────────────
        if (matrix.auditTrailMatrices.isNotEmpty) ...[
          _buildSheetLabel(theme, 'Audit Trail Matrices', Icons.track_changes),
          const SizedBox(height: 8),
          ...matrix.auditTrailMatrices.map(
            (trail) => Card(
              margin: const EdgeInsets.only(bottom: 6),
              elevation: 0,
              color: theme.colorScheme.surfaceContainerLow,
              child: ExpansionTile(
                leading: const Icon(
                  Icons.track_changes,
                  size: 20,
                  color: Colors.teal,
                ),
                title: Text(
                  trail.trailName,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
                subtitle: Text(
                  'Threshold: ${trail.escalationThreshold} · '
                  '${trail.logSources.length} source(s)',
                  style: theme.textTheme.labelSmall,
                ),
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          trail.description,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Severity: ${trail.severityMapping}',
                          style: theme.textTheme.labelSmall?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          'Log Sources: ${trail.logSources.join(", ")}',
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                        if (trail.detectionRules.isNotEmpty) ...[
                          const SizedBox(height: 4),
                          Text(
                            'Detection Rules:',
                            style: theme.textTheme.labelSmall?.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          ...trail.detectionRules.map(
                            (rule) => Padding(
                              padding: const EdgeInsets.only(left: 8),
                              child: Text(
                                '• $rule',
                                style: theme.textTheme.labelSmall?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
        ],

        // ── Deploy button ──────────────────────────────────────────────────
        SizedBox(
          width: double.infinity,
          height: 52,
          child: FilledButton.icon(
            onPressed: _hasDeployed ? null : () => _onDeploy(matrix),
            icon: Icon(
              _hasDeployed ? Icons.check_circle : Icons.rocket_launch,
              size: 20,
            ),
            label: Text(_hasDeployed ? 'Deployed' : 'Deploy to Session'),
            style: FilledButton.styleFrom(
              backgroundColor: _hasDeployed
                  ? Colors.green
                  : theme.colorScheme.primary,
              textStyle: theme.textTheme.titleSmall,
            ),
          ),
        ),
        const SizedBox(height: 12),
        // Generate new button
        SizedBox(
          width: double.infinity,
          height: 48,
          child: OutlinedButton.icon(
            onPressed: () {
              context.read<GenerateProvider>().reset();
              setState(() => _hasDeployed = false);
            },
            icon: const Icon(Icons.refresh, size: 18),
            label: const Text('Generate New Matrix'),
          ),
        ),
        const SizedBox(height: 12),
        // Close button
        SizedBox(
          width: double.infinity,
          height: 48,
          child: OutlinedButton.icon(
            onPressed: _tryClose,
            icon: const Icon(Icons.close, size: 18),
            label: const Text('Close'),
            style: OutlinedButton.styleFrom(
              foregroundColor: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ),
        const SizedBox(height: 16),
      ],
    );
  }

  // ── Deploy ────────────────────────────────────────────────────────────────

  void _onDeploy(ComplianceMatrix matrix) async {
    final identity = context.read<IdentityProvider>();
    final employeeId = identity.employeeId;
    if (employeeId == null || employeeId.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'No employee identity found. Please set up your identity first.',
          ),
          backgroundColor: Colors.red,
        ),
      );
      return;
    }

    // Pick the best matrix ID from audit trail or metadata
    final matrixId = matrix.auditTrailMatrices.isNotEmpty
        ? matrix.auditTrailMatrices.first.matrixId
        : matrix.metadata.matrixId;
    // Resolve the actual target-system ID (swift-gateway, core-ledger, etc.)
    // and a human-readable label for the dialog.
    final String targetSystemValue;
    final String targetSystemLabel;

    if (matrix.targetSystems.isNotEmpty) {
      final first = matrix.targetSystems.first;
      targetSystemValue = first.systemId.isNotEmpty
          ? first.systemId
          : first.title;
      targetSystemLabel = first.title.isNotEmpty
          ? first.title
          : targetSystemValue;
    } else {
      // Use the value the user picked from the dropdown in the config step
      targetSystemValue = _selectedTargetSystem.isNotEmpty
          ? _selectedTargetSystem
          : _targetSystemOptions
                    .skip(1) // skip the placeholder
                    .firstOrNull?['value'] ??
                'core-banking';
      // Look up the human-readable label for the dialog
      targetSystemLabel =
          _targetSystemOptions.firstWhere(
            (d) => d['value'] == targetSystemValue,
            orElse: () => {'label': targetSystemValue},
          )['label'] ??
          targetSystemValue;
    }

    // Default suggestion for session ID
    final defaultSuggestion =
        'session_${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}';

    // Capture providers before async gap
    final guardian = context.read<GuardianProvider>();
    final review = context.read<ReviewProvider>();

    // Show deploy dialog with pre-filled fields + manual session ID entry
    final sessionId = await showDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => _DeployDialog(
        employeeId: employeeId,
        matrixId: matrixId,
        targetSystem: targetSystemLabel,
        defaultSessionId: defaultSuggestion,
      ),
    );

    if (sessionId == null || sessionId.isEmpty) return; // User cancelled

    try {
      final session = await guardian.deployGuardrail(
        employeeId: employeeId,
        sessionId: sessionId,
        matrixId: matrixId,
        targetSystem: targetSystemValue,
      );

      if (session.sessionId.isNotEmpty) {
        // Refresh sessions list
        await review.loadSessions();

        setState(() => _hasDeployed = true);

        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(
                'Compliance matrix deployed — Session ${session.sessionId}',
              ),
              backgroundColor: Colors.green,
            ),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Deploy failed: $e'),
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  // ── Vector card (full detail) ─────────────────────────────────────────────

  Widget _buildVectorCard(ThemeData theme, ThreatVector vector) {
    final severityColor = vector.severityLevel == 'critical'
        ? Colors.red
        : vector.severityLevel == 'elevated'
        ? Colors.orange
        : Colors.green;
    final vectorTypeIcon = vector.vectorType == 'code_injection'
        ? Icons.code
        : vector.vectorType == 'data_exfiltration'
        ? Icons.upload_file
        : vector.vectorType == 'unauthorized_access'
        ? Icons.vpn_key
        : vector.vectorType == 'policy_bypass'
        ? Icons.block
        : Icons.bug_report;
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      elevation: 0,
      color: theme.colorScheme.surfaceContainerLow,
      child: ExpansionTile(
        leading: Icon(vectorTypeIcon, color: severityColor, size: 20),
        title: Text(
          vector.title,
          style: theme.textTheme.bodyMedium?.copyWith(
            fontWeight: FontWeight.w600,
          ),
        ),
        subtitle: Row(
          children: [
            Text(
              vector.severityLevel.toUpperCase(),
              style: theme.textTheme.labelSmall?.copyWith(color: severityColor),
            ),
            const SizedBox(width: 8),
            Text(
              '| Window: ${vector.auditWindowSeconds}s',
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.outline,
              ),
            ),
          ],
        ),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Type & language badge
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    Chip(
                      avatar: const Icon(Icons.category, size: 14),
                      label: Text(
                        vector.vectorType,
                        style: theme.textTheme.labelSmall,
                      ),
                      visualDensity: VisualDensity.compact,
                      backgroundColor:
                          theme.colorScheme.surfaceContainerHighest,
                    ),
                    if (vector.language != null && vector.language!.isNotEmpty)
                      Chip(
                        avatar: const Icon(Icons.code, size: 14),
                        label: Text(
                          vector.language!,
                          style: theme.textTheme.labelSmall,
                        ),
                        visualDensity: VisualDensity.compact,
                        backgroundColor:
                            theme.colorScheme.surfaceContainerHighest,
                      ),
                  ],
                ),
                const SizedBox(height: 10),
                // Body
                Text(
                  vector.body,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                // Starter code
                if (vector.starterCode != null &&
                    vector.starterCode!.isNotEmpty) ...[
                  const SizedBox(height: 10),
                  Text(
                    'Starter Code',
                    style: theme.textTheme.labelSmall?.copyWith(
                      fontWeight: FontWeight.w600,
                      color: theme.colorScheme.primary,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: theme.colorScheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      vector.starterCode!,
                      style: theme.textTheme.bodySmall?.copyWith(
                        fontFamily: 'monospace',
                        fontSize: 11,
                        color: theme.colorScheme.onSurface,
                      ),
                    ),
                  ),
                ],
                // Audit metadata
                const SizedBox(height: 10),
                Row(
                  children: [
                    Icon(
                      Icons.timer,
                      size: 14,
                      color: theme.colorScheme.outline,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      'Audit window: ${vector.auditWindowSeconds}s',
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.outline,
                      ),
                    ),
                    const SizedBox(width: 16),
                    Icon(
                      Icons.speed,
                      size: 14,
                      color: theme.colorScheme.outline,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      'Max risk: ${vector.maxRiskScore}',
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.outline,
                      ),
                    ),
                  ],
                ),
                // Expected answer
                if (vector.expectedAnswer != null &&
                    vector.expectedAnswer!.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Text(
                    'Expected: ${vector.expectedAnswer}',
                    style: theme.textTheme.labelSmall?.copyWith(
                      fontStyle: FontStyle.italic,
                      color: theme.colorScheme.primary,
                    ),
                  ),
                ],
                // Penetration scenarios
                if (vector.scenarios.isNotEmpty) ...[
                  const SizedBox(height: 10),
                  Text(
                    'Penetration Scenarios (${vector.scenarios.length})',
                    style: theme.textTheme.labelSmall?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 4),
                  ...vector.scenarios.map(
                    (scenario) => Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: theme.colorScheme.surfaceContainerHighest
                              .withValues(alpha: 0.5),
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(
                            color: scenario.isExample
                                ? Colors.blue.withValues(alpha: 0.3)
                                : Colors.grey.withValues(alpha: 0.2),
                          ),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            if (scenario.isExample)
                              Row(
                                children: [
                                  Icon(
                                    Icons.lightbulb_outline,
                                    size: 14,
                                    color: Colors.blue,
                                  ),
                                  const SizedBox(width: 4),
                                  Text(
                                    'Example',
                                    style: theme.textTheme.labelSmall?.copyWith(
                                      color: Colors.blue,
                                    ),
                                  ),
                                ],
                              ),
                            if (scenario.input.isNotEmpty) ...[
                              const SizedBox(height: 4),
                              Text(
                                'Input: ${scenario.input}',
                                style: theme.textTheme.labelSmall?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                            ],
                            if (scenario.expectedOutput.isNotEmpty) ...[
                              const SizedBox(height: 2),
                              Text(
                                'Expected: ${scenario.expectedOutput}',
                                style: theme.textTheme.labelSmall?.copyWith(
                                  color: Colors.green,
                                ),
                              ),
                            ],
                            if (scenario.explanation.isNotEmpty) ...[
                              const SizedBox(height: 2),
                              Text(
                                scenario.explanation,
                                style: theme.textTheme.labelSmall?.copyWith(
                                  fontStyle: FontStyle.italic,
                                  color: theme.colorScheme.outline,
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
                // Mitigation options
                if (vector.options.isNotEmpty) ...[
                  const SizedBox(height: 10),
                  Text(
                    'Mitigation Options (${vector.options.length})',
                    style: theme.textTheme.labelSmall?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 4),
                  ...vector.options.map(
                    (option) => Container(
                      margin: const EdgeInsets.only(bottom: 4),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 6,
                      ),
                      decoration: BoxDecoration(
                        color: option.isCorrectMitigation
                            ? Colors.green.withValues(alpha: 0.1)
                            : theme.colorScheme.surfaceContainerHighest,
                        borderRadius: BorderRadius.circular(6),
                        border: option.isCorrectMitigation
                            ? Border.all(
                                color: Colors.green.withValues(alpha: 0.4),
                              )
                            : null,
                      ),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(
                            option.isCorrectMitigation
                                ? Icons.check_circle
                                : Icons.radio_button_unchecked,
                            size: 14,
                            color: option.isCorrectMitigation
                                ? Colors.green
                                : theme.colorScheme.outline,
                          ),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  option.text,
                                  style: theme.textTheme.labelSmall?.copyWith(
                                    fontWeight: option.isCorrectMitigation
                                        ? FontWeight.w600
                                        : FontWeight.normal,
                                    color: option.isCorrectMitigation
                                        ? Colors.green.shade700
                                        : theme.colorScheme.onSurfaceVariant,
                                  ),
                                ),
                                if (option.rationale != null &&
                                    option.rationale!.isNotEmpty)
                                  Text(
                                    option.rationale!,
                                    style: theme.textTheme.labelSmall?.copyWith(
                                      fontStyle: FontStyle.italic,
                                      fontSize: 10,
                                      color: theme.colorScheme.outline,
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Sheet Helpers
  // ═════════════════════════════════════════════════════════════════════════════

  Widget _metadataRow(ThemeData theme, String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 80,
            child: Text(
              label,
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.outline,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _formatTimestamp(String timestamp) {
    try {
      final dt = DateTime.parse(timestamp);
      final h = dt.hour.toString().padLeft(2, '0');
      final m = dt.minute.toString().padLeft(2, '0');
      final M = dt.month.toString().padLeft(2, '0');
      final d = dt.day.toString().padLeft(2, '0');
      return '$d/$M/${dt.year} $h:$m';
    } catch (_) {
      return timestamp;
    }
  }

  Color _criticalityColor(String tier, ThemeData theme) {
    switch (tier.toLowerCase()) {
      case 'critical':
        return Colors.red;
      case 'elevated':
        return Colors.orange;
      case 'routine':
        return Colors.green;
      default:
        return theme.colorScheme.primary;
    }
  }

  Widget _buildSheetLabel(
    ThemeData theme,
    String label,
    IconData icon, {
    bool isRequired = false,
  }) {
    return Row(
      children: [
        Icon(icon, size: 17, color: theme.colorScheme.primary),
        const SizedBox(width: 8),
        Text(
          label,
          style: theme.textTheme.labelMedium?.copyWith(
            color: theme.colorScheme.primary,
            fontWeight: FontWeight.w600,
          ),
        ),
        if (isRequired)
          Padding(
            padding: const EdgeInsets.only(left: 2),
            child: Text(
              ' *',
              style: theme.textTheme.labelMedium?.copyWith(
                color: theme.colorScheme.error,
                fontWeight: FontWeight.w700,
                fontSize: 14,
              ),
            ),
          ),
      ],
    );
  }

  List<Widget> _buildSuggestionChips(
    ThemeData theme,
    StateSetter setSheetState,
  ) {
    final suggestions = _targetSystemSuggestions[_selectedTargetSystem];
    if (suggestions == null || suggestions.isEmpty) return [];

    return [
      Center(
        child: Wrap(
          spacing: 8,
          runSpacing: 8,
          children: suggestions.map((suggestion) {
            return ActionChip(
              avatar: const Icon(Icons.lightbulb_outline, size: 14),
              label: Text(
                suggestion,
                style: TextStyle(
                  fontSize: 12,
                  color: theme.colorScheme.onPrimaryContainer,
                ),
              ),
              backgroundColor: theme.colorScheme.primaryContainer,
              side: BorderSide(
                color: theme.colorScheme.primary.withValues(alpha: 0.3),
              ),
              onPressed: () {
                _promptController.text = suggestion;
                if (_promptError != null) {
                  _promptError = null;
                }
                setSheetState(() {});
              },
            );
          }).toList(),
        ),
      ),
    ];
  }

  Widget _buildSheetRiskSlider(
    ThemeData theme,
    String label,
    double value,
    Color color,
    ValueChanged<double> onChanged,
  ) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        children: [
          SizedBox(
            width: 72,
            child: Row(
              children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: color,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  label,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: SliderTheme(
              data: SliderTheme.of(context).copyWith(
                activeTrackColor: color,
                thumbColor: color,
                inactiveTrackColor: color.withValues(alpha: 0.15),
              ),
              child: Slider(
                value: value,
                min: 0,
                max: 1,
                divisions: 10,
                onChanged: (v) {
                  final clamped = v.clamp(_riskFloor, 1.0 - _riskFloor * 2);
                  onChanged(clamped);
                },
              ),
            ),
          ),
          SizedBox(
            width: 36,
            child: Text(
              '${(value * 100).round()}%',
              style: theme.textTheme.labelSmall?.copyWith(
                fontFamily: 'monospace',
              ),
            ),
          ),
        ],
      ),
    );
  }
}

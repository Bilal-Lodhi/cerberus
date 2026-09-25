import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/reference_document.dart';
import '../providers/reference_corpus_provider.dart';

/// ─── CERBERUS — Reference Corpus Panel ────────────────────────────────────
/// The operator's surface for the local reference corpus that paste content is
/// compared against during risk analysis.
///
/// The panel states two things rather than leaving them to be inferred:
///
///   * **Cerberus never populates this corpus itself.** There is no crawler, no
///     bundled corpus and no external reference service, so every row here was
///     added by an operator. The empty state says so, because an operator who
///     assumes the corpus is already populated would read an empty match set as
///     "nothing leaked".
///   * **A match is evidence about phrasing, not about copying.** The panel
///     describes what the corpus is for; it does not present a match as a
///     finding.
///
/// The add form validates against the API's own limits before sending, so a
/// typo costs a field-level message instead of a 400.
class ReferenceCorpusPanel extends StatefulWidget {
  const ReferenceCorpusPanel({super.key});

  @override
  State<ReferenceCorpusPanel> createState() => _ReferenceCorpusPanelState();
}

class _ReferenceCorpusPanelState extends State<ReferenceCorpusPanel> {
  final _formKey = GlobalKey<FormState>();
  final _labelController = TextEditingController();
  final _contentController = TextEditingController();
  final _tagsController = TextEditingController();

  @override
  void initState() {
    super.initState();
    // Deferred to the first frame: load() notifies its listeners synchronously,
    // and this panel is built as part of the dashboard's own first build.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      context.read<ReferenceCorpusProvider>().load();
    });
  }

  @override
  void dispose() {
    _labelController.dispose();
    _contentController.dispose();
    _tagsController.dispose();
    super.dispose();
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Actions
  // ═════════════════════════════════════════════════════════════════════════════

  Future<void> _submit(ReferenceCorpusProvider corpus) async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    FocusScope.of(context).unfocus();

    final added = await corpus.add(
      label: _labelController.text,
      content: _contentController.text,
      tags: parseReferenceTags(_tagsController.text),
    );

    if (!mounted) return;
    if (added) {
      // Cleared only on success: on failure the text stays put so the operator
      // can correct the field the message points at.
      _labelController.clear();
      _contentController.clear();
      _tagsController.clear();
      _formKey.currentState?.reset();
    }
    _showSnackBar(
      added
          ? 'Reference document added to the corpus'
          : corpus.error ?? 'Could not add the reference document',
      isError: !added,
    );
  }

  Future<void> _confirmRemove(
    ReferenceCorpusProvider corpus,
    ReferenceDocument document,
  ) async {
    final theme = Theme.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove Reference Document'),
        content: Text(
          'Remove "${document.label}" from the corpus?\n\n'
          'Paste content is no longer compared against this text, and the '
          'content is not recoverable from the console.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(
              backgroundColor: theme.colorScheme.error,
            ),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    final removed = await corpus.remove(document.referenceId);
    if (!mounted) return;
    _showSnackBar(
      removed
          ? 'Reference document removed'
          : corpus.error ?? 'Could not remove the reference document',
      isError: !removed,
    );
  }

  void _showSnackBar(String message, {required bool isError}) {
    final theme = Theme.of(context);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: isError ? theme.colorScheme.error : null,
      ),
    );
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Build
  // ═════════════════════════════════════════════════════════════════════════════

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final corpus = context.watch<ReferenceCorpusProvider>();

    return Container(
      color: theme.colorScheme.surface,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _buildHeader(theme, corpus),
          if (corpus.isLoading && corpus.documents.isNotEmpty)
            const LinearProgressIndicator(minHeight: 2),
          if (corpus.error != null) _buildErrorBanner(theme, corpus),
          Expanded(child: _buildBody(theme, corpus)),
        ],
      ),
    );
  }

  Widget _buildHeader(ThemeData theme, ReferenceCorpusProvider corpus) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 12, 4, 8),
      child: Row(
        children: [
          Icon(
            Icons.library_books_outlined,
            size: 18,
            color: theme.colorScheme.primary,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'REFERENCE CORPUS',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.outline,
                    letterSpacing: 0.8,
                  ),
                ),
                Text(
                  '${corpus.documents.length} of $maxReferenceDocuments '
                  'document(s) compared',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.outline,
                  ),
                ),
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.refresh, size: 20),
            tooltip: 'Re-read the corpus',
            color: theme.colorScheme.outline,
            visualDensity: VisualDensity.compact,
            onPressed: corpus.isLoading ? null : () => corpus.load(),
          ),
        ],
      ),
    );
  }

  Widget _buildErrorBanner(ThemeData theme, ReferenceCorpusProvider corpus) {
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: theme.colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(
            Icons.error_outline,
            size: 18,
            color: theme.colorScheme.onErrorContainer,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              corpus.error ?? '',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onErrorContainer,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildBody(ThemeData theme, ReferenceCorpusProvider corpus) {
    if (corpus.isLoading && corpus.documents.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    return ListView(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 24),
      children: [
        _buildAddForm(theme, corpus),
        const SizedBox(height: 16),
        if (corpus.documents.isEmpty)
          _buildEmptyState(theme)
        else
          ...corpus.documents.map(
            (document) => _buildDocumentCard(theme, corpus, document),
          ),
      ],
    );
  }

  // ── Add form ────────────────────────────────────────────────────────────────

  Widget _buildAddForm(ThemeData theme, ReferenceCorpusProvider corpus) {
    return Card(
      elevation: 0,
      color: theme.colorScheme.surfaceContainerLow,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: theme.dividerColor),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Icon(
                    Icons.add_circle_outline,
                    size: 18,
                    color: theme.colorScheme.primary,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Add a reference document',
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                'The text added here is what paste content is compared '
                'against. Cerberus never adds to this corpus on its own.',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.outline,
                ),
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _labelController,
                enabled: !corpus.isLoading,
                textInputAction: TextInputAction.next,
                decoration: const InputDecoration(
                  labelText: 'Label',
                  hintText: 'e.g. internal-ledger-snippet',
                  helperText: 'At most $maxReferenceLabelChars characters',
                  helperMaxLines: 2,
                  prefixIcon: Icon(Icons.label_outline),
                  border: OutlineInputBorder(),
                ),
                validator: (value) => validateReferenceLabel(value ?? ''),
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _contentController,
                enabled: !corpus.isLoading,
                minLines: 4,
                maxLines: 8,
                keyboardType: TextInputType.multiline,
                decoration: const InputDecoration(
                  labelText: 'Content',
                  alignLabelWithHint: true,
                  helperText: 'At most $maxReferenceContentChars characters',
                  helperMaxLines: 2,
                  border: OutlineInputBorder(),
                ),
                validator: (value) => validateReferenceContent(value ?? ''),
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _tagsController,
                enabled: !corpus.isLoading,
                textInputAction: TextInputAction.done,
                decoration: const InputDecoration(
                  labelText: 'Tags (comma separated)',
                  hintText: 'e.g. ledger, swift, internal',
                  helperText:
                      'At most $maxReferenceTags tags, '
                      '$maxReferenceTagChars characters each',
                  helperMaxLines: 2,
                  prefixIcon: Icon(Icons.sell_outlined),
                  border: OutlineInputBorder(),
                ),
                validator: (value) =>
                    validateReferenceTags(parseReferenceTags(value ?? '')),
              ),
              if (corpus.isAtCapacity) ...[
                const SizedBox(height: 12),
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    'The corpus has reached the API read ceiling of '
                    '$maxReferenceDocuments documents. Only the '
                    '$maxReferenceDocuments most recently updated documents '
                    'are listed and compared, so a new one would be stored but '
                    'never read. Remove a document first.',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
              ],
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: (corpus.isLoading || corpus.isAtCapacity)
                    ? null
                    : () => _submit(corpus),
                icon: const Icon(Icons.add, size: 18),
                label: const Text('Add to corpus'),
                style: FilledButton.styleFrom(
                  minimumSize: const Size(0, 44),
                  backgroundColor: theme.colorScheme.primary,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // ── Document list ───────────────────────────────────────────────────────────

  Widget _buildDocumentCard(
    ThemeData theme,
    ReferenceCorpusProvider corpus,
    ReferenceDocument document,
  ) {
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      elevation: 0,
      color: theme.colorScheme.surfaceContainerLow,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 4, 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    document.label,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${document.charCount} characters · '
                    'added ${_formatTimestamp(document.createdAt)}',
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.outline,
                    ),
                  ),
                  if (document.tags.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: document.tags
                          .map((tag) => _buildTagPill(theme, tag))
                          .toList(),
                    ),
                  ],
                  if (document.preview.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(
                      document.preview,
                      style: theme.textTheme.bodySmall?.copyWith(
                        fontFamily: 'monospace',
                        fontSize: 11,
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ],
              ),
            ),
            IconButton(
              icon: Icon(
                Icons.delete_outline,
                size: 18,
                color: theme.colorScheme.error.withValues(alpha: 0.7),
              ),
              tooltip: 'Remove from corpus',
              visualDensity: VisualDensity.compact,
              onPressed: corpus.isLoading
                  ? null
                  : () => _confirmRemove(corpus, document),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildTagPill(ThemeData theme, String tag) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: theme.colorScheme.primary.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: theme.colorScheme.primary.withValues(alpha: 0.25),
        ),
      ),
      child: Text(
        tag,
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.primary,
          fontSize: 10,
        ),
      ),
    );
  }

  // ── Empty state ─────────────────────────────────────────────────────────────

  Widget _buildEmptyState(ThemeData theme) {
    return Card(
      elevation: 0,
      color: theme.colorScheme.surfaceContainerLow,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: theme.dividerColor),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            Icon(
              Icons.library_books_outlined,
              size: 40,
              color: theme.colorScheme.outline,
            ),
            const SizedBox(height: 12),
            Text(
              'The corpus is empty',
              style: theme.textTheme.titleSmall?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              'Risk analysis compares paste content against this corpus with a '
              'local text-similarity algorithm; the pairs at or above the '
              'configured threshold are reported as possible exfiltration.\n\n'
              'Cerberus never populates the corpus itself — there is no '
              'crawler, no bundled corpus and no external reference service. '
              'Every document comes from an operator, so nothing is compared '
              'until you add text here.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.outline,
                height: 1.4,
              ),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /// Formats a server timestamp for display, degrading to the raw value rather
  /// than throwing when it is not parseable.
  String _formatTimestamp(String? timestamp) {
    if (timestamp == null || timestamp.isEmpty) return 'unknown';
    final parsed = DateTime.tryParse(timestamp);
    if (parsed == null) return timestamp;
    final local = parsed.toLocal();
    String two(int value) => value.toString().padLeft(2, '0');
    return '${local.year}-${two(local.month)}-${two(local.day)} '
        '${two(local.hour)}:${two(local.minute)}';
  }
}

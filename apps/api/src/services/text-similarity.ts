/**
 * Deterministic local text similarity for the exfiltration report.
 *
 * ── Why this is local ─────────────────────────────────────────────────
 *
 * The similarity comparison is computed here, in-process, from a transparent
 * algorithm — not asked of the model. Two reasons:
 *
 *   - `DATA_LEAKAGE_SIMILARITY_THRESHOLD` has to gate something. If the model
 *     produced the similarity numbers, the threshold would be decorative,
 *     because the model never sees it.
 *   - A similarity claim is evidence. A deterministic function can be explained,
 *     re-run and tested at its boundary; a model's opinion cannot.
 *
 * ── The algorithm ─────────────────────────────────────────────────────
 *
 * Normalise → tokenise → shingles → Jaccard. Every step is inspectable:
 *
 *   1. lower-case, strip punctuation, collapse whitespace
 *   2. split on whitespace into tokens
 *   3. build the set of overlapping `SHINGLE_SIZE`-token windows
 *   4. similarity = |intersection| / |union| of the two shingle sets
 *
 * Jaccard over shingles is sensitive to shared phrasing and insensitive to
 * document length, which is what "did this paste come from that reference"
 * needs. It is order-blind within a shingle and has no notion of meaning.
 *
 * ── What this is NOT ──────────────────────────────────────────────────
 *
 * This is **not plagiarism detection** and it does not establish that content
 * was copied. It reports that two pieces of text share a measurable amount of
 * phrasing. Short inputs produce unreliable numbers, which is why
 * `MIN_COMPARABLE_TOKENS` exists: below it, nothing is compared and no match is
 * reported, rather than reporting a confident-looking result computed from three
 * words.
 */

/** Number of tokens in each shingle window. */
export const SHINGLE_SIZE = 3;

/**
 * Minimum token count for a comparison to be meaningful.
 *
 * A three-token document and a three-token paste are identical by construction,
 * which would report a 1.0 match for two unrelated short strings. Below this
 * floor the comparison is skipped entirely.
 */
export const MIN_COMPARABLE_TOKENS = 10;

/** Splits normalised text into tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    // Anything that is not a letter, digit or whitespace becomes a separator.
    // Unicode-aware so non-Latin scripts are not silently erased.
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** Normalised text, for comparison and for display. */
export function normalizeText(text: string): string {
  return tokenize(text).join(" ");
}

/** The set of overlapping `SHINGLE_SIZE`-token windows in a token list. */
export function shingles(tokens: string[], size: number = SHINGLE_SIZE): Set<string> {
  const result = new Set<string>();
  if (tokens.length < size) return result;

  for (let i = 0; i + size <= tokens.length; i++) {
    result.add(tokens.slice(i, i + size).join(" "));
  }
  return result;
}

/** Jaccard similarity of two sets: |intersection| / |union|. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const entry of small) {
    if (large.has(entry)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Similarity of two texts in `0..1`.
 *
 * Returns 0 when either side has too few tokens to compare, so a short paste
 * cannot produce a spuriously high score against a short reference.
 */
export function textSimilarity(a: string, b: string): number {
  const aTokens = tokenize(a);
  const bTokens = tokenize(b);

  if (
    aTokens.length < MIN_COMPARABLE_TOKENS ||
    bTokens.length < MIN_COMPARABLE_TOKENS
  ) {
    return 0;
  }

  return jaccard(shingles(aTokens), shingles(bTokens));
}

/** One reference document as the comparison consumes it. */
export interface ReferenceDocument {
  referenceId: string;
  label: string;
  content: string;
}

/** One matched pair, as `ExfiltrationMatch` renders it. */
export interface SimilarityMatch {
  referenceId: string;
  sourceLabel: string;
  similarityScore: number;
  /** The reference text, truncated for the payload. */
  sourceSnippet: string;
  /** The paste text, truncated for the payload. */
  employeeSnippet: string;
}

/**
 * Highest similarity each paste achieves against the corpus.
 *
 * Returns only pairs at or above `threshold`, so the threshold is the gate rather
 * than a decoration, and the list is sorted by score descending so the strongest
 * evidence comes first.
 *
 * `overallSimilarity` is the best score found, or 0 when nothing was compared.
 * It is reported even when it falls below the threshold, so a report can carry a
 * high similarity with no matches — which is what "0.7 against a 0.75 threshold"
 * means, and is more informative than reporting nothing at all. It is the maximum
 * rather than an average because one verbatim match is the finding; averaging it
 * against unrelated corpus entries would dilute exactly the signal being looked
 * for.
 */
export function findSimilarityMatches(
  pasteContents: string[],
  references: ReferenceDocument[],
  threshold: number,
): { overallSimilarity: number; matches: SimilarityMatch[] } {
  const empty = { overallSimilarity: 0, matches: [] as SimilarityMatch[] };
  if (pasteContents.length === 0 || references.length === 0) return empty;
  if (!Number.isFinite(threshold) || threshold <= 0) return empty;

  const matches: SimilarityMatch[] = [];
  let overallSimilarity = 0;

  for (const paste of pasteContents) {
    if (tokenize(paste).length < MIN_COMPARABLE_TOKENS) continue;

    for (const reference of references) {
      const score = textSimilarity(paste, reference.content);
      if (score > overallSimilarity) overallSimilarity = score;
      if (score < threshold) continue;

      matches.push({
        referenceId: reference.referenceId,
        sourceLabel: reference.label,
        similarityScore: score,
        sourceSnippet: truncate(reference.content),
        employeeSnippet: truncate(paste),
      });
    }
  }

  matches.sort((a, b) => b.similarityScore - a.similarityScore);
  return { overallSimilarity, matches };
}

/** Maximum characters of either side of a match kept in the payload. */
export const MAX_SNIPPET_CHARS = 2_000;

function truncate(text: string): string {
  return text.length > MAX_SNIPPET_CHARS ? text.slice(0, MAX_SNIPPET_CHARS) : text;
}

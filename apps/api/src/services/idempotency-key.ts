/**
 * The `Idempotency-Key` request header: reading it, validating it, and deriving the value
 * that is actually stored.
 *
 * ── What this is, and is not ──────────────────────────────────────────
 *
 * A key is a caller's promise that this request is *the same request* as an earlier one
 * whose response was lost. It is a duplicate-side-effect mitigation for a retry. It is
 * **not** authentication, it is **not** authorization, and it grants nothing: a caller who
 * sends a new key gets a new operation.
 *
 * ── Why the raw key is never stored or logged ─────────────────────────
 *
 * The stored value is `sha256(key)`. A claim record is a document an operator can dump and
 * a backup can carry off-host; a caller's key is not evidence, and a key that is never
 * written down cannot leak from either. The digest is what makes a record findable from the
 * key that produced it and is not reversible, so the property costs nothing.
 *
 * For logs, {@link keyIdFromHash} truncates the digest to eight hex characters. That is
 * enough to join two log lines to one operation and is a one-way derivation of a value the
 * caller chose, which is what makes it safe to emit where the key itself is not.
 *
 * ── Why the charset is narrow ─────────────────────────────────────────
 *
 * `\x21`–`\x7E` — printable ASCII with **no space**. Three reasons, in order of how much
 * they matter:
 *
 *   1. **No control characters.** A header value reaches a log line, a database field and
 *      potentially a terminal. A newline or a NUL in any of those is an injection.
 *   2. **No whitespace ambiguity.** Every HTTP stack trims or folds header whitespace
 *      differently, so `"a b"` and `"a  b"` would be indistinguishable after some
 *      intermediary and identical after another. Excluding space removes the question.
 *   3. **No non-ASCII.** A key is an opaque identifier, and every realistic generator
 *      (UUID, ULID, a hash, a counter) produces ASCII. Allowing multi-byte characters would
 *      mean two byte sequences that render identically can hash differently, which is a
 *      support burden for no benefit.
 *
 * ── A header sent twice ───────────────────────────────────────────────
 *
 * If a client sends `Idempotency-Key` more than once, the HTTP layer joins the values with
 * `", "` before this module sees them — a comma is inside the safe charset, so the result
 * is a *well-formed but different* key rather than a rejection. That is a deliberate choice
 * over rejecting: a joined value is a distinct key, which means a distinct operation, which
 * is the safe direction. It is documented here rather than silently tolerated because it is
 * the one way a caller can send a key and not get the key they think they sent.
 */

import { createHash } from "node:crypto";

/** The header name, in the spelling this repository documents. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/**
 * The maximum accepted key length, in characters.
 *
 * 255, which is what most proxies and databases already tolerate for an opaque identifier.
 * This is a storage bound on a caller-controlled string on a paid path, not a format rule:
 * any shorter key that passes the charset check is accepted.
 */
export const MAX_IDEMPOTENCY_KEY_CHARS = 255;

/**
 * The accepted character set: printable ASCII, one to {@link MAX_IDEMPOTENCY_KEY_CHARS}
 * characters, no space.
 *
 * Written as an explicit range rather than a negated list of the characters that are
 * banned. A ban-list is a list of everything someone thought of; a range is a statement
 * about everything that is allowed.
 */
const SAFE_IDEMPOTENCY_KEY = /^[\x21-\x7E]{1,255}$/;

/**
 * What reading the header produced.
 *
 * Three outcomes, kept distinct because the caller must treat them differently:
 *
 *   - `absent` — no header. Today's behaviour, unchanged: no claim, no record.
 *   - `accepted` — a usable key, with the digest already derived.
 *   - `rejected` — a header was present and unusable. This is a `400`, and **no claim is
 *     made**, because a rejected key must not consume an operation.
 */
export type IdempotencyKeyOutcome =
  | { status: "absent" }
  | { status: "accepted"; key: string; keyHash: string; keyId: string }
  | { status: "rejected"; reason: string };

/** `sha256` of a key, hex encoded. The only form of the key that is ever stored. */
export function hashIdempotencyKey(key: string): string {
  return createHash("sha256").update(key, "utf-8").digest("hex");
}

/**
 * The short, safe identifier a log line carries.
 *
 * Eight hex characters of the digest: enough to join two lines to one operation, and a
 * one-way derivation of a value the caller chose, so emitting it is not emitting the key.
 */
export function keyIdFromHash(keyHash: string): string {
  return keyHash.slice(0, 8);
}

/**
 * Validates one header value.
 *
 * Returns a discriminated result rather than throwing, because the route's job is to turn
 * a rejection into a specific `400` with a stable code and a message that says what was
 * wrong — and an exception would have to be re-classified at the boundary anyway.
 *
 * `rawHeader` is `undefined` when the header was absent. An **empty** header is *not*
 * treated as absent: a caller that sent `Idempotency-Key: ` has made a mistake, and
 * silently falling back to non-idempotent behaviour would answer a request the caller
 * believed was protected with one that is not.
 */
export function readIdempotencyKey(rawHeader: string | undefined): IdempotencyKeyOutcome {
  if (rawHeader === undefined || rawHeader === null) return { status: "absent" };

  if (rawHeader.length === 0) {
    return {
      status: "rejected",
      reason:
        `The ${IDEMPOTENCY_KEY_HEADER} header was sent but is empty. Send a key of 1 to ` +
        `${MAX_IDEMPOTENCY_KEY_CHARS} printable ASCII characters, or omit the header to ` +
        `make a non-idempotent request.`,
    };
  }

  if (rawHeader.length > MAX_IDEMPOTENCY_KEY_CHARS) {
    return {
      status: "rejected",
      reason:
        `The ${IDEMPOTENCY_KEY_HEADER} header must be at most ` +
        `${MAX_IDEMPOTENCY_KEY_CHARS} characters (got ${rawHeader.length}).`,
    };
  }

  if (!SAFE_IDEMPOTENCY_KEY.test(rawHeader)) {
    return {
      status: "rejected",
      reason:
        `The ${IDEMPOTENCY_KEY_HEADER} header may contain only printable ASCII characters ` +
        `with no spaces (U+0021 to U+007E).`,
    };
  }

  const keyHash = hashIdempotencyKey(rawHeader);
  return {
    status: "accepted",
    key: rawHeader,
    keyHash,
    keyId: keyIdFromHash(keyHash),
  };
}

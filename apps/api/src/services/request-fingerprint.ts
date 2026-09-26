/**
 * The canonical request fingerprint: a deterministic digest of the fields that decide what
 * a paid operation actually does.
 *
 * ── What it is for ────────────────────────────────────────────────────
 *
 * A key is a promise about one request. The fingerprint is how the server checks that
 * promise: the same key with a *different* request is refused with a conflict rather than
 * silently answered from the first request's record, which would be a lie about which
 * request ran.
 *
 * ── The rules, and why each one is a rule ─────────────────────────────
 *
 * **Only semantically relevant fields.** The fingerprint covers the values that are sent to
 * the provider and nothing else. Headers, `X-Request-Id`, `X-Generation-Request-Id`, the
 * `Idempotency-Key` itself and the arrival time are all excluded, because two requests that
 * differ only in those produce the *same* provider input and therefore *are* the same
 * request.
 *
 * **The values the operation actually uses.** Not the raw body: the route's own
 * normalisation is applied first, so the fingerprint describes the provider input. A prompt
 * sent as `"  x  "` and as `"x"` is one request, because the route trims before sending
 * either. A `severityMix` that sums to four and the same weights normalised to sum to one
 * are one request, because the route normalises before sending either.
 *
 * **Stable key ordering, by UTF-16 code unit.** Not `localeCompare`, which is
 * locale-sensitive: a process running under a different locale would order the same object
 * differently, produce a different digest, and report a legitimate retry as a conflict.
 * That failure would appear on one replica and not another, which is the worst way for it
 * to appear.
 *
 * **Arrays are order-sensitive.** The canonical form preserves array order, because the
 * order of a semantically unordered list is not knowable from the value. Neither paid
 * payload currently carries one; a future one would have to be sorted explicitly and
 * deliberately, and this is the note that says so.
 *
 * **No Unicode normalisation.** NFC and NFD spellings of the same text produce *different*
 * fingerprints, because they are different byte sequences and therefore different provider
 * inputs. Normalising would make two genuinely different requests collide, which is the one
 * error a fingerprint exists to prevent.
 *
 * **Versioned.** {@link FINGERPRINT_VERSION} is hashed into the input and stored beside the
 * digest. A future change to the canonical form is then a new version rather than a silent
 * reinterpretation of records that were written under the old one.
 *
 * ── What it is not ────────────────────────────────────────────────────
 *
 * Not authentication. Not a secret. Not a signature: anyone who can construct the request
 * can compute the digest, and that is fine — its job is to detect an *accidental* mismatch
 * between two requests a caller believes are the same, not to resist a deliberate one.
 */

import { createHash } from "node:crypto";

import type { SeverityMix } from "../types.js";

/**
 * The version of the canonical form.
 *
 * Bumped when the serialisation changes in a way that would alter a digest for the same
 * logical input. It is hashed into the input as well as stored on the record, so a `v1` and
 * a `v2` digest of the same body cannot be equal by construction.
 */
export const FINGERPRINT_VERSION = 1;

/** A value the canonicaliser understands. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/**
 * Orders two keys by UTF-16 code unit.
 *
 * Deliberately not `String.prototype.localeCompare`: that is locale- and
 * implementation-dependent, so the same object could order differently on two machines and
 * the same request would then fingerprint differently on two replicas.
 */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The canonical serialisation of `value`.
 *
 * A JSON-like form with object keys sorted and `undefined` omitted. Strings are escaped
 * with `JSON.stringify`, so a value containing a quote, a backslash or a control character
 * cannot make two different inputs produce one serialisation.
 *
 * `undefined` is dropped rather than serialised, so an absent optional field and a field
 * explicitly set to `undefined` are the same request — which they are, because neither
 * reaches the provider.
 */
export function canonicalize(value: CanonicalValue): string {
  if (value === null) return "null";
  if (value === undefined) return "null";

  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";

  if (typeof value === "number") {
    // A non-finite number cannot survive a JSON round trip and is not a value any route
    // passes to a provider. Throwing is better than silently serialising `null`, which
    // would make every unusable number fingerprint identically.
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot fingerprint a non-finite number: ${String(value)}`);
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    // Order preserved: the canonical form does not claim to know which arrays are sets.
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }

  const record = value as { [key: string]: CanonicalValue };
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(byCodeUnit);

  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

/**
 * The digest of a canonical form.
 *
 * `sha256` over the UTF-8 bytes, from `node:crypto`. Exported so a caller can fingerprint
 * an arbitrary canonical form — the route-specific builders below are the ones the paid
 * routes use.
 */
export function fingerprintCanonical(canonical: string): string {
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

/**
 * The fields of a `POST /api/v1/scenarios` request that decide what the provider is asked.
 *
 * Every value is the one the route actually sends:
 *
 *   - `prompt` — **trimmed**, because the route trims before the classifier and the
 *     authoring call.
 *   - `roleContext` — as sent, because the route passes it through untrimmed.
 *   - `vectorCount` — **after defaulting**, because the route substitutes 5 when the field
 *     is absent, so an absent field and an explicit 5 are one request.
 *   - `severityMix` — **after normalisation**, because the route normalises to sum 1
 *     before building the prompt. Two spellings of the same distribution are one request.
 */
export interface ScenarioFingerprintInput {
  prompt: string;
  roleContext: string;
  vectorCount: number;
  severityMix: SeverityMix;
}

/** The fingerprint of one `POST /api/v1/scenarios` request. */
export function fingerprintScenariosRequest(input: ScenarioFingerprintInput): string {
  return fingerprintCanonical(
    canonicalize({
      v: FINGERPRINT_VERSION,
      prompt: input.prompt,
      roleContext: input.roleContext,
      vectorCount: input.vectorCount,
      severityMix: {
        low: input.severityMix.low,
        medium: input.severityMix.medium,
        high: input.severityMix.high,
        critical: input.severityMix.critical,
      },
    }),
  );
}

/**
 * The fingerprint of one `POST /api/v1/auditor/query` request.
 *
 * The route passes `question` through untrimmed to both paid calls, so the untrimmed value
 * is what the fingerprint covers. Two questions that differ only in surrounding whitespace
 * are therefore **two** requests — which is correct, because they are two different
 * provider inputs.
 */
export function fingerprintAuditorRequest(input: { question: string }): string {
  return fingerprintCanonical(
    canonicalize({
      v: FINGERPRINT_VERSION,
      question: input.question,
    }),
  );
}

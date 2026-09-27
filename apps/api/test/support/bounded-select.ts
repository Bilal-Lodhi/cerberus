/**
 * Test support for the live-list equivalence proof: a document generator, the migration applied
 * in memory, and a faithful mirror of the bounded query.
 *
 * ── Why a *mirror* of the query, and why it is not a copy of it ────────
 *
 * The property test in `live-list-equivalence-generated.test.ts` has to run the equivalence over
 * hundreds of generated fixtures, and putting each one into MongoDB first would make it a
 * database test rather than a property test. So the selection step is re-expressed in JavaScript
 * — and that re-expression is the risk, because a mirror that agrees with the *filter builder*
 * proves nothing about what MongoDB does with it.
 *
 * {@link selectBounded} is therefore written against **MongoDB's comparison semantics**, not
 * against `buildLiveListFilter`:
 *
 *   - `{ status: { $ne: "terminated" } }` matches a document whose `status` is absent, `null`, or
 *     any value other than that exact string — including one the vocabulary never held.
 *   - `{ field: { $gt: cutoff } }` compares within a **BSON type bracket**, so a string, a number,
 *     a boolean or an absent field is *not* matched by a comparison against a `Date`. This is the
 *     rule that makes the `updatedAt` branch blind to a document whose `updatedAt` is a string,
 *     and it is why the derived field exists.
 *   - `{ sessionId: { $in: [...] } }` matches by equality on the stored value.
 *
 * `apps/api/test/release/live-list-mirror-vs-query.test.ts` then asserts, against a real MongoDB,
 * that the mirror and the actual query return the same documents for the generated fixtures. That
 * is what grounds the property test: the mirror is a claim about the server, and the server is
 * asked.
 *
 * ── The generator ─────────────────────────────────────────────────────
 *
 * {@link generateFixtures} is deterministic and seeded, so a failure names a fixture that can be
 * regenerated rather than a run that has to be reproduced by luck. It varies the axes the model's
 * case tables name — status values, timestamp validity and type, age around the cutoff, session
 * count, page/local membership, TTL including "expiry disabled", and documents the migration has
 * and has not classified — and it deliberately includes values that no Cerberus code path can
 * produce, because those are the documents a hand-edited or partially-recovered database holds.
 */

import {
  buildSessionListUpdate,
  planSessionListNormalisation,
} from "../../../../packages/mcp-mongodb/src/session-list-normalisation.js";
import type { LocalLiveSession } from "../../src/services/session-reconciliation.js";

/** Applies migration `0005`'s plan to a document, in memory. */
export function applySessionListNormalisation(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const update = buildSessionListUpdate(planSessionListNormalisation(document));
  if (!update) return { ...document };
  return { ...document, ...(update["$set"] as Record<string, unknown>) };
}

/** True when `value` is a `Date` the query's range comparison would match. */
function isComparableInstant(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * The documents the bounded live-list query returns.
 *
 * A mirror of MongoDB's semantics, not of the filter builder — see this module's header. The
 * `sessionIds` branch is an equality test on the stored value, and the two range branches compare
 * within the `Date` bracket only.
 */
export function selectBounded(
  documents: readonly Record<string, unknown>[],
  input: { liveAfter: Date | null; sessionIds?: readonly string[] },
): Record<string, unknown>[] {
  const localIds = new Set(input.sessionIds ?? []);
  const cutoff = input.liveAfter;

  return documents.filter((document) => {
    const sessionId = document["sessionId"];
    if (typeof sessionId === "string" && localIds.has(sessionId)) return true;

    // `$ne: "terminated"`, including for a document with no status at all.
    if (document["status"] === "terminated") return false;

    if (cutoff === null) {
      // Expiry disabled: every non-terminated session is live.
      return true;
    }

    const derived = document["liveListUpdatedAt"];
    if (isComparableInstant(derived) && derived.getTime() > cutoff.getTime()) return true;

    const updatedAt = document["updatedAt"];
    if (isComparableInstant(updatedAt) && updatedAt.getTime() > cutoff.getTime()) return true;

    return false;
  });
}

/** A fixture the equivalence can be checked over. */
export interface GeneratedFixture {
  /** Stable, descriptive name, so a failure is reproducible without the seed. */
  name: string;
  /**
   * The documents as a **v0.6.1 database holds them** — `Date`s rather than ISO strings, and no
   * `liveListUpdatedAt`. This is the input the *previous build* is given.
   */
  documents: Record<string, unknown>[];
  /**
   * The same documents after migration `0005`.
   *
   * Kept separately rather than derived inside the test, so the two sides of the equivalence are
   * two different inputs by construction. Deriving the pre-migration documents from the migrated
   * ones is not possible — the migration is lossy in exactly the way that matters, because it
   * rewrites `"Terminated"` to `"active"` — and a test that accidentally compared a migrated
   * document with itself would pass for every shape.
   */
  migratedDocuments: Record<string, unknown>[];
  /** Sessions this process holds in memory. */
  localRows: LocalLiveSession[];
  ttlSeconds: number;
  nowMs: number;
  /** Documents the generator deliberately left for a straggler to have written. */
  unclassified: number;
}

/** The instant every generated fixture is built around. */
export const GENERATED_NOW_MS = Date.parse("2026-07-01T09:00:00.000Z");

/**
 * A small deterministic PRNG (mulberry32).
 *
 * Not `Math.random`: a failing property test has to be reproducible from its seed alone, and a
 * generator whose sequence changed between runs would make a failure a one-off.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Status values, including ones no version of the vocabulary ever held. */
const STATUS_VALUES: readonly unknown[] = [
  "active",
  "locked",
  "terminated",
  // A case variant: `normalizeStatus` is case-sensitive, so this is `active` and live.
  "Terminated",
  "cleared",
  "flagged",
  "investigating",
  "",
  " ",
  "unknown",
  42,
  true,
  null,
  undefined,
  { at: "whenever" },
  ["active"],
];

/**
 * `updatedAt` values.
 *
 * `undefined` and `null` mean the field is **absent** rather than stored as `null` — the two are
 * the same to the reconciler's `??` chain but not to the driver, which serialises `undefined` as
 * BSON `null`, and the fixture is meant to hold what a database holds.
 */
function updatedAtValues(hourMs: number): readonly unknown[] {
  return [
    new Date(GENERATED_NOW_MS - 60_000),
    new Date(GENERATED_NOW_MS - hourMs - 60_000),
    new Date(GENERATED_NOW_MS - hourMs),
    new Date(GENERATED_NOW_MS - hourMs + 1),
    new Date(GENERATED_NOW_MS - hourMs - 1),
    new Date(GENERATED_NOW_MS + hourMs),
    new Date(GENERATED_NOW_MS - 60_000).toISOString(),
    new Date(GENERATED_NOW_MS - hourMs - 60_000).toISOString(),
    "",
    "not-a-date",
    // `Date.parse("123")` is a finite legacy instant, and `Date.parse("1,2")` is another.
    123,
    [1, 2],
    ["nope"],
    1_700_000_000_000,
    true,
    false,
    {},
    null,
    undefined,
  ];
}

/** `deployedAt`/`createdAt` values, including ones that block the fallback chain. */
function fallbackValues(hourMs: number): readonly unknown[] {
  return [
    new Date(GENERATED_NOW_MS - 60_000),
    new Date(GENERATED_NOW_MS - hourMs - 60_000),
    "",
    "garbage",
    1_700_000_000_000,
    null,
    undefined,
  ];
}

/** Picks one entry, or a generated session id. */
function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

/**
 * Builds `count` fixtures from one seed.
 *
 * Each fixture is a whole database: a set of documents, the local rows this process holds, a TTL
 * and a request instant. The axes are varied independently so a combination that breaks is found
 * by the seed rather than by a hand-written case someone thought of.
 */
export function generateFixtures(options: {
  seed?: number;
  count?: number;
} = {}): GeneratedFixture[] {
  const random = mulberry32(options.seed ?? 0xc3b3e5);
  const count = options.count ?? 60;
  const fixtures: GeneratedFixture[] = [];

  const hourMs = 3600 * 1000;
  const updatedAtPool = updatedAtValues(hourMs);
  const fallbackPool = fallbackValues(hourMs);

  for (let index = 0; index < count; index += 1) {
    // ── Coverage is guaranteed, not left to chance ──
    //
    // The first fixture walks every status value and every `updatedAt` value in order, so the
    // model's case tables are exercised whatever the seed produces. Leaving that to a random draw
    // made the coverage assertion below fail on an unlucky seed, which is a test that reports on
    // the generator rather than on the product. The remaining fixtures are random, so the
    // *combinations* are still explored rather than enumerated.
    const systematic = index === 0;
    const ttlSeconds = systematic
      ? 3600
      : index === 1
        ? 0
        : index === 2
          ? Number.NaN
          : index === 3
            ? 1
            : pick(random, [3600, 3600, 3600, 1, 0, -1, Number.NaN]);

    const sessionCount = systematic
      ? Math.max(STATUS_VALUES.length, updatedAtPool.length)
      : 1 + Math.floor(random() * 12);

    const documents: Record<string, unknown>[] = [];
    const migratedDocuments: Record<string, unknown>[] = [];
    const ids: string[] = [];
    let unclassified = 0;

    for (let session = 0; session < sessionCount; session += 1) {
      const sessionId = `gen-${index}-${session}`;
      ids.push(sessionId);

      const status = systematic
        ? STATUS_VALUES[session % STATUS_VALUES.length]
        : pick(random, STATUS_VALUES);
      const updatedAt = systematic
        ? updatedAtPool[session % updatedAtPool.length]
        : pick(random, updatedAtPool);

      const document: Record<string, unknown> = {
        sessionId,
        employeeId: "gen-operator",
        auditId: "gen-audit",
        matrixId: "gen-matrix",
        targetSystem: "Generated Fixture",
        eventCount: session,
        pasteCount: 0,
        tabSwitchCount: 0,
        focusLossCount: 0,
        copyAttemptCount: 0,
        peakRiskScore: session * 3,
        deployedAt: systematic
          ? fallbackPool[session % fallbackPool.length]
          : pick(random, fallbackPool),
        createdAt: systematic
          ? fallbackPool[(session + 1) % fallbackPool.length]
          : pick(random, fallbackPool),
        updatedAt,
      };
      if (status !== undefined) document["status"] = status;
      if (updatedAt === undefined) delete document["updatedAt"];

      // `undefined` means "absent", not "stored as null", for the same reason as above.
      for (const field of ["deployedAt", "createdAt"]) {
        if (document[field] === undefined) delete document[field];
      }

      // ── Migrated, or deliberately left behind ──
      //
      // A quarter of the documents are left unclassified, standing in for a row written by an
      // older process after the migration ran. That shape is narrow on purpose: **a straggler
      // writes a durable status and a `Date` `updatedAt`**, because that is all any version of
      // the store has ever written. A document with an unusable `updatedAt` and no derived
      // instant is not a shape the product can produce, and the bounded query does not claim to
      // cover it — that is asserted, separately and explicitly, at the end of
      // `live-list-equivalence-generated.test.ts`.
      const straggler = !systematic && random() < 0.25;
      if (straggler) {
        unclassified += 1;
        document["status"] = pick(random, ["active", "locked", "terminated"]);
        document["updatedAt"] = pick(random, [
          new Date(GENERATED_NOW_MS - 60_000),
          new Date(GENERATED_NOW_MS - hourMs - 60_000),
        ]);
      }

      documents.push(document);
      // A straggler is identical in both: the migration has not classified it, which is what
      // makes it a straggler.
      migratedDocuments.push(
        straggler ? { ...document } : applySessionListNormalisation(document),
      );
    }

    // ── This process's own rows ──
    const localCount = Math.floor(random() * 4);
    const localRows: LocalLiveSession[] = [];
    for (let local = 0; local < localCount; local += 1) {
      const known = random() < 0.75;
      const sessionId = known ? pick(random, ids) : `gen-${index}-absent-${local}`;
      if (localRows.some((row) => row.sessionId === sessionId)) continue;

      localRows.push({
        sessionId,
        employeeId: "gen-operator",
        matrixId: "gen-matrix",
        targetSystem: "Generated Fixture",
        status: pick(random, ["active", "locked", "terminated"]),
        deployedAt: new Date(GENERATED_NOW_MS - 60_000).toISOString(),
        lastActivityAt: pick(random, [
          new Date(GENERATED_NOW_MS - 60_000).toISOString(),
          new Date(GENERATED_NOW_MS - hourMs - 60_000).toISOString(),
          new Date(GENERATED_NOW_MS - hourMs).toISOString(),
          undefined,
        ]),
        riskIndex: local,
        eventCount: local,
        pasteCount: 0,
        tabSwitchCount: 0,
        focusLossCount: 0,
        copyAttemptCount: 0,
        ephemeralStateAvailable: true,
      });
    }

    fixtures.push({
      name: `seed-${index}-ttl-${String(ttlSeconds)}-sessions-${sessionCount}`,
      documents,
      migratedDocuments,
      localRows,
      ttlSeconds,
      nowMs: GENERATED_NOW_MS,
      unclassified,
    });
  }

  return fixtures;
}

/**
 * The API's own copy of the paid-operation limits.
 *
 * ── Why this is a copy, and not an import ─────────────────────────────
 *
 * `apps/api` does not depend on `@cerberus/mcp-mongodb` at runtime. The two services are
 * independently deployable — the API reaches the persistence layer over HTTP, not through a
 * module — and the API's `package.json` deliberately lists no such dependency. That is the
 * same reason `apps/api/src/routes/reference.ts` declares its own
 * `MAX_REFERENCE_DOCUMENTS` rather than importing the adapter's.
 *
 * A copy can drift, and a drifted copy is a real defect: the API would validate a retention
 * window the store's TTL index does not agree with. So the agreement is **asserted**, in
 * `apps/api/test/mcp-tool-mapping.test.ts`, against the constants the MCP package exports —
 * the same way the corpus ceiling is asserted. A copy with a test is a contract; a copy
 * without one is a coincidence.
 *
 * This module is deliberately dependency-free, so importing it from `config.ts` cannot
 * create a cycle.
 */

/**
 * The default retention window for a claim record, in seconds. One day.
 *
 * Long enough that a caller retrying an hour later still gets the prior result, short enough
 * that the collection stays bounded. See
 * `docs/development/paid-operation-state-model.md` §3.12.
 */
export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 86_400;

/** The shortest retention an operator may configure. One minute. */
export const MIN_IDEMPOTENCY_TTL_SECONDS = 60;

/** The longest. Seven days. */
export const MAX_IDEMPOTENCY_TTL_SECONDS = 604_800;

/**
 * The largest response body a completed claim will store, in bytes.
 *
 * Defensive rather than reachable: the auditor caps its `raw` array at 200 records and its
 * summary at 1 200 output tokens, and a test serialises a maximal payload and asserts it
 * lands far below this. The branch that handles an over-large result is written to be
 * truthful if it ever fires — the record is marked completed with `resultOmitted` and a
 * replay answers `503` — but it should never be taken.
 */
export const MAX_STORED_RESULT_BYTES = 4 * 1024 * 1024;

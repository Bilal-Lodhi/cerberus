/**
 * The paid-operation idempotency guard.
 *
 * ── Why this exists when `npm test` already covers idempotency ────────
 *
 * `critical-indexes.test.ts` asserts the claim indexes against a **real MongoDB**, and it is
 * the stronger check. This one exists because of *where* that check runs: it needs a database,
 * so it runs in the harness's `test` and `test-integration` steps and nowhere else. A
 * contributor on a machine without MongoDB sees it skip, and the release harness reports a
 * skip as a skip — correctly, but the guarantee is then unverified at exactly the moment
 * someone is deciding whether to publish.
 *
 * So this is the cheap half: deterministic, no network, no database, no paid call. It asserts
 * the things that are checkable from the tree alone, and the things whose *absence* would
 * silently turn the mechanism off:
 *
 *   1. The critical-index list names the claim's unique index and its TTL index. A restore
 *      that lost the unique index accepts two claims for one key — a retry spends twice with
 *      nothing reporting it — and a restore that lost the TTL index leaves the collection
 *      unbounded. Both are checked after every restore, and neither is checked if the list
 *      stopped naming them.
 *   2. The shared index specification still matches what the list says, because the list and
 *      the specification are two descriptions of one guarantee.
 *   3. The three claim tools are declared **identically** in the MCP package and in the API's
 *      own copy. The API does not depend on the package at runtime, so the two are separate
 *      declarations, and a drift means the route calls a tool the adapter does not serve.
 *   4. The suites that prove the mechanism still exist and are still in the test glob. A test
 *      file that is never run is not a gate.
 *
 * Usage:
 *   node scripts/release/idempotency-guard.mjs
 *   node scripts/release/idempotency-guard.mjs --json
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

const checks = [];

function check(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

// ═══════════════════════════════════════════════════════════════════
// 1. The critical-index list names the claim's two indexes
// ═══════════════════════════════════════════════════════════════════

const critical = JSON.parse(read("scripts/release/critical-indexes.json"));
const uniqueIndexes = critical.indexes ?? [];
const ttlIndexes = critical.ttlIndexes ?? [];

const uniqueClaimIndex = uniqueIndexes.find(
  (entry) =>
    entry.collection === "operation_claims" &&
    entry.key?.routeFamily === 1 &&
    entry.key?.keyHash === 1,
);
check(
  "the critical-index list names the unique claim index",
  Boolean(uniqueClaimIndex),
  uniqueClaimIndex ? "" : "a restore that loses it accepts two claims for one key",
);
check(
  "the unique claim index entry states why it matters",
  typeof uniqueClaimIndex?.why === "string" && uniqueClaimIndex.why.length > 40,
  uniqueClaimIndex ? "" : "no entry to check",
);

const ttlClaimIndex = ttlIndexes.find(
  (entry) => entry.collection === "operation_claims" && entry.key?.expiresAt === 1,
);
check(
  "the critical-index list names the claim retention index",
  Boolean(ttlClaimIndex),
  ttlClaimIndex ? "" : "a restore that loses it leaves operation_claims unbounded",
);
check(
  "the claim retention index expires on the field's value",
  ttlClaimIndex?.expireAfterSeconds === 0,
  ttlClaimIndex
    ? `expireAfterSeconds=${String(ttlClaimIndex.expireAfterSeconds)}`
    : "no entry to check",
);

// ═══════════════════════════════════════════════════════════════════
// 2. The shared specification still matches the list
// ═══════════════════════════════════════════════════════════════════

const claimsSource = read("packages/mcp-mongodb/src/operation-claims.ts");

check(
  "the shared specification declares the unique claim index",
  /key:\s*\{\s*routeFamily:\s*1,\s*keyHash:\s*1\s*\}[\s\S]{0,80}?unique:\s*true/.test(
    claimsSource,
  ),
  "the specification and the critical-index list must describe one guarantee",
);
check(
  "the shared specification declares the retention index with a field deadline",
  /key:\s*\{\s*expiresAt:\s*1\s*\}[\s\S]{0,80}?expireAfterSeconds:\s*0/.test(claimsSource),
  "expireAfterSeconds must stay 0, so the window is data rather than index configuration",
);

// ═══════════════════════════════════════════════════════════════════
// 3. The two tool-name declarations agree
// ═══════════════════════════════════════════════════════════════════

const CLAIM_TOOLS = [
  "claim_paid_operation",
  "complete_paid_operation",
  "fail_paid_operation",
];

const mcpToolNames = read("packages/mcp-mongodb/src/tool-names.ts");
const apiToolNames = read("apps/api/src/services/mcp-tool-names.ts");

for (const tool of CLAIM_TOOLS) {
  const inMcp = mcpToolNames.includes(`"${tool}"`);
  const inApi = apiToolNames.includes(`"${tool}"`);
  check(
    `both declarations name ${tool}`,
    inMcp && inApi,
    inMcp && inApi ? "" : `mcp=${inMcp} api=${inApi}`,
  );
}

// ═══════════════════════════════════════════════════════════════════
// 4. The suites that prove the mechanism still exist
// ═══════════════════════════════════════════════════════════════════

const SUITES = [
  "apps/api/test/scenarios-idempotency.test.ts",
  "apps/api/test/auditor-idempotency.test.ts",
  "apps/api/test/paid-operation-recovery.test.ts",
  "apps/api/test/integration/multi-process-idempotency.test.ts",
  "apps/api/test/release/critical-indexes.test.ts",
  "apps/api/test/release/migration-from-previous-release.test.ts",
];

for (const suite of SUITES) {
  check(`the suite exists: ${suite}`, existsSync(join(root, suite)));
}

// The API test script is a glob list, not a recursive scan, so a new directory would be
// silently excluded. Assert the three directories these suites live in are all named.
const apiPackage = JSON.parse(read("apps/api/package.json"));
const testScript = String(apiPackage.scripts?.test ?? "");
const GLOBS = ["test/*.test.ts", "test/integration/*.test.ts", "test/release/*.test.ts"];
for (const glob of GLOBS) {
  check(
    `the api test script includes ${glob}`,
    testScript.includes(glob),
    testScript.includes(glob) ? "" : `test script is: ${testScript}`,
  );
}

// ═══════════════════════════════════════════════════════════════════
// Report
// ═══════════════════════════════════════════════════════════════════

const failed = checks.filter((entry) => !entry.passed).length;

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ checks, failed }, null, 2));
} else {
  console.log(
    `\n${checks.length - failed} passed, ${failed} failed.\n\n` +
      "  This guard is the database-free half of the idempotency gates. The stronger half\n" +
      "  asserts the indexes against a real MongoDB in critical-indexes.test.ts, and the\n" +
      "  mechanism itself in the four idempotency suites. The two release suites are named\n" +
      "  here because they are the upgrade and restore gates: a database upgraded by this\n" +
      "  build must carry both indexes, and a restore must preserve them.\n",
  );
  console.log(
    failed === 0
      ? "OK: the paid-operation idempotency guarantees are named where a restore checks them."
      : `FAILED: ${failed} problem(s).`,
  );
}

process.exit(failed === 0 ? 0 : 1);

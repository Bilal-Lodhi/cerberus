/**
 * Bounded live-list benchmark sanity.
 *
 *   npm run verify:live-list-bench
 *
 * Requires `CERBERUS_BENCH_MONGODB_URI` (or `CERBERUS_TEST_MONGODB_URI`), and **fails closed**
 * when neither is set: a figure produced against an in-process double is not a read-path figure,
 * and the whole reason `bench:read-path` exists beside `bench` is that the two were once confused.
 *
 * ── What it asserts, and what it refuses to ───────────────────────────
 *
 * The latency figures the benchmark prints are **not** asserted. They are from one machine, one
 * loopback `mongod` and one process, and a gate on a millisecond would fail on a loaded runner for
 * a reason that has nothing to do with the product — which is how a gate gets ignored.
 *
 * What is asserted is the property the change exists for, and it is deterministic: **the bounded
 * query's cost does not track the size of the collection.** The benchmark is run in its quick
 * shape, and for each scaling stage this checks that
 *
 *   - the previous build's query (`find({})`) really does collect-scan, so the instrument is
 *     demonstrably able to see one and the assertions below cannot pass vacuously;
 *   - the bounded query does not, and uses an index;
 *   - the documents it examined are bounded by the **live set**, not by the store;
 *   - the page it produced still contains every live row;
 *   - and the examined count does not grow when the collection does.
 *
 * That last one is the claim. "The list got faster" is not.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

const MONGODB_URI = (
  process.env["CERBERUS_BENCH_MONGODB_URI"] ??
  process.env["CERBERUS_TEST_MONGODB_URI"] ??
  ""
).trim();

if (!MONGODB_URI) {
  console.error("");
  console.error("  CERBERUS_BENCH_MONGODB_URI is not set, so there is no real MongoDB to measure.");
  console.error("");
  console.error("  This gate does NOT fall back to a stub. A bounded-list figure produced against");
  console.error("  an in-process double is not a read-path figure — that is the whole reason");
  console.error("  `bench:read-path` exists beside `bench`.");
  console.error("");
  process.exit(1);
}

const workDirectory = mkdtempSync(join(tmpdir(), "cerberus-live-list-bench-"));
const jsonPath = join(workDirectory, "read-path.json");

const failures = [];
const notes = [];

function check(description, ok, detail = "") {
  if (ok) {
    notes.push(`  ok   ${description}`);
  } else {
    failures.push(`  FAIL ${description}${detail ? ` — ${detail}` : ""}`);
  }
}

try {
  console.log("");
  console.log("BOUNDED LIVE-LIST BENCHMARK SANITY");
  console.log("  running the quick read-path benchmark against a real MongoDB\n");

  const run = spawnSync(
    "npm",
    ["run", "bench:read-path", "--", "--quick", "--json", jsonPath],
    {
      cwd: root,
      stdio: "inherit",
      // `shell` so the same invocation works on Windows, where npm is `npm.cmd`. No script
      // argument here needs quoting.
      shell: true,
      env: {
        ...process.env,
        CERBERUS_BENCH_MONGODB_URI: MONGODB_URI,
        // A smaller dataset than the benchmark's own default: this is a gate, not a baseline.
        // The shape of the result is what matters, and the scaling property is asserted by
        // comparing two stages rather than by reaching a particular size.
        CERBERUS_BENCH_SESSIONS: process.env["CERBERUS_BENCH_SESSIONS"] ?? "20",
        CERBERUS_BENCH_EVENTS: process.env["CERBERUS_BENCH_EVENTS"] ?? "20",
        CERBERUS_BENCH_SAMPLES: process.env["CERBERUS_BENCH_SAMPLES"] ?? "40",
      },
    },
  );

  if (run.status !== 0) {
    console.error(`\n  the benchmark exited ${run.status}, so there is nothing to check`);
    process.exit(1);
  }

  const results = JSON.parse(readFileSync(jsonPath, "utf8"));
  const scaling = Array.isArray(results.scaling) ? results.scaling : [];

  check(
    "the benchmark produced at least two scaling stages",
    scaling.length >= 2,
    `got ${scaling.length}`,
  );

  for (const row of scaling) {
    const label = `${row.storedSessions} stored`;
    const before = row.previousBuildQuery ?? {};
    const after = row.boundedQuery ?? {};

    // The negative control. Without it, a bug in the plan walker would make the "no COLLSCAN"
    // assertion below pass for a query that collect-scans.
    check(
      `${label}: the previous build's query collect-scans, so the instrument can see one`,
      Array.isArray(before.stages) && before.stages.includes("COLLSCAN"),
      `stages: ${(before.stages ?? []).join(", ") || "none"}`,
    );
    check(
      `${label}: the previous build examined every document`,
      before.docsExamined >= row.storedSessions,
      `examined ${before.docsExamined} of ${row.storedSessions}`,
    );

    check(
      `${label}: the bounded query does not collect-scan`,
      Array.isArray(after.stages) && !after.stages.includes("COLLSCAN"),
      `stages: ${(after.stages ?? []).join(", ") || "none"}`,
    );
    check(
      `${label}: the bounded query uses an index`,
      Array.isArray(after.stages) && after.stages.includes("IXSCAN"),
      `stages: ${(after.stages ?? []).join(", ") || "none"}`,
    );

    // Bounded by the live set rather than by the store. The allowance covers the `$or` machinery
    // and the local-rows branch, and is a multiple rather than an exact figure so a planner
    // improvement does not fail the gate while a return to reading history does.
    const allowance = row.liveRows * 4 + 100;
    check(
      `${label}: the documents examined are bounded by the live set`,
      after.docsExamined <= allowance,
      `examined ${after.docsExamined} for ${row.liveRows} live rows (allowance ${allowance})`,
    );

    check(
      `${label}: the page still contains every live row`,
      row.resultCount === row.liveRows,
      `the response held ${row.resultCount} rows for ${row.liveRows} live sessions`,
    );
  }

  if (scaling.length >= 2) {
    const first = scaling[0];
    const last = scaling[scaling.length - 1];
    const storedGrowth = last.storedSessions / Math.max(1, first.storedSessions);
    const examinedGrowth = last.boundedQuery.docsExamined / Math.max(1, first.boundedQuery.docsExamined);

    check(
      "the collection grew by at least an order of magnitude between the first and last stage",
      storedGrowth >= 10,
      `grew ${storedGrowth.toFixed(1)}x`,
    );
    check(
      "the bounded query's cost did not follow the collection",
      last.boundedQuery.docsExamined <= first.boundedQuery.docsExamined * 2 + 50,
      `the store grew ${storedGrowth.toFixed(1)}x while documents examined went from ` +
        `${first.boundedQuery.docsExamined} to ${last.boundedQuery.docsExamined} ` +
        `(${examinedGrowth.toFixed(2)}x)`,
    );
  }

  console.log("");
  console.log("BOUNDED LIVE-LIST BENCHMARK SANITY");
  for (const note of notes) console.log(note);
  for (const failure of failures) console.log(failure);

  // The latency figures, reported rather than asserted: a reader of a failure wants them beside
  // the verdict, and a gate on a millisecond would fail on a loaded runner for no reason.
  console.log("");
  console.log("  latency (reported, not asserted)");
  for (const row of scaling) {
    console.log(
      `    ${String(row.storedSessions).padStart(7)} stored  ` +
        `${String(row.liveRows).padStart(5)} live  ` +
        `p50 ${row.liveList.p50Ms.toFixed(2).padStart(7)} ms  ` +
        `p95 ${row.liveList.p95Ms.toFixed(2).padStart(7)} ms  ` +
        `docs ${String(row.boundedQuery.docsExamined).padStart(6)}`,
    );
  }

  console.log("");
  console.log(
    failures.length === 0
      ? "  BOUNDED LIVE-LIST BENCHMARK SANITY PASSED"
      : `  BOUNDED LIVE-LIST BENCHMARK SANITY FAILED: ${failures.length} check(s)`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}

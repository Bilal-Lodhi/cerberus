/**
 * The backup / restore drill.
 *
 * ── What it proves ────────────────────────────────────────────────────
 *
 * That a backup can be taken, restored into a scratch database, and **verified** — and
 * that every refusal the restore script claims to make actually happens. `docs/operations/backup-restore.md`
 * documents the scripts; this is the thing that runs them end to end, on demand, without an
 * operator's judgement in the loop.
 *
 * The failure it exists for is quiet. `mongorestore` exits **0** when it restores nothing —
 * pointing it at the database directory instead of the dump root makes it report
 * "don't know what to do with file ..., skipping" and succeed. A drill that trusted the
 * exit code would call an empty restore a pass. So every restore here is judged on the
 * script's own verification output, and every refusal is judged on the message, not merely
 * on a non-zero exit.
 *
 * ── It creates its own database ───────────────────────────────────────
 *
 * A disposable `mongo:7` container, so the drill is self-contained and repeatable: it does
 * not depend on an operator's local database, on `mongodump` being installed, or on a
 * service container whose name it would have to know. It removes the container when it is
 * done, whatever happened.
 *
 * ── What it deliberately does not cover ───────────────────────────────
 *
 * Scheduling, off-host storage, encryption and point-in-time recovery. Those are gaps in
 * the product, not in the drill, and `docs/operations/backup-restore.md` states them.
 *
 * Usage:
 *   node scripts/release/backup-restore-drill.mjs
 *   node scripts/release/backup-restore-drill.mjs --keep   leave the container for inspection
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");

const SOURCE_DATABASE = "cerberus";
const RESTORED_DATABASE = "cerberus_restored";
const TAMPER_DATABASE = "cerberus_tampered";
const CONTAINER = `cerberus-drill-${Date.now().toString(36)}`;
const MONGO_IMAGE = "mongo:7";

const criticalIndexes = JSON.parse(
  readFileSync(resolve(here, "critical-indexes.json"), "utf8"),
).indexes;

const checks = [];

function check(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Runs a command and captures its output. Never throws; the caller judges the result. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32" && command === "pwsh",
    ...options,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function docker(args, options) {
  return run("docker", args, options);
}

/** Runs `mongosh` inside the drill's container and returns its output. */
function mongosh(script, database = "admin") {
  const result = docker(["exec", CONTAINER, "mongosh", database, "--quiet", "--eval", script]);
  if (result.status !== 0) {
    throw new Error(`mongosh failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/** Runs one of the PowerShell scripts, with output captured. */
function powershell(script, args) {
  return run("pwsh", ["-NoProfile", "-File", resolve(root, "scripts", script), ...args]);
}

// ═══════════════════════════════════════════════════════════════════
// The fixture: an empty collection, non-empty ones, and the indexes
// ═══════════════════════════════════════════════════════════════════

/**
 * Seeds the source database.
 *
 * `threat_scenarios` is created **empty** on purpose. `mongodump` writes a 0-byte `.bson`
 * for a collection that exists and holds nothing, and judging a dump by file size alone
 * once failed a perfectly good backup of any deployment whose `risk_assessments` or
 * `threat_scenarios` were still empty — which is every fresh deployment. The fixture
 * contains both an empty collection and non-empty ones so that judgement is exercised.
 */
function seedSourceDatabase() {
  const collections = [
    "monitored_sessions",
    "micro_events",
    "risk_assessments",
    "reference_documents",
    "schema_migrations",
  ];

  // Empty, and must still exist so it appears in the dump.
  mongosh(`db.createCollection('threat_scenarios')`, SOURCE_DATABASE);

  mongosh(
    `
    db.monitored_sessions.insertMany([
      { sessionId: 'drill-1', employeeId: 'op-1', auditId: 'audit-1', status: 'active',
        eventCount: 2, focusLossCount: 1, createdAt: new Date(), updatedAt: new Date() },
      { sessionId: 'drill-2', employeeId: 'op-2', auditId: 'audit-1', status: 'locked',
        eventCount: 0, focusLossCount: 0, createdAt: new Date(), updatedAt: new Date() }
    ]);
    db.micro_events.insertMany([
      { sessionId: 'drill-1', eventId: 'e1', eventType: 'KEYSTROKE', timestamp: new Date() },
      { sessionId: 'drill-1', eventId: 'e2', eventType: 'PASTE', timestamp: new Date() },
      { sessionId: 'drill-2', eventId: 'e3', eventType: 'TAB_SWITCH', timestamp: new Date() }
    ]);
    db.risk_assessments.insertOne({
      riskAssessmentId: 'assessment-1', sessionId: 'drill-1', overallRiskScore: 61,
      generatedAt: new Date()
    });
    db.reference_documents.insertOne({
      referenceId: 'reference-1', label: 'drill', content: 'drill content',
      createdAt: new Date(), updatedAt: new Date()
    });
    db.schema_migrations.insertOne({
      migrationId: 'drill-migration-1', appliedAt: new Date(), description: 'drill'
    });
    `,
    SOURCE_DATABASE,
  );

  // The critical indexes, from the shared list — the same list the restore script verifies
  // against, so the verification has something real to find.
  for (const entry of criticalIndexes) {
    const keys = Object.entries(entry.key)
      .map(([field, direction]) => `"${field}": ${direction}`)
      .join(", ");
    mongosh(
      `db.getCollection('${entry.collection}').createIndex({ ${keys} }, { unique: true })`,
      SOURCE_DATABASE,
    );
  }

  return collections;
}

// ═══════════════════════════════════════════════════════════════════
// The drill
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const started = Date.now();
  const workDirectory = mkdtempSync(join(tmpdir(), "cerberus-drill-"));
  const backupDirectory = join(workDirectory, "backup");

  console.log("CERBERUS BACKUP / RESTORE DRILL");
  console.log(`  container: ${CONTAINER} (${MONGO_IMAGE}), removed when done\n`);

  try {
    // ── A disposable database ──
    const started_ = docker(["run", "-d", "--name", CONTAINER, MONGO_IMAGE]);
    if (started_.status !== 0) {
      throw new Error(
        `could not start ${MONGO_IMAGE}: ${started_.stderr || started_.stdout}. ` +
          "The drill needs Docker; it creates its own database so it does not depend on yours.",
      );
    }

    let ready = false;
    for (let attempt = 0; attempt < 30 && !ready; attempt += 1) {
      const ping = docker([
        "exec",
        CONTAINER,
        "mongosh",
        "--quiet",
        "--eval",
        "db.runCommand({ ping: 1 }).ok",
      ]);
      ready = ping.status === 0 && ping.stdout.includes("1");
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error("the disposable MongoDB never answered a ping");

    seedSourceDatabase();
    console.log("fixture: 1 empty collection, 5 non-empty, the critical indexes, a ledger\n");

    // ── Backup ──
    console.log("── backup");
    const backup = powershell("backup-cerberus.ps1", [
      "-Container",
      CONTAINER,
      "-Database",
      SOURCE_DATABASE,
      "-Out",
      backupDirectory,
    ]);
    check(
      "the backup succeeds and writes a manifest",
      backup.status === 0 && backup.stdout.includes("manifest:"),
      backup.status === 0 ? "" : backup.stderr.trim().split("\n").slice(-1)[0],
    );
    if (backup.status !== 0) throw new Error("the backup failed, so the rest of the drill cannot run");

    // The dump root is timestamped (`<Out>/cerberus-<stamp>`), so it is read from the
    // backup's own report rather than guessed: the script prints the path it used, and
    // guessing it would break the drill the day the naming changes.
    const targetMatch = /\[backup\] target=(.+)/.exec(backup.stdout);
    if (!targetMatch) {
      throw new Error(
        `the backup did not report where it wrote the dump. Output:\n${backup.stdout}`,
      );
    }
    const backupRoot = targetMatch[1].trim();

    // The manifest sits at the dump ROOT, beside the database directory — not inside it.
    const manifestPath = join(backupRoot, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    check(
      "the manifest records a count for every collection, including the empty one",
      Object.keys(manifest.collections).length >= 6 &&
        manifest.collections["threat_scenarios"] === 0,
      `${Object.keys(manifest.collections).length} collection(s), threat_scenarios=${manifest.collections["threat_scenarios"]}`,
    );
    check(
      "the manifest carries no connection string",
      !JSON.stringify(manifest).includes("mongodb://"),
      "a manifest sits next to the data it describes",
    );

    // ── Restore, and verify ──
    console.log("\n── restore into a scratch database");
    const restore = powershell("restore-cerberus.ps1", [
      "-Backup",
      backupRoot,
      "-Container",
      CONTAINER,
      "-TargetDatabase",
      RESTORED_DATABASE,
    ]);
    check(
      "the restore succeeds and verifies counts and indexes",
      restore.status === 0 &&
        restore.stdout.includes("matches the backup, with its uniqueness guarantees"),
      restore.status === 0 ? "" : restore.stderr.trim().split("\n").slice(-1)[0],
    );

    const restoredCounts = mongosh(
      `print(db.monitored_sessions.countDocuments({}), db.micro_events.countDocuments({}))`,
      RESTORED_DATABASE,
    )
      .trim()
      .split(/\s+/);
    check(
      "the restored database holds the documents",
      restoredCounts[0] === "2" && restoredCounts[1] === "3",
      `monitored_sessions=${restoredCounts[0]}, micro_events=${restoredCounts[1]}`,
    );

    // ── Refusals ──
    //
    // Each is judged on the message, not merely on a non-zero exit: a refusal for the
    // wrong reason is a refusal that will not happen when it matters.
    console.log("\n── refusals");

    const sameDatabase = powershell("restore-cerberus.ps1", [
      "-Backup",
      backupRoot,
      "-Container",
      CONTAINER,
      "-TargetDatabase",
      SOURCE_DATABASE,
    ]);
    check(
      "restoring over the source database is refused",
      sameDatabase.status !== 0 && /Refusing to restore/.test(sameDatabase.stderr + sameDatabase.stdout),
    );

    const nonEmpty = powershell("restore-cerberus.ps1", [
      "-Backup",
      backupRoot,
      "-Container",
      CONTAINER,
      "-TargetDatabase",
      RESTORED_DATABASE,
    ]);
    check(
      "restoring over a non-empty target without -Drop is refused",
      nonEmpty.status !== 0 && /already holds/.test(nonEmpty.stderr + nonEmpty.stdout),
    );

    // ── Tampering ──
    //
    // A manifest is what makes a restore *verifiable* rather than merely *successful*. If
    // a wrong manifest were accepted, the verification would be decoration.
    console.log("\n── a tampered manifest");
    const tamperedManifest = JSON.parse(JSON.stringify(manifest));
    tamperedManifest.collections["micro_events"] = manifest.collections["micro_events"] + 1;

    // A separate dump root, so the original is left intact for the checks above. The
    // layout is the same as the real one: `<root>/<database>/…` plus `<root>/manifest.json`.
    const tamperedRoot = join(workDirectory, "tampered");
    // `mkdirSync`/`cpSync` rather than a shell `mkdir -p` and `cp`: on Windows the shell is
    // `cmd`, whose `mkdir` has no `-p`, and the drill would fail with a missing-directory
    // error that looks like a tampering bug.
    mkdirSync(tamperedRoot, { recursive: true });
    cpSync(join(backupRoot, SOURCE_DATABASE), join(tamperedRoot, SOURCE_DATABASE), {
      recursive: true,
    });
    writeFileSync(
      join(tamperedRoot, "manifest.json"),
      JSON.stringify(tamperedManifest, null, 2),
    );

    const tampered = powershell("restore-cerberus.ps1", [
      "-Backup",
      tamperedRoot,
      "-Container",
      CONTAINER,
      "-TargetDatabase",
      TAMPER_DATABASE,
    ]);
    check(
      "a manifest whose counts disagree with the dump is refused",
      tampered.status !== 0 &&
        /verification failed/i.test(tampered.stderr + tampered.stdout),
      tampered.status === 0 ? "the tampered manifest was accepted" : "",
    );

    // ── Report ──
    const failed = checks.filter((entry) => !entry.passed).length;
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    console.log(`\nSUMMARY — ${checks.length - failed} passed, ${failed} failed — ${elapsed}s`);
    console.log(
      failed === 0
        ? "\nBACKUP / RESTORE DRILL PASSED"
        : `\nBACKUP / RESTORE DRILL FAILED: ${failed} check(s)`,
    );
    console.log(
      "\n  Not covered by this drill, and not claimed: scheduling, off-host storage,\n" +
        "  encryption, and point-in-time recovery. See docs/operations/backup-restore.md.",
    );

    return failed === 0 ? 0 : 1;
  } finally {
    if (!keep) {
      docker(["rm", "-f", CONTAINER]);
      rmSync(workDirectory, { recursive: true, force: true });
    } else {
      console.log(`\n  kept: container ${CONTAINER}, dump in ${workDirectory}`);
    }
  }
}

process.exit(await main());

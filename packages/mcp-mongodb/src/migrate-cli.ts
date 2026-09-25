/**
 * Migration CLI.
 *
 *   node dist/migrate-cli.js --dry-run    show what would happen, change nothing
 *   node dist/migrate-cli.js              apply pending migrations
 *
 * Exists because a migration is sometimes the thing an operator needs to *see*
 * before it runs. `--dry-run` prints the plan — including which migrations rewrite
 * data — without touching the database.
 *
 * The API applies migrations on connect as well, so this is not required for a
 * normal deployment. It is required when a migration refused to run automatically
 * (a conflict) or when an operator wants to inspect the plan first.
 *
 * Exit codes: 0 success, 1 failure. A conflict or an unknown migration is a
 * failure, because both mean the database needs a decision a script cannot make.
 */

import { MongoStore } from "./mongo-client.js";
import { DEFAULT_DATABASE_NAME } from "./tool-names.js";

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const uri = process.env["MONGODB_URI"] ?? "mongodb://127.0.0.1:27017";
  const database = process.env["MONGODB_DATABASE"] ?? DEFAULT_DATABASE_NAME;

  const store = new MongoStore({ uri, databaseName: database });

  try {
    // Connect WITHOUT migrating: `connect()` applies pending migrations, and the
    // plan is exactly what an operator runs this to see.
    await store.connect({ migrate: false });

    const result = await store.runMigrations({ dryRun });

    console.log("");
    console.log(`[migrate] database: ${database}${dryRun ? " (dry run)" : ""}`);
    for (const entry of result.plan) {
      const mark = entry.state === "applied" ? "applied" : "pending";
      const rewrite = entry.rewritesData ? " [rewrites data]" : "";
      console.log(`  ${mark.padEnd(8)} ${entry.id}${rewrite}`);
      console.log(`           ${entry.description}`);
    }

    if (dryRun) {
      console.log("[migrate] dry run: nothing was changed");
      return 0;
    }

    // Indexes are created after migrations for the same reason `connect()` orders
    // them that way: the unique identity index cannot be built over duplicates.
    if (result.applied.length > 0) {
      await store.ensureIndexes();
    }

    console.log(
      result.applied.length > 0
        ? `[migrate] applied: ${result.applied.join(", ")}`
        : "[migrate] nothing to apply",
    );
    return 0;
  } catch (error) {
    console.error(
      `[migrate] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  } finally {
    await store.disconnect().catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("[migrate] FATAL:", error);
    process.exit(1);
  });

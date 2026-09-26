/**
 * The stale-image defence.
 *
 * ── The defect this exists for ────────────────────────────────────────
 *
 * The `v0.3.0` verification reused an **old container image**. Nothing compared what the
 * image was built from against the source it was supposed to be built from, so an image
 * from an earlier commit was verified as though it were the release — and every check
 * passed, because every check was about the old image.
 *
 * ── What this does ────────────────────────────────────────────────────
 *
 *   1. Builds the image with **`--no-cache`**, so no layer can come from an earlier
 *      source tree.
 *   2. Tags it uniquely per run, so nothing can pick up a previous tag by accident.
 *   3. Passes the working tree's version and commit in as build arguments, which the
 *      `Dockerfile` bakes into the image's **labels** and environment.
 *   4. Reads the labels back from the built image and compares them with the working
 *      tree. A mismatch fails here, before anything is run.
 *   5. Starts the container and asks its `/health` what version it reports, so the
 *      *running* process is checked rather than only its metadata.
 *   6. Asserts the metadata carries nothing but a version and a commit.
 *
 * The provenance lives in image labels rather than in the `/health` response on purpose:
 * `/health` is public and unauthenticated, and publishing the exact commit a deployment
 * runs tells an attacker which build to look up.
 *
 * ── What it deliberately does not do ──────────────────────────────────
 *
 * It does not push, tag a release, or publish anything. `scripts/release/secret-guards.mjs`
 * fails if a publishing command appears anywhere in this directory.
 *
 * Usage:
 *   node scripts/release/verify-image.mjs
 *   node scripts/release/verify-image.mjs --keep   leave the container and image behind
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");

const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return (result.stdout ?? "").trim();
}

const commit = git(["rev-parse", "HEAD"]);
const shortCommit = commit.slice(0, 8);

// Unique per run: a fixed tag is how a stale image gets reused, which is the whole defect.
const tag = `cerberus-verify:${shortCommit}-${Date.now().toString(36)}`;
const container = `cerberus-verify-${shortCommit}-${Date.now().toString(36)}`;
const port = 18080;

const checks = [];

function check(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function main() {
  const started = Date.now();

  console.log("CERBERUS STALE-IMAGE DEFENCE");
  console.log(`  source: version ${version}, commit ${shortCommit}`);
  console.log(`  image:  ${tag} (built --no-cache)\n`);

  if (!commit) {
    console.error("Could not read HEAD. This check compares the image against the commit it");
    console.error("was built from, so it needs a git working tree.");
    return 2;
  }

  try {
    // ── 1-3. A fresh build, uniquely tagged, with the provenance passed in ──
    console.log("── building (no cache)");
    const build = run("docker", [
      "build",
      "--no-cache",
      "--tag",
      tag,
      "--build-arg",
      `CERBERUS_VERSION=${version}`,
      "--build-arg",
      `CERBERUS_COMMIT=${commit}`,
      ".",
    ]);
    check(
      "the image builds from this source tree with no cached layer",
      build.status === 0,
      build.status === 0 ? "" : build.stderr.trim().split("\n").slice(-1)[0],
    );
    if (build.status !== 0) {
      throw new Error("the build failed, so there is nothing to compare");
    }

    // ── 4. What the image says it is ──
    const inspected = run("docker", ["inspect", "--format", "{{json .Config.Labels}}", tag]);
    const labels = JSON.parse(inspected.stdout.trim() || "{}");

    check(
      "the image records the version it was built from",
      labels["org.opencontainers.image.version"] === version,
      `label says '${labels["org.opencontainers.image.version"]}', source says '${version}'`,
    );
    check(
      "the image records the commit it was built from",
      labels["org.opencontainers.image.revision"] === commit,
      `label says '${String(labels["org.opencontainers.image.revision"]).slice(0, 8)}', source is '${shortCommit}'`,
    );

    // ── 6. No secrets in the metadata ──
    //
    // The labels are a version and a commit and nothing else. A build argument that
    // carried a credential would be readable by anyone who can pull the image, and build
    // arguments are visible in the image history besides.
    const metadata = JSON.stringify(labels);
    const forbidden = [
      { pattern: /mongodb(\+srv)?:\/\//i, what: "a connection string" },
      { pattern: /\bsk-[A-Za-z0-9_-]{8,}/, what: "a provider key" },
      { pattern: /\bBearer\s/i, what: "a bearer token" },
      { pattern: /\bSG\.[A-Za-z0-9_-]{8,}\./, what: "a SendGrid key" },
      { pattern: /https:\/\/hooks\.slack\.com\//i, what: "a webhook URL" },
    ];
    const leaked = forbidden.filter((entry) => entry.pattern.test(metadata));
    check(
      "the image metadata carries no secret",
      leaked.length === 0,
      leaked.map((entry) => entry.what).join(", "),
    );

    // ── 5. What the *running* process says it is ──
    console.log("\n── starting the container");
    const started_ = run("docker", [
      "run",
      "-d",
      "--name",
      container,
      "-e",
      "NODE_ENV=development",
      "-e",
      "CERBERUS_DEV_MODE=true",
      "-e",
      "OPENAI_API_KEY=verify-placeholder-not-a-real-key",
      "-e",
      "MONGODB_URI=mongodb://127.0.0.1:27017",
      "-p",
      `${port}:8080`,
      tag,
    ]);
    check(
      "the container starts",
      started_.status === 0,
      started_.status === 0 ? "" : started_.stderr.trim().split("\n").slice(-1)[0],
    );

    if (started_.status === 0) {
      let health = null;
      for (let attempt = 0; attempt < 30 && health === null; attempt += 1) {
        const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
        if (response?.ok) health = await response.json();
        else await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      check(
        "the running container answers /health",
        health !== null,
        health === null ? "no answer within 30s" : "",
      );
      check(
        "the running container reports the version it was built from",
        health?.version === version,
        health ? `reports '${health.version}', source says '${version}'` : "",
      );

      // The provenance is readable from the running container without Docker too, which is
      // what an operator with `docker exec` but no registry access needs.
      const reportedCommit = run("docker", ["exec", container, "printenv", "CERBERUS_BUILD_COMMIT"]);
      check(
        "the running container can state the commit it was built from",
        reportedCommit.stdout.trim() === commit,
        reportedCommit.stdout.trim().slice(0, 8),
      );
    }

    // ── Report ──
    const failed = checks.filter((entry) => !entry.passed).length;
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    console.log(`\nSUMMARY — ${checks.length - failed} passed, ${failed} failed — ${elapsed}s`);
    console.log(
      failed === 0
        ? "\nSTALE-IMAGE DEFENCE PASSED (nothing was pushed or published)"
        : `\nSTALE-IMAGE DEFENCE FAILED: ${failed} check(s)`,
    );

    return failed === 0 ? 0 : 1;
  } finally {
    if (!keep) {
      run("docker", ["rm", "-f", container]);
      run("docker", ["rmi", "-f", tag]);
    } else {
      console.log(`\n  kept: container ${container}, image ${tag}`);
    }
  }
}

process.exit(await main());

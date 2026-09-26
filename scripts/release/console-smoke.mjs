/**
 * The browser smoke, as one command.
 *
 * ── What this automates, and what it does not ─────────────────────────
 *
 * Flutter web renders into a **canvas**, so the page's text is not in the DOM and a
 * selector-based assertion cannot read it. That is why the `v0.2.0` and `v0.3.0` passes
 * were driven through the Chrome DevTools Protocol and judged from **screenshots** — and
 * why two false operator-facing claims were caught that way (PR #45, PR #46).
 *
 * So this splits the work honestly:
 *
 *   AUTOMATED   the page loads; the browser console reports no error; Flutter reports no
 *               overflow. Overflow is machine-checkable because Flutter prints
 *               `A RenderFlex overflowed by N pixels` to the console, which is exactly the
 *               "obvious overflow" a visual pass looks for.
 *   HUMAN       the rendered text. Screenshots are written to the output directory, and
 *               `docs/development/console-smoke.md` lists what to look for — the current
 *               terminology, the empty-corpus wording, the corpus ceiling.
 *   WIDGET      the corpus behaviour that *is* assertable: an empty corpus, the ceiling,
 *               add validation, a rejected delete, and the stable-code rendering. Those
 *               are `apps/console/test/reference_corpus_test.dart`, and `npm run
 *               console:test` runs them.
 *
 * A check that pretended to read the canvas would be a check that lied.
 *
 * ── What it needs ─────────────────────────────────────────────────────
 *
 * Docker (a disposable MongoDB), Flutter (to build the bundle), and Chrome. Each is
 * checked, and its absence is reported as a skip with the reason rather than as a failure.
 *
 * Usage:
 *   node scripts/release/console-smoke.mjs
 *   node scripts/release/console-smoke.mjs --out ./smoke --keep
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");

const outIndex = process.argv.indexOf("--out");
const outDirectory = resolve(
  outIndex === -1 ? join(root, "smoke-output") : process.argv[outIndex + 1],
);

const WEB_DIRECTORY = join(root, "apps", "console", "build", "web");
const STEP_SCRIPT = join(root, "scripts", "qa", "console-smoke.json");
/**
 * The port the built console is served from.
 *
 * 5173, not an arbitrary port, and that is load-bearing: the API's development CORS
 * allow-list is `localhost`/`127.0.0.1` on 8080 and **5173** only, so a console served
 * from anywhere else is blocked by the browser and the identity gate reports "Failed to
 * connect to identity service". The first version of this smoke served it from 8090 and
 * hit exactly that — which is a real coupling an operator would also hit, now written
 * down rather than rediscovered.
 */
const WEB_PORT = 5173;
const API_PORT = 8080;
const MCP_PORT = 3001;
const DEBUG_PORT = 9222;
const CONTAINER = `cerberus-smoke-${Date.now().toString(36)}`;

const CHROME_CANDIDATES = [
  process.env["CHROME_PATH"],
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

function has(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32" });
  return result.status === 0;
}

function chromePath() {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

const checks = [];

function check(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Whether a command needs a shell.
 *
 * On Windows, `npm`, `flutter` and `dart` are `.bat` shims that `spawn` cannot execute
 * directly, so a **bare name** needs a shell. An absolute path must not have one: with
 * `shell: true` the arguments are concatenated rather than escaped, so
 * `C:\Program Files\nodejs\node.exe` breaks on its own space — which is how the static
 * server silently failed to start the first time this ran.
 */
function needsShell(command) {
  return process.platform === "win32" && !command.includes("/") && !command.includes("\\");
}

/** Runs a command to completion, capturing its output. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: needsShell(command),
    ...options,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Starts a long-running child and returns it, so it can be stopped afterwards. */
function start(command, args, env = {}) {
  return spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "ignore",
    shell: needsShell(command),
  });
}

async function waitFor(url, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(url).catch(() => null);
    if (response?.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

const children = [];

function stopAll() {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
}

async function main() {
  const started = Date.now();

  console.log("CERBERUS CONSOLE SMOKE");
  console.log(`  screenshots: ${outDirectory}\n`);

  // ── Preconditions, each reported rather than assumed ──
  const chrome = chromePath();
  if (!chrome) {
    console.log("  SKIPPED — no Chrome found. Set CHROME_PATH to point at one.");
    return 0;
  }
  if (!has("docker", ["info"])) {
    console.log("  SKIPPED — no Docker daemon, and the smoke needs a disposable database.");
    return 0;
  }
  if (!has("flutter", ["--version"])) {
    console.log("  SKIPPED — Flutter is not on PATH, so the web bundle cannot be built.");
    return 0;
  }

  mkdirSync(outDirectory, { recursive: true });

  try {
    // ── Build the bundle, then the services ──
    //
    // `--no-web-resources-cdn` is load-bearing: a default release build fetches CanvasKit
    // from `gstatic.com` at runtime, and on a machine or runner without access to it the
    // canvas never renders. The first version of this smoke did not pass the flag, and the
    // screenshots came back **blank** while every check passed — which is precisely the
    // "green for the wrong reason" failure this whole harness exists to catch. The
    // `rendered content` check below is what would have caught it.
    console.log("── building the console bundle");
    const built = run(
      "flutter",
      [
        "build",
        "web",
        "--release",
        "--no-web-resources-cdn",
        // Pin the API address rather than relying on the console's default, so the smoke
        // is testing this stack and not whatever `localhost` resolves to.
        `--dart-define=API_BASE_URL=http://127.0.0.1:${API_PORT}`,
      ],
      { cwd: join(root, "apps", "console") },
    );
    check(
      "the console web bundle builds",
      built.status === 0 && existsSync(join(WEB_DIRECTORY, "index.html")),
      built.status === 0 ? "" : built.stderr.trim().split("\n").slice(-1)[0],
    );
    if (built.status !== 0) return 1;

    console.log("── starting a disposable stack");
    const mongo = run("docker", ["run", "-d", "--name", CONTAINER, "-p", "27019:27017", "mongo:7"]);
    check("a disposable MongoDB starts", mongo.status === 0);
    if (mongo.status !== 0) return 1;

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ping = run("docker", ["exec", CONTAINER, "mongosh", "--quiet", "--eval", "db.runCommand({ping:1}).ok"]);
      if (ping.stdout.includes("1")) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // The compiled services. `npm run build` is the harness's first step, so the entries
    // exist; a missing one is a real failure rather than a skip.
    const services = start("npm", ["start"], {
      PORT: String(API_PORT),
      MCP_PORT: String(MCP_PORT),
      MONGODB_URI: "mongodb://127.0.0.1:27019",
      CERBERUS_DEV_MODE: "true",
      NODE_ENV: "development",
      OPENAI_API_KEY: "smoke-placeholder-not-a-real-key",
    });
    children.push(services);

    const apiUp = await waitFor(`http://127.0.0.1:${API_PORT}/health`);
    check("the API answers /health", apiUp, apiUp ? "" : "no answer within 30s");

    const web = start(process.execPath, [join(root, "scripts", "qa", "serve-web.mjs"), WEB_DIRECTORY, String(WEB_PORT)]);
    children.push(web);

    const webUp = await waitFor(`http://127.0.0.1:${WEB_PORT}/index.html`);
    check("the built console is served", webUp, webUp ? "" : "no answer within 30s");
    if (!webUp) return 1;

    // ── Drive the real browser ──
    //
    // Chrome is launched **at the console's URL**, not at `about:blank`. `scripts/qa/cdp.mjs`
    // attaches to the first page target and never navigates — it was written for a browser
    // already pointed at the app — so launching it at a blank page drives a blank page and
    // every screenshot is empty.
    console.log("\n── driving headless Chrome");
    const consoleUrl = `http://127.0.0.1:${WEB_PORT}/index.html`;
    const chromeProcess = start(chrome, [
      "--headless=new",
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--window-size=1280,900",
      consoleUrl,
    ]);
    children.push(chromeProcess);

    const debuggingUp = await waitFor(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    check("headless Chrome exposes the DevTools protocol", debuggingUp);
    if (!debuggingUp) return 1;

    const driven = run(process.execPath, [
      join(root, "scripts", "qa", "cdp.mjs"),
      consoleUrl,
      outDirectory,
      STEP_SCRIPT,
    ]);

    check(
      "the smoke script runs to the end",
      driven.status === 0,
      driven.status === 0 ? "" : (driven.stderr || driven.stdout).trim().split("\n").slice(-1)[0],
    );

    const consoleOutput = `${driven.stdout}\n${driven.stderr}`;

    // ── The two machine-checkable assertions ──
    //
    // Flutter renders into a canvas, so the page's text cannot be read here. What *can* be
    // read is the browser console, and it carries both of these.
    const overflow = /overflowed by (\d+(\.\d+)?) pixels?/i.exec(consoleOutput);
    check(
      "no layout overflow is reported",
      overflow === null,
      overflow ? `Flutter reported '${overflow[0]}'` : "",
    );

    const errorLines = consoleOutput
      .split(/\r?\n/)
      .filter((line) => /\[console\]\s*error/i.test(line) || /\bERROR\b.*console/i.test(line));
    check(
      "the browser console reports no error",
      errorLines.length === 0,
      errorLines.slice(0, 3).join(" | "),
    );

    const written = [
      "01-identity-gate.png",
      "02-identity-filled.png",
      "03-dashboard.png",
      "04-narrow.png",
      "05-wide.png",
    ].filter((name) => existsSync(join(outDirectory, name)));
    check(
      "the screenshots a human must inspect were written",
      written.length === 5,
      `${written.length} of 5`,
    );

    // ── The page actually rendered something ──
    //
    // This is the check the first version of this smoke was missing, and it is the reason
    // the smoke exists. Flutter web draws into a canvas, so nothing here can read the text
    // — but a canvas that never rendered produces a nearly uniform image, which compresses
    // to a few kilobytes, while a rendered dashboard is an order of magnitude larger. The
    // threshold is not a measurement of quality; it distinguishes "drew something" from
    // "drew nothing", which is the difference between a smoke that means something and one
    // that passes on a blank page.
    const RENDERED_MINIMUM_BYTES = 15_000;
    const sizes = written.map((name) => ({
      name,
      bytes: statSync(join(outDirectory, name)).size,
    }));
    const blank = sizes.filter((entry) => entry.bytes < RENDERED_MINIMUM_BYTES);
    check(
      "the page rendered content rather than a blank canvas",
      blank.length === 0,
      blank.length === 0
        ? `smallest ${Math.min(...sizes.map((entry) => entry.bytes))} bytes`
        : blank.map((entry) => `${entry.name} ${entry.bytes}B`).join(", "),
    );

    // ── Report ──
    const failed = checks.filter((entry) => !entry.passed).length;
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    console.log(`\nSUMMARY — ${checks.length - failed} passed, ${failed} failed — ${elapsed}s`);
    console.log(
      failed === 0
        ? "\nCONSOLE SMOKE PASSED (the visual pass still needs a human — see docs/development/console-smoke.md)"
        : `\nCONSOLE SMOKE FAILED: ${failed} check(s)`,
    );

    return failed === 0 ? 0 : 1;
  } finally {
    stopAll();
    if (!keep) {
      run("docker", ["rm", "-f", CONTAINER]);
      rmSync(outDirectory, { recursive: true, force: true });
    } else {
      console.log(`\n  kept: container ${CONTAINER}, screenshots in ${outDirectory}`);
    }
  }
}

process.exit(await main());

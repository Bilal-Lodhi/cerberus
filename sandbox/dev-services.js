/**
 * Cerberus AI — Auto-Reload Development Launcher
 *
 * Runs both Hono API and MCP Server using tsx watch mode.
 * Both services auto-restart on file changes. Press Ctrl+C to stop.
 *
 * Usage:  node dev-services.js
 *         npm run dev
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config as loadDotenv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from sandbox/ root
loadDotenv({ path: join(__dirname, ".env") });

const PORT = process.env["PORT"] ?? "8080";
const MCP_PORT = process.env["MCP_PORT"] ?? "3001";
const CORRELATION_ID = randomUUID().slice(0, 8);

const COLORS = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
};

/**
 * @param {string} name
 * @param {string} color
 * @returns {string}
 */
function prefix(name, color) {
  const timestamp = new Date().toISOString().slice(11, 19);
  return `${color}[${timestamp} ${name}]${COLORS.reset}`;
}

/** @type {Map<string, import("node:child_process").ChildProcess>} */
const processes = new Map();

/**
 * @param {string} name
 * @param {string} command
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @param {string} cwd
 */
function launch(name, command, args, env, cwd) {
  console.log(
    `${prefix(name, COLORS.magenta)} ${COLORS.bright}tsx watch${COLORS.reset} — ${command} ${args.join(" ")}`
  );

  const child = spawn(command, args, {
    stdio: "pipe",
    cwd,
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });

  child.stdout?.on("data", (/** @type {Buffer} */ data) => {
    const lines = data.toString().trim().split("\n");
    for (const line of lines) {
      if (line) console.log(`${prefix(name, COLORS.green)} ${line}`);
    }
  });

  child.stderr?.on("data", (/** @type {Buffer} */ data) => {
    const lines = data.toString().trim().split("\n");
    for (const line of lines) {
      if (line) console.log(`${prefix(name, COLORS.yellow)} ${line}`);
    }
  });

  child.on("error", (/** @type {Error} */ err) => {
    console.log(`${prefix(name, COLORS.red)} Failed to launch: ${err.message}`);
  });

  child.on("exit", (/** @type {number|null} */ code, /** @type {NodeJS.Signals|null} */ signal) => {
    if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL" && signal !== "SIGINT") {
      console.log(
        `${prefix(name, COLORS.red)} Process exited unexpectedly — code: ${code}, signal: ${signal}. Restarting in 2s...`
      );
      setTimeout(() => {
        if (!shuttingDown) launch(name, command, args, env, cwd);
      }, 2000);
    }
  });

  processes.set(name, child);
}

let shuttingDown = false;

function cleanup() {
  shuttingDown = true;
  console.log(`\n${prefix("MANAGER", COLORS.yellow)} Shutting down all services...`);

  for (const [name, child] of processes) {
    if (child.exitCode === null) {
      console.log(`${prefix("MANAGER", COLORS.yellow)} Terminating ${name} (PID ${child.pid})...`);
      try {
        if (process.platform === "win32") {
          child.kill("SIGKILL");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        // Process may already be dead
      }
    }
  }

  console.log(`${prefix("MANAGER", COLORS.green)} All services stopped.`);
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// ─── Banner ──────────────────────────────────────────────────────────

console.log(`
${COLORS.bright}${COLORS.cyan}╔══════════════════════════════════════════════════════════════╗
║  🔒 Cerberus FinSec — Development Mode (Auto-Reload)          ║
║  Session:   ${CORRELATION_ID}                                            ║
║  Hono API:  http://localhost:${PORT}                                ║
║  MCP HTTP:  http://localhost:${MCP_PORT}                                ║
║  Health:    http://localhost:${PORT}/health                          ║
║──────────────────────────────────────────────────────────────║
║  📁 Edit any .ts file → auto-restart on save                 ║
║  🛑 Press Ctrl+C to stop all services                        ║
╚══════════════════════════════════════════════════════════════╝${COLORS.reset}
`);

// ─── Launch Services ─────────────────────────────────────────────────

// 1. MCP Server (MongoDB Grounding Layer) — tsx watch
launch(
  "MCP-Server",
  "npx",
  ["tsx", "watch", "src/http-adapter.ts"],
  {
    MCP_PORT,
    MONGODB_URI: process.env["MONGODB_URI"] ?? "mongodb://localhost:27017",
    MONGODB_DATABASE: process.env["MONGODB_DATABASE"] ?? "gorilla_agents",
  },
  join(__dirname, "mcp-server")
);

// Small delay so MCP binds before Hono connects
await new Promise((resolve) => setTimeout(resolve, 2000));

// 2. Hono API (Gemini Agent Orchestrator) — tsx watch
launch(
  "Hono-API",
  "npx",
  ["tsx", "watch", "src/index.ts"],
  {
    PORT,
    MCP_SERVER_ENDPOINT: `http://localhost:${MCP_PORT}`,
  },
  join(__dirname, "hono-api")
);

console.log(
  `${prefix("MANAGER", COLORS.blue)} Both services watching for changes — press Ctrl+C to stop\n`
);
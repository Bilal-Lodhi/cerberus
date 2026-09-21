/**
 * Cerberus AI — Local Development Process Manager
 *
 * Spawns both the Hono API server and the MCP HTTP adapter concurrently
 * for local development. Handles signal forwarding and graceful shutdown.
 *
 * Usage:  node start-services.js
 *         npm run dev:backend
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config as loadDotenv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from sandbox/ root (and fall back gracefully if missing)
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
 */
function launch(name, command, args, env) {
  console.log(`${prefix(name, COLORS.cyan)} Launching: ${command} ${args.join(" ")}`);

  const child = spawn(command, args, {
    stdio: "pipe",
    env: { ...process.env, ...env },
    shell: process.platform === "win32", // Windows needs shell for node resolution
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
    console.log(
      `${prefix(name, COLORS.red)} Process exited — code: ${code}, signal: ${signal}`
    );
  });

  processes.set(name, child);
}

function cleanup() {
  console.log(`\n${prefix("MANAGER", COLORS.yellow)} Shutting down all services...`);

  for (const [name, child] of processes) {
    if (child.exitCode === null) {
      console.log(`${prefix("MANAGER", COLORS.yellow)} Terminating ${name} (PID ${child.pid})...`);
      if (process.platform === "win32") {
        child.kill("SIGKILL");
      } else {
        child.kill("SIGTERM");
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
║  🦍 Cerberus AI — Local Development Environment               ║
║  Session:   ${CORRELATION_ID}                                            ║
║  Hono API:  http://localhost:${PORT}                                ║
║  MCP HTTP:  http://localhost:${MCP_PORT}                                ║
║  Health:    http://localhost:${PORT}/health                          ║
╚══════════════════════════════════════════════════════════════╝${COLORS.reset}
`);

// ─── Launch Services ─────────────────────────────────────────────────

// 1. MCP Server (MongoDB Grounding Layer) — internal port
launch("MCP-Server", "node", [join(__dirname, "mcp-server", "dist", "http-adapter.js")], {
  MCP_PORT,
  MONGODB_URI: process.env["MONGODB_URI"] ?? "mongodb://localhost:27017",
  MONGODB_DATABASE: process.env["MONGODB_DATABASE"] ?? "gorilla_agents",
});

// Small delay so MCP binds before Hono connects
await new Promise((resolve) => setTimeout(resolve, 2000));

// 2. Hono API (Gemini Agent Orchestrator) — external port
launch("Hono-API", "node", [join(__dirname, "hono-api", "dist", "index.js")], {
  PORT,
  MCP_SERVER_ENDPOINT: `http://localhost:${MCP_PORT}`,
});

console.log(
  `${prefix("MANAGER", COLORS.blue)} Both services launched — press Ctrl+C to stop\n`
);
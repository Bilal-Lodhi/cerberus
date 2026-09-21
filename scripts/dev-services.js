/**
 * Cerberus — local development launcher (auto-reload).
 *
 * Runs the MCP MongoDB adapter and the API under `tsx watch`. Both restart on
 * file changes. Press Ctrl+C to stop everything.
 *
 * Usage:  npm run dev
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config as loadDotenv } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Single source of configuration: the repository-root .env
loadDotenv({ path: join(root, ".env") });

const PORT = process.env["PORT"] ?? "8080";
const MCP_PORT = process.env["MCP_PORT"] ?? "3001";
const MCP_BIND_HOST = process.env["MCP_BIND_HOST"] ?? "127.0.0.1";
const DATABASE = process.env["MONGODB_DATABASE"] ?? "cerberus";
const RUN_ID = randomUUID().slice(0, 8);

const COLOR = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
};

function prefix(name, color) {
  const timestamp = new Date().toISOString().slice(11, 19);
  return `${color}[${timestamp} ${name}]${COLOR.reset}`;
}

/** @type {Map<string, import("node:child_process").ChildProcess>} */
const processes = new Map();
let shuttingDown = false;

function launch(name, args, env, cwd) {
  console.log(
    `${prefix(name, COLOR.cyan)} tsx watch ${args.join(" ")}`,
  );

  const child = spawn("npx", ["tsx", "watch", ...args], {
    stdio: "pipe",
    cwd,
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });

  child.stdout?.on("data", (data) => {
    for (const line of data.toString().trim().split("\n")) {
      if (line) console.log(`${prefix(name, COLOR.green)} ${line}`);
    }
  });

  child.stderr?.on("data", (data) => {
    for (const line of data.toString().trim().split("\n")) {
      if (line) console.log(`${prefix(name, COLOR.yellow)} ${line}`);
    }
  });

  child.on("error", (error) => {
    console.log(`${prefix(name, COLOR.red)} failed to launch: ${error.message}`);
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (code !== 0 && !["SIGTERM", "SIGKILL", "SIGINT"].includes(signal ?? "")) {
      console.log(
        `${prefix(name, COLOR.red)} exited (code=${code} signal=${signal}) — restarting in 2s`,
      );
      setTimeout(() => {
        if (!shuttingDown) launch(name, args, env, cwd);
      }, 2000);
    }
  });

  processes.set(name, child);
}

function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${prefix("manager", COLOR.yellow)} stopping all services...`);

  for (const [name, child] of processes) {
    if (child.exitCode === null) {
      try {
        child.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
      } catch {
        // already gone
      }
    }
  }

  console.log(`${prefix("manager", COLOR.green)} all services stopped.`);
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

console.log(`
${COLOR.bright}${COLOR.cyan}Cerberus — development mode (auto-reload)
  run:       ${RUN_ID}
  api:       http://localhost:${PORT}
  mcp:       http://${MCP_BIND_HOST}:${MCP_PORT}
  database:  ${DATABASE}
  health:    http://localhost:${PORT}/health

  edit any .ts file to restart • Ctrl+C to stop
${COLOR.reset}`);

// 1. MCP MongoDB adapter
launch(
  "mcp",
  ["src/http-adapter.ts"],
  {
    MCP_PORT,
    MCP_BIND_HOST,
    MONGODB_URI: process.env["MONGODB_URI"] ?? "mongodb://localhost:27017",
    MONGODB_DATABASE: DATABASE,
  },
  join(root, "packages", "mcp-mongodb"),
);

// Give the adapter a moment to bind before the API starts.
await new Promise((resolve) => setTimeout(resolve, 2000));

// 2. API
launch(
  "api",
  ["src/index.ts"],
  {
    PORT,
    MCP_SERVER_ENDPOINT: `http://${MCP_BIND_HOST}:${MCP_PORT}`,
  },
  join(root, "apps", "api"),
);

console.log(`${prefix("manager", COLOR.blue)} both services watching — Ctrl+C to stop\n`);

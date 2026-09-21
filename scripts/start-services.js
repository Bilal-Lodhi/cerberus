/**
 * Cerberus — local process manager (compiled output).
 *
 * Starts the compiled MCP MongoDB adapter and the compiled API. Use
 * `npm run build` first, or use `npm run dev` for the auto-reload variant.
 *
 * Usage:  npm start
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

loadDotenv({ path: join(root, ".env") });

const PORT = process.env["PORT"] ?? "8080";
const MCP_PORT = process.env["MCP_PORT"] ?? "3001";
const MCP_BIND_HOST = process.env["MCP_BIND_HOST"] ?? "127.0.0.1";
const DATABASE = process.env["MONGODB_DATABASE"] ?? "cerberus";
const RUN_ID = randomUUID().slice(0, 8);

const MCP_ENTRY = join(root, "packages", "mcp-mongodb", "dist", "http-adapter.js");
const API_ENTRY = join(root, "apps", "api", "dist", "index.js");

for (const [label, entry] of [["mcp", MCP_ENTRY], ["api", API_ENTRY]]) {
  if (!existsSync(entry)) {
    console.error(
      `[cerberus] missing build output for ${label}: ${entry}\n` +
        "          run `npm run build` first.",
    );
    process.exit(1);
  }
}

const COLOR = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

function prefix(name, color) {
  const timestamp = new Date().toISOString().slice(11, 19);
  return `${color}[${timestamp} ${name}]${COLOR.reset}`;
}

/** @type {Map<string, import("node:child_process").ChildProcess>} */
const processes = new Map();

function launch(name, entry, env) {
  console.log(`${prefix(name, COLOR.cyan)} node ${entry}`);

  const child = spawn(process.execPath, [entry], {
    stdio: "pipe",
    env: { ...process.env, ...env },
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

  processes.set(name, child);
}

function cleanup() {
  console.log(`\n${prefix("manager", COLOR.yellow)} stopping all services...`);
  for (const [, child] of processes) {
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
${COLOR.bright}${COLOR.cyan}Cerberus — local runtime
  run:       ${RUN_ID}
  api:       http://localhost:${PORT}
  mcp:       http://${MCP_BIND_HOST}:${MCP_PORT}
  database:  ${DATABASE}
  health:    http://localhost:${PORT}/health
${COLOR.reset}`);

launch("mcp", MCP_ENTRY, {
  MCP_PORT,
  MCP_BIND_HOST,
  MONGODB_URI: process.env["MONGODB_URI"] ?? "mongodb://localhost:27017",
  MONGODB_DATABASE: DATABASE,
});

await new Promise((resolve) => setTimeout(resolve, 2000));

launch("api", API_ENTRY, {
  PORT,
  MCP_SERVER_ENDPOINT: `http://${MCP_BIND_HOST}:${MCP_PORT}`,
});

console.log(`${prefix("manager", COLOR.bright)} both services running — Ctrl+C to stop\n`);

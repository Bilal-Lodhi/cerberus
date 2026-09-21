#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Cerberus AI — Container Entrypoint
# Concurrently launches:
#   1. MCP Server (MongoDB Grounding Layer) on internal port 3001
#   2. Hono API (Gemini Agent Orchestrator) on external port $PORT (default 8080)
# ─────────────────────────────────────────────────────────────────────────────
set -e

PORT="${PORT:-8080}"
MCP_PORT="${MCP_PORT:-3001}"
NODE_ENV="${NODE_ENV:-production}"

echo "╔══════════════════════════════════════════════════╗"
echo "║  🦍 Cerberus AI v1.0.0                          ║"
echo "║  Environment:  $NODE_ENV                        ║"
echo "║  Hono API:     0.0.0.0:$PORT                   ║"
echo "║  MCP Server:   0.0.0.0:$MCP_PORT  (internal)    ║"
echo "╚══════════════════════════════════════════════════╝"

# ── Launch MCP Server (background, internal port) ────────────────────────
echo "[entrypoint] Starting MCP Server on port $MCP_PORT..."
MCP_PORT="$MCP_PORT" node ./mcp-server/dist/http-adapter.js &
MCP_PID=$!
echo "[entrypoint] MCP Server PID: $MCP_PID"

# Give the MCP server a moment to bind
sleep 2

# ── Launch Hono API (foreground, Cloud Run health-check port) ────────────
echo "[entrypoint] Starting Hono API on port $PORT..."
PORT="$PORT" MCP_SERVER_ENDPOINT="http://localhost:$MCP_PORT" node ./hono-api/dist/index.js &
HONO_PID=$!
echo "[entrypoint] Hono API PID: $HONO_PID"

# ── Signal handling: forward SIGTERM to both children ────────────────────
cleanup() {
    echo "[entrypoint] Received shutdown signal — terminating services..."
    kill -TERM "$HONO_PID" 2>/dev/null || true
    kill -TERM "$MCP_PID" 2>/dev/null || true
    wait "$HONO_PID" 2>/dev/null || true
    wait "$MCP_PID" 2>/dev/null || true
    echo "[entrypoint] All services stopped."
    exit 0
}

trap cleanup SIGTERM SIGINT

# Wait for either process to exit
wait -n "$HONO_PID" "$MCP_PID"
EXIT_CODE=$?

echo "[entrypoint] Process exited with code $EXIT_CODE — cleaning up..."
cleanup
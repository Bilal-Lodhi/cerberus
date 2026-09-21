#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Cerberus — container entrypoint
#
# Launches both services in one container:
#   1. MCP MongoDB adapter   → internal port $MCP_PORT (default 3001)
#   2. Cerberus API          → $PORT (default 8080), the published port
# ─────────────────────────────────────────────────────────────────────────────
set -e

PORT="${PORT:-8080}"
MCP_PORT="${MCP_PORT:-3001}"
MCP_BIND_HOST="${MCP_BIND_HOST:-127.0.0.1}"
NODE_ENV="${NODE_ENV:-production}"

echo "Cerberus"
echo "  environment: $NODE_ENV"
echo "  api:         $MCP_BIND_HOST:$PORT"
echo "  mcp:         $MCP_BIND_HOST:$MCP_PORT (internal)"

if [ "$NODE_ENV" = "production" ] && [ -z "$CERBERUS_API_KEY" ]; then
    echo "[entrypoint] FATAL: CERBERUS_API_KEY is not set." >&2
    echo "[entrypoint] Set it, or run with CERBERUS_DEV_MODE=true for local use only." >&2
    exit 1
fi

# ── MCP MongoDB adapter (background, internal) ───────────────────────────
echo "[entrypoint] starting MCP adapter on $MCP_BIND_HOST:$MCP_PORT"
MCP_PORT="$MCP_PORT" MCP_BIND_HOST="$MCP_BIND_HOST" \
    node ./packages/mcp-mongodb/dist/http-adapter.js &
MCP_PID=$!

# Wait for the adapter to bind.
sleep 2

# ── Cerberus API (foreground) ────────────────────────────────────────────
echo "[entrypoint] starting API on 0.0.0.0:$PORT"
PORT="$PORT" MCP_SERVER_ENDPOINT="http://$MCP_BIND_HOST:$MCP_PORT" \
    node ./apps/api/dist/index.js &
API_PID=$!

cleanup() {
    echo "[entrypoint] shutdown signal received — terminating services"
    kill -TERM "$API_PID" 2>/dev/null || true
    kill -TERM "$MCP_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
    wait "$MCP_PID" 2>/dev/null || true
    echo "[entrypoint] all services stopped"
    exit 0
}

trap cleanup SIGTERM SIGINT

# Exit as soon as either child exits.
wait -n "$API_PID" "$MCP_PID"
EXIT_CODE=$?

echo "[entrypoint] a service exited with code $EXIT_CODE — shutting down"
cleanup

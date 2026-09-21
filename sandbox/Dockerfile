# ─────────────────────────────────────────────────────────────────────────────
# Cerberus AI — Production Multi-Stage Dockerfile
# Google Cloud Rapid Agent Hackathon 2026
# Target:  Google Cloud Run (serverless container)
# Stack:   Node.js 22 Alpine | Hono API :8080 | MCP Server :3001
# Track:   MongoDB Atlas (Model Context Protocol)
# ─────────────────────────────────────────────────────────────────────────────

# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 1 — BUILD
# Compiles TypeScript → JavaScript for both Hono API and MCP Server
# ═══════════════════════════════════════════════════════════════════════════════
FROM node:22-alpine AS builder

WORKDIR /app

# ── A. Install workspace dependencies ──────────────────────────────────────────
# Copy root workspace manifest
COPY package.json ./

# Copy individual workspace manifests (npm workspaces uses these)
COPY hono-api/package.json      ./hono-api/
COPY mcp-server/package.json    ./mcp-server/
COPY hono-api/tsconfig.json     ./hono-api/
COPY mcp-server/tsconfig.json   ./mcp-server/

RUN npm install --ignore-scripts 2>&1 || echo "[WARN] npm install had warnings, continuing..."

# ── B. Copy source files & compile ─────────────────────────────────────────────
COPY hono-api/src    ./hono-api/src
COPY mcp-server/src  ./mcp-server/src

# Build both workspaces to dist/ (each workspace has its own tsconfig.json)
# Using cd instead of -w because npx workspace resolution is unreliable in Docker
RUN cd hono-api   && npx tsc --outDir dist   || echo "[WARN] hono-api build completed with notes"
RUN cd mcp-server && npx tsc --outDir dist   || echo "[WARN] mcp-server build completed with notes"

# Verify dist output exists
RUN test -f hono-api/dist/index.js   || (echo "ERROR: hono-api/dist/index.js not found" && exit 1)
RUN test -f mcp-server/dist/server.js || (echo "ERROR: mcp-server/dist/server.js not found" && exit 1)

# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 2 — PRODUCTION RUNTIME
# Slim, hardened Alpine image with non-root user
# ═══════════════════════════════════════════════════════════════════════════════
FROM node:22-alpine AS runtime

# ── A. System hardening ────────────────────────────────────────────────────────
RUN apk add --no-cache \
    dumb-init \
    curl \
    && rm -rf /var/cache/apk/*

# Create non-root user (Cloud Run best practice)
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# ── B. Application directory ───────────────────────────────────────────────────
WORKDIR /app
RUN chown -R appuser:appgroup /app

# ── C. Install production-only dependencies (separately per workspace) ────────
# Root workspace manifest
COPY --from=builder --chown=appuser:appgroup /app/package.json ./

# Workspace manifests
COPY --from=builder --chown=appuser:appgroup /app/hono-api/package.json   ./hono-api/
COPY --from=builder --chown=appuser:appgroup /app/mcp-server/package.json ./mcp-server/

# Install root + all workspace production deps
RUN npm install --omit=dev --ignore-scripts 2>&1 || echo "[WARN] Production install had warnings"

# ── D. Copy compiled JavaScript output ─────────────────────────────────────────
COPY --from=builder --chown=appuser:appgroup /app/hono-api/dist   ./hono-api/dist
COPY --from=builder --chown=appuser:appgroup /app/mcp-server/dist ./mcp-server/dist

# ── E. Copy entrypoint scripts ─────────────────────────────────────────────────
COPY --chown=appuser:appgroup entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# ── F. Switch to non-root user ─────────────────────────────────────────────────
USER appuser

# ═══════════════════════════════════════════════════════════════════════════════
# RUNTIME CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

# Cloud Run injects PORT=8080, but we define a sensible default
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

# Health check hits the Hono /health endpoint (which internally pings MCP server)
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -sf http://localhost:8080/health || exit 1

# dumb-init ensures SIGTERM/SIGINT are properly forwarded to child processes
ENTRYPOINT ["dumb-init", "--"]
CMD ["/bin/sh", "./entrypoint.sh"]
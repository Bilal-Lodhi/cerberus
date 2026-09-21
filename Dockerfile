# ─────────────────────────────────────────────────────────────────────────────
# Cerberus — multi-stage container build
#
# Stage 1 compiles TypeScript for both workspaces.
# Stage 2 is a slim, non-root runtime that serves:
#   - the Cerberus API            on :8080
#   - the MCP MongoDB adapter     on :3001 (internal)
#
# The operator console (apps/console) is a Flutter application and is built
# separately; see docs/architecture.md.
# ─────────────────────────────────────────────────────────────────────────────

# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 1 — BUILD
# ═══════════════════════════════════════════════════════════════════════════════
FROM node:22-alpine AS builder

WORKDIR /app

# Root workspace manifest + lockfile
COPY package.json package-lock.json ./
COPY apps/api/package.json           ./apps/api/
COPY packages/mcp-mongodb/package.json ./packages/mcp-mongodb/
COPY apps/api/tsconfig.json          ./apps/api/
COPY packages/mcp-mongodb/tsconfig.json ./packages/mcp-mongodb/
COPY tsconfig.json ./

RUN npm ci --ignore-scripts

# Sources
COPY apps/api/src           ./apps/api/src
COPY packages/mcp-mongodb/src ./packages/mcp-mongodb/src

RUN npm run build

# Fail the build early if either entrypoint is missing.
RUN test -f apps/api/dist/index.js || (echo "ERROR: apps/api/dist/index.js missing" && exit 1)
RUN test -f packages/mcp-mongodb/dist/http-adapter.js || (echo "ERROR: packages/mcp-mongodb/dist/http-adapter.js missing" && exit 1)

# ═══════════════════════════════════════════════════════════════════════════════
# STAGE 2 — RUNTIME
# ═══════════════════════════════════════════════════════════════════════════════
FROM node:22-alpine AS runtime

RUN apk add --no-cache dumb-init curl && rm -rf /var/cache/apk/*

# Run as a non-root user.
RUN addgroup -S cerberus && adduser -S cerberus -G cerberus

WORKDIR /app
RUN chown -R cerberus:cerberus /app

# Manifests for a production-only install.
COPY --from=builder --chown=cerberus:cerberus /app/package.json     ./package.json
COPY --from=builder --chown=cerberus:cerberus /app/package-lock.json ./package-lock.json
COPY --from=builder --chown=cerberus:cerberus /app/apps/api/package.json           ./apps/api/package.json
COPY --from=builder --chown=cerberus:cerberus /app/packages/mcp-mongodb/package.json ./packages/mcp-mongodb/package.json

RUN npm ci --omit=dev --ignore-scripts

# Compiled output.
COPY --from=builder --chown=cerberus:cerberus /app/apps/api/dist           ./apps/api/dist
COPY --from=builder --chown=cerberus:cerberus /app/packages/mcp-mongodb/dist ./packages/mcp-mongodb/dist

COPY --chown=cerberus:cerberus scripts/entrypoint.sh ./scripts/entrypoint.sh
RUN chmod +x ./scripts/entrypoint.sh

USER cerberus

ENV PORT=8080
ENV MCP_PORT=3001
ENV MCP_BIND_HOST=127.0.0.1
ENV NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -sf "http://localhost:${PORT}/health" || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["/bin/sh", "./scripts/entrypoint.sh"]

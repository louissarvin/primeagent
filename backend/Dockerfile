# syntax=docker/dockerfile:1.7
# PrimeAgent backend image. Matches PrimeAgent.md Section 20 + IMPLEMENTATION_PLAN.md Feature I.
#
# Goals:
#   - oven/bun:1-alpine base (small runtime, < 150 MB final).
#   - Multi-stage build: deps -> build -> runtime.
#   - bun install --frozen-lockfile (reproducible).
#   - bunx prisma generate runs at build time.
#   - Final image runs as non-root (the upstream "bun" user, UID 1000).
#   - HEALTHCHECK against the existing /health endpoint.
#
# Build:   docker build -t primeagent-backend:dev .
# Run:     docker run --rm -p 3000:3000 --env-file .env primeagent-backend:dev

# ──────────────────────────────────────────────────────────────────────────────
# Stage 1: install dependencies. devDeps included so prisma CLI is available.
# ──────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app
# bun.lockb is a binary lockfile; bun.lock (text v2) is also possible. Copy
# whichever exists. The wildcard tolerates either form.
COPY package.json bun.lock* bun.lockb* tsconfig.json ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2: build. Runs prisma generate so the Prisma client is materialised
# into node_modules before we strip the image.
# ──────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS build
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY . .
RUN bunx prisma generate --config prisma/prisma.config.ts

# ──────────────────────────────────────────────────────────────────────────────
# Stage 3: runtime. Small surface area. Only the artifacts needed to run.
# ──────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# wget is needed for the HEALTHCHECK; alpine ships busybox-wget by default,
# so no apk add needed. tini is recommended for proper signal handling.
RUN apk add --no-cache tini

COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/prisma ./prisma
COPY --from=build --chown=bun:bun /app/src ./src
COPY --from=build --chown=bun:bun /app/index.ts ./index.ts
COPY --from=build --chown=bun:bun /app/dotenv.ts ./dotenv.ts
COPY --from=build --chown=bun:bun /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=bun:bun /app/package.json ./package.json

USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "run", "index.ts"]

# ---- Build stage ----------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Install dependencies first so this layer caches across code changes.
COPY package.json package-lock.json* ./
# `npm ci` when a lockfile exists (reproducible), `npm install` on first run.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .
RUN npm run build

# Drop dev dependencies from node_modules before copying to the runtime image.
RUN npm prune --omit=dev

# ---- Runtime stage --------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5000

# Run as a non-root user.
USER node

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Invoked directly rather than through npm so signals reach Node itself.
CMD ["node", "--enable-source-maps", "dist/server/index.js"]

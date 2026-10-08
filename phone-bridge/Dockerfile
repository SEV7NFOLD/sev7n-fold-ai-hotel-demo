# syntax=docker/dockerfile:1

# Ava Phone Bridge container image.
# Used by Render's Docker deploy path, and works on Fly.io / Railway / any container host.
#
# Why a container rather than Render's native Node runtime:
#   - the bridge must stay alive holding long-lived WebSockets; an explicit start command
#     and health check make that unambiguous
#   - the build step is TypeScript compilation, which we want pinned

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the runtime image.
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Render sets PORT; 8080 is the documented default for local container runs.
ENV PORT=8080

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Run unprivileged.
USER node

EXPOSE 8080

# Render performs its own health check against /health; this is for other hosts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]

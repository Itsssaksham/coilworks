# Multi-stage: the client is built with its dev dependencies, then only the
# built assets and the server's production dependencies reach the final image.

# ---- stage 1: build the client ------------------------------------------
FROM node:22-alpine AS client-build
WORKDIR /app

# Copy manifests first so the dependency layer is cached across source edits.
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN npm ci

COPY client ./client
RUN npm run build --workspace client

# ---- stage 2: server dependencies ---------------------------------------
FROM node:22-alpine AS server-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
# --omit=dev keeps vite, esbuild and the rest of the toolchain out of the image.
RUN npm ci --omit=dev

# ---- stage 3: runtime ----------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV CLIENT_DIST=/app/client/dist

COPY --from=server-deps /app/node_modules ./node_modules
COPY --from=server-deps /app/package.json ./package.json
COPY server ./server
COPY --from=client-build /app/client/dist ./client/dist

# Run unprivileged. The node image ships a `node` user for exactly this.
RUN chown -R node:node /app
USER node

EXPOSE 4000

# Probes whatever port the app actually bound, which on a managed platform is
# assigned via PORT rather than fixed at 4000.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.API_PORT||process.env.PORT||4000;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/server
CMD ["node", "src/index.js"]

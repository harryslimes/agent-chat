# ---- build: compile + bundle into a single file ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc --noEmit && npm run bundle

# ---- runtime: just node + one JS file, no node_modules ----
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/agent-chat.db \
    NODE_OPTIONS="--max-old-space-size=48 --max-semi-space-size=1"
WORKDIR /app
COPY --from=build /app/build/server.mjs ./server.mjs
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]

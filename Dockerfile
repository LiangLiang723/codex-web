# syntax=docker/dockerfile:1
FROM node:24-bookworm AS web
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends python3 git && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY . .
RUN pnpm --filter . --filter @zcode/web... install --frozen-lockfile --ignore-scripts --child-concurrency=1
RUN pnpm --filter @zcode/web exec vite build --mode selfhost && node selfhost/worker/build.mjs /release/workspace.cjs
RUN python3 selfhost/gateway/materialize.py /gateway && mkdir -p /gateway/public && cp -a packages/web/dist/. /gateway/public/
RUN find /gateway/public -name '*.map' -delete

FROM node:24-bookworm AS service
WORKDIR /api
COPY --from=web /gateway/ ./
RUN npm ci --no-audit --no-fund && npm run build

FROM node:24-bookworm-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=service /api/.output ./.output
COPY --from=web /release/ ./selfhost-assets/
COPY selfhost/create-user.mjs ./scripts/create-user.mjs
COPY selfhost/upstreams.lock.json LICENSE NOTICE.md THIRD-PARTY-NOTICES.md ./licenses/
COPY upstream/codex-gateway/LICENSE ./licenses/Codex-Gateway-LICENSE
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","--max-old-space-size=512",".output/server/index.mjs"]

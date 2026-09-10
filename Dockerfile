ARG NODE_VERSION=22.22.3
FROM node:${NODE_VERSION}-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build:node

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG VCS_REF
LABEL org.opencontainers.image.source="https://github.com/marcelusfernandes/md-colab" \
      org.opencontainers.image.revision="${VCS_REF}"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    MD_COLAB_DB_PATH=/data/md-colab.sqlite \
    MD_COLAB_SERVER_ENTRY=server.js

WORKDIR /app
COPY --from=build --chown=node:node /app/dist/standalone/ ./
COPY --from=build --chown=node:node /app/package.json /app/ops/package.json
COPY --from=build --chown=node:node /app/scripts/node-db.ts /app/ops/scripts/node-db.ts
COPY --from=build --chown=node:node /app/scripts/start-node.ts /app/ops/scripts/start-node.ts
COPY --from=build --chown=node:node /app/lib/node-d1.ts /app/ops/lib/node-d1.ts
COPY --from=build --chown=node:node /app/lib/node-migrations.ts /app/ops/lib/node-migrations.ts
COPY --from=build --chown=node:node /app/lib/node-operations.ts /app/ops/lib/node-operations.ts
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "--experimental-transform-types", "ops/scripts/start-node.ts"]

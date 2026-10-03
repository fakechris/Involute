FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ARG DATABASE_URL=postgresql://involute:involute@127.0.0.1:5434/involute?schema=public
ENV DATABASE_URL=$DATABASE_URL

WORKDIR /app

RUN corepack enable
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./

COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/web/package.json packages/web/package.json

# onnxruntime-node ships every platform's binaries; Linux images need only Linux's.
# The pnpm store goes in the same layer: node_modules hard-links its files, so
# keeping the store would carry a second copy of every package (and of the
# binaries just removed) in the image.
RUN pnpm install --frozen-lockfile \
  && rm -rf node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*/darwin \
            node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*/win32 \
  && rm -rf "$(pnpm store path)"

COPY . .

# Local release builders pass the source SHA; unknown remains explicit otherwise.
ARG INVOLUTE_BUILD_SHA
ENV INVOLUTE_BUILD_SHA=$INVOLUTE_BUILD_SHA

FROM base AS server

RUN pnpm --filter @turnkeyai/involute-server build
# Semantic search (INV-927): the model ships in the image, so the server never
# downloads at runtime. INVOLUTE_EMBEDDINGS=off in the environment turns it off.
# Another model is a build argument, so the one baked in and the one the
# server loads are always the same.
ARG EMBEDDING_MODEL=Xenova/multilingual-e5-small
RUN cd packages/server && node scripts/fetch-embedding-model.mjs /app/models "$EMBEDDING_MODEL"
ENV INVOLUTE_EMBEDDINGS=local
ENV INVOLUTE_MODEL_DIR=/app/models
ENV INVOLUTE_EMBEDDING_MODEL=$EMBEDDING_MODEL
COPY packages/server/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 4200

ENTRYPOINT ["/app/docker-entrypoint.sh"]

FROM base AS web-dev

RUN pnpm --filter @turnkeyai/involute-shared build

EXPOSE 4201

CMD ["pnpm", "--filter", "@turnkeyai/involute-web", "exec", "vite", "--host", "0.0.0.0", "--port", "4201"]

FROM base AS web-build

ARG VITE_INVOLUTE_GRAPHQL_URL
ENV VITE_INVOLUTE_GRAPHQL_URL=${VITE_INVOLUTE_GRAPHQL_URL:-/graphql}

RUN pnpm --filter @turnkeyai/involute-web build

FROM nginx:1.27-alpine AS web

RUN apk add --no-cache curl

COPY packages/web/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=web-build /app/packages/web/dist /usr/share/nginx/html

EXPOSE 4201

CMD ["nginx", "-g", "daemon off;"]

FROM base AS cli

RUN pnpm --filter @turnkeyai/involute-server build && pnpm --filter @turnkeyai/involute build

ENTRYPOINT ["node", "packages/cli/dist/index.js"]
CMD ["--help"]

# Single-container deployment: API + migrations + the built web app served by
# the API process (INVOLUTE_WEB_DIST). Requires an external Postgres.
FROM base AS aio

RUN pnpm --filter @turnkeyai/involute-server build && pnpm --filter @turnkeyai/involute-web build

ENV INVOLUTE_WEB_DIST=/app/packages/web/dist
ENV VITE_INVOLUTE_GRAPHQL_URL=/graphql

COPY packages/server/docker-entrypoint-aio.sh /app/docker-entrypoint-aio.sh
RUN chmod +x /app/docker-entrypoint-aio.sh

EXPOSE 4200

ENTRYPOINT ["/app/docker-entrypoint-aio.sh"]

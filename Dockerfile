FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN corepack enable
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/web/package.json packages/web/package.json

RUN pnpm install --frozen-lockfile

COPY . .

FROM base AS server

RUN pnpm --filter @involute/server build
COPY packages/server/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 4200

ENTRYPOINT ["/app/docker-entrypoint.sh"]

FROM base AS web-dev

EXPOSE 4201

CMD ["pnpm", "--filter", "@involute/web", "exec", "vite", "--host", "0.0.0.0", "--port", "4201"]

FROM base AS web-build

ARG VITE_INVOLUTE_GRAPHQL_URL=http://localhost:4200/graphql
ENV VITE_INVOLUTE_GRAPHQL_URL=$VITE_INVOLUTE_GRAPHQL_URL

RUN pnpm --filter @involute/web build

FROM nginx:1.27-alpine AS web

COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/packages/web/dist /usr/share/nginx/html

EXPOSE 4201

CMD ["nginx", "-g", "daemon off;"]

FROM base AS cli

RUN pnpm --filter @involute/server build && pnpm --filter @involute/cli build

ENTRYPOINT ["node", "packages/cli/dist/index.js"]
CMD ["--help"]

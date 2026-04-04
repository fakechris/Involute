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

EXPOSE 4200

CMD ["sh", "-lc", "pnpm --filter @involute/server exec prisma db push --skip-generate && if [ \"${SEED_DATABASE:-false}\" = \"true\" ]; then pnpm --filter @involute/server exec prisma db seed; fi && node packages/server/dist/index.js"]

FROM base AS web

EXPOSE 4201

CMD ["pnpm", "--filter", "@involute/web", "exec", "vite", "--host", "0.0.0.0", "--port", "4201"]

FROM base AS cli

RUN pnpm --filter @involute/server build && pnpm --filter @involute/cli build

ENTRYPOINT ["node", "packages/cli/dist/index.js"]
CMD ["--help"]

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

WORKDIR /app/packages/server

EXPOSE 4200

CMD ["sh", "-lc", "pnpm exec prisma db push --skip-generate && node dist/index.js"]

FROM base AS web

RUN pnpm --filter @involute/shared build

WORKDIR /app/packages/web

EXPOSE 4201

CMD ["sh", "-lc", "pnpm exec vite --host 0.0.0.0 --port 4201"]

FROM base AS cli

RUN pnpm --filter @involute/cli build

WORKDIR /app/packages/cli

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--help"]

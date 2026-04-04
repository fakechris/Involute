#!/bin/sh
set -e

pnpm --filter @involute/server exec prisma db push --skip-generate

if [ "${SEED_DATABASE:-false}" = "true" ]; then
  pnpm --filter @involute/server exec prisma db seed
fi

exec node packages/server/dist/index.js

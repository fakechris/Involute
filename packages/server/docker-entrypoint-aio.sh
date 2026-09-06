#!/bin/sh
# AIO entrypoint: apply migrations, then serve API + web from one process.
set -e

if [ "${AIO_SKIP_MIGRATE}" != "true" ]; then
  cd /app/packages/server
  pnpm exec prisma migrate deploy
  cd /app
fi

exec node packages/server/dist/index.js

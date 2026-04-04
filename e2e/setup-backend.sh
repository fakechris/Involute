#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
COMPOSE_PROJECT_NAME="${E2E_COMPOSE_PROJECT:-involute-e2e}"
DB_PORT="${E2E_DB_PORT:-5544}"
DATABASE_URL="${E2E_DATABASE_URL:-postgresql://involute:involute@127.0.0.1:${DB_PORT}/involute?schema=public}"
AUTH_TOKEN="${E2E_AUTH_TOKEN:-e2e-auth-token}"
VIEWER_ASSERTION_SECRET="${E2E_VIEWER_ASSERTION_SECRET:-e2e-viewer-assertion-secret}"
SERVER_PORT="${E2E_SERVER_PORT:-4300}"

export COMPOSE_PROJECT_NAME
export DB_PORT

cd "$ROOT_DIR"

docker compose up -d db

attempt=1
while [ "$attempt" -le 30 ]; do
  if docker compose exec -T db pg_isready -U involute -d involute >/dev/null 2>&1; then
    break
  fi

  if [ "$attempt" -eq 30 ]; then
    echo "E2E database did not become ready" >&2
    exit 1
  fi

  attempt=$((attempt + 1))
  sleep 2
done

DATABASE_URL="$DATABASE_URL" pnpm --filter @involute/server exec prisma db push --force-reset --skip-generate
DATABASE_URL="$DATABASE_URL" pnpm --filter @involute/server exec prisma db seed

exec env \
  DATABASE_URL="$DATABASE_URL" \
  AUTH_TOKEN="$AUTH_TOKEN" \
  VIEWER_ASSERTION_SECRET="$VIEWER_ASSERTION_SECRET" \
  PORT="$SERVER_PORT" \
  pnpm --filter @involute/server exec tsx src/index.ts

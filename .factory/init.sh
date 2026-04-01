#!/usr/bin/env bash
set -euo pipefail

cd /Users/chris/workspace/Involute

# Verify postgres is accessible
if ! docker exec sub2api-postgres psql -U sub2api -d involute -c "SELECT 1" &>/dev/null; then
  echo "ERROR: Cannot connect to postgres. Ensure sub2api-postgres container is running."
  echo "Try: docker start sub2api-postgres"
  exit 1
fi

# Install dependencies if node_modules is missing or package.json changed
if [ -f package.json ]; then
  if [ ! -d node_modules ] || [ package.json -nt node_modules/.package-lock.json ] 2>/dev/null; then
    pnpm install --frozen-lockfile 2>/dev/null || pnpm install
  fi
fi

# Generate Prisma client if schema exists
if [ -f packages/server/prisma/schema.prisma ]; then
  cd packages/server
  npx prisma generate 2>/dev/null || true
  npx prisma db push --accept-data-loss 2>/dev/null || npx prisma migrate deploy 2>/dev/null || true
  cd /Users/chris/workspace/Involute
fi

# Create .env if it doesn't exist
if [ ! -f .env ]; then
  PGPASSWORD=$(docker inspect sub2api-postgres --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep POSTGRES_PASSWORD | cut -d= -f2)
  cat > .env <<EOF
DATABASE_URL=postgresql://sub2api:${PGPASSWORD}@sub2api-postgres.orb.local:5432/involute
AUTH_TOKEN=changeme-set-your-token
PORT=4200
EOF
  echo "Created .env with database connection"
fi

echo "Init complete."

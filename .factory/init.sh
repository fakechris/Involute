#!/usr/bin/env bash
set -euo pipefail

cd /Users/chris/workspace/Involute

# Verify postgres is accessible
if ! docker exec sub2api-postgres psql -U sub2api -d involute -c "SELECT 1" &>/dev/null; then
  echo "ERROR: Cannot connect to postgres. Ensure sub2api-postgres container is running."
  echo "Try: docker start sub2api-postgres"
  exit 1
fi

# Ensure local proxy is running on an allowed mission port
if ! docker inspect involute-pg-proxy &>/dev/null || [ "$(docker inspect -f '{{.State.Running}}' involute-pg-proxy 2>/dev/null)" != "true" ]; then
  docker rm -f involute-pg-proxy &>/dev/null || true
  docker run -d --name involute-pg-proxy --network sub2api-deploy_sub2api-network -p 4202:4202 \
    postgres:18-alpine sh -lc "nc -lk -p 4202 -e nc sub2api-postgres 5432" &>/dev/null
fi

if ! python3 - <<'PY'
import socket

sock = socket.socket()
sock.settimeout(2)

try:
    sock.connect(("127.0.0.1", 4202))
finally:
    sock.close()
PY
then
  echo "ERROR: Cannot connect to local postgres proxy on 127.0.0.1:4202."
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
PGPASSWORD=$(docker inspect sub2api-postgres --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep POSTGRES_PASSWORD | cut -d= -f2)
ENCODED_PGPASSWORD=$(RAW_PASSWORD="$PGPASSWORD" python3 - <<'PY'
import os
from urllib.parse import quote

print(quote(os.environ["RAW_PASSWORD"], safe=""))
PY
)
DATABASE_URL_VALUE="postgresql://sub2api:${ENCODED_PGPASSWORD}@127.0.0.1:4202/involute"

if [ ! -f .env ]; then
  cat > .env <<EOF
DATABASE_URL=${DATABASE_URL_VALUE}
AUTH_TOKEN=changeme-set-your-token
PORT=4200
EOF
  echo "Created .env with database connection"
else
  DATABASE_URL_VALUE="$DATABASE_URL_VALUE" python3 - <<'PY'
import os
from pathlib import Path

path = Path(".env")
lines = path.read_text().splitlines()
updated = []
found = False

for line in lines:
    if line.startswith("DATABASE_URL="):
        updated.append(f"DATABASE_URL={os.environ['DATABASE_URL_VALUE']}")
        found = True
    else:
        updated.append(line)

if not found:
    updated.insert(0, f"DATABASE_URL={os.environ['DATABASE_URL_VALUE']}")

path.write_text("\n".join(updated) + "\n")
PY
fi

echo "Init complete."

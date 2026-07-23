#!/bin/sh
set -eu

# Involute production deployment script
# Usage: scripts/deploy.sh [server-host]

SERVER="${1:-100.107.81.37}"
REMOTE_DIR="/opt/involute"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="${SCRIPT_DIR}/.."

echo "=== Step 1: Build frontend ==="
cd "$ROOT_DIR"
VITE_INVOLUTE_GRAPHQL_URL=/graphql pnpm --filter @turnkeyai/involute-web build

echo ""
echo "=== Step 2: Smoke test (localhost leak check) ==="
if grep -r 'localhost:4200' packages/web/dist --include='*.js' -l 2>/dev/null; then
  echo "ERROR: JS bundles contain localhost:4200. Aborting." >&2
  exit 1
fi
echo "PASS: no localhost:4200 in bundles."

echo ""
echo "=== Step 3: Sync to server (excluding .env) ==="
rsync -avz \
  --exclude node_modules \
  --exclude .git \
  --exclude .env \
  "$ROOT_DIR/" "root@${SERVER}:${REMOTE_DIR}/"

echo ""
echo "=== Step 4: Rebuild and restart Docker ==="
ssh "root@${SERVER}" "cd ${REMOTE_DIR} && docker compose build --no-cache web && docker compose up -d"

echo ""
echo "=== Step 5: Wait for startup ==="
sleep 15

echo ""
echo "=== Step 6: Verify ==="
STATUS=$(curl -s -o /dev/null -w "%{http_code}" https://involute.edai100.com/)
if [ "$STATUS" = "200" ]; then
  echo "PASS: involute.edai100.com returned $STATUS"
else
  echo "FAIL: involute.edai100.com returned $STATUS" >&2
  exit 1
fi

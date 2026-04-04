#!/bin/sh
set -eu

AUTH_TOKEN="${E2E_AUTH_TOKEN:-e2e-auth-token}"
SERVER_PORT="${E2E_SERVER_PORT:-4300}"
WEB_PORT="${E2E_WEB_PORT:-4301}"

exec env \
  VITE_INVOLUTE_AUTH_TOKEN="$AUTH_TOKEN" \
  VITE_INVOLUTE_GRAPHQL_URL="http://127.0.0.1:${SERVER_PORT}/graphql" \
  pnpm --filter @involute/web exec vite --host 127.0.0.1 --port "$WEB_PORT"

#!/bin/sh
set -eu

AUTH_TOKEN="${E2E_AUTH_TOKEN:-e2e-auth-token}"
SERVER_PORT="${E2E_SERVER_PORT:-4300}"
WEB_PORT="${E2E_WEB_PORT:-4301}"
VIEWER_ASSERTION_SECRET="${E2E_VIEWER_ASSERTION_SECRET:-e2e-viewer-assertion-secret}"
VIEWER_EMAIL="${E2E_VIEWER_EMAIL:-admin@involute.local}"
VIEWER_ASSERTION="${E2E_VIEWER_ASSERTION:-$(
  VIEWER_ASSERTION_SECRET="$VIEWER_ASSERTION_SECRET" VIEWER_EMAIL="$VIEWER_EMAIL" node --input-type=module <<'EOF'
import { createHmac } from 'node:crypto';

const secret = process.env.VIEWER_ASSERTION_SECRET;
const email = process.env.VIEWER_EMAIL;

if (!secret || !email) {
  process.exit(1);
}

const payload = Buffer.from(
  JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: email,
    subType: 'email',
  }),
  'utf8',
).toString('base64url');
const signature = createHmac('sha256', secret).update(payload).digest('base64url');

process.stdout.write(`${payload}.${signature}`);
EOF
)}"

exec env \
  VITE_INVOLUTE_AUTH_TOKEN="$AUTH_TOKEN" \
  VITE_INVOLUTE_GRAPHQL_URL="http://127.0.0.1:${SERVER_PORT}/graphql" \
  VITE_INVOLUTE_VIEWER_ASSERTION="$VIEWER_ASSERTION" \
  pnpm --filter @involute/web exec vite --host 127.0.0.1 --port "$WEB_PORT"

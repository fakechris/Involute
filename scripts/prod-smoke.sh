#!/bin/sh
set -eu

# ---------- Build-artifact safety check ----------
# Scan built JS bundles to ensure no localhost:4200 leaked into production.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_DIST="${SCRIPT_DIR}/../packages/web/dist"

if [ -d "$WEB_DIST" ]; then
  if grep -r 'localhost:4200' "$WEB_DIST" --include='*.js' -l 2>/dev/null; then
    echo "ERROR: Production JS bundles contain 'localhost:4200'." >&2
    echo "This means VITE_INVOLUTE_GRAPHQL_URL was not set or the build picked up a dev default." >&2
    exit 1
  fi
  echo "Build-artifact check passed: no localhost:4200 found in JS bundles."
fi

# ---------- Live endpoint smoke tests ----------
BASE_URL="${1:-${INVOLUTE_SMOKE_BASE_URL:-}}"

if [ -z "$BASE_URL" ]; then
  echo "Usage: scripts/prod-smoke.sh <base-url>" >&2
  exit 2
fi

BASE_URL="${BASE_URL%/}"

curl --connect-timeout 5 --max-time 15 -fsS "$BASE_URL/health" >/dev/null

SESSION_RESPONSE="$(mktemp)"
SESSION_STATUS="$(
  curl --connect-timeout 5 --max-time 15 -sS -o "$SESSION_RESPONSE" -w '%{http_code}' \
    "$BASE_URL/auth/session"
)"
case "$SESSION_STATUS" in
  200|401) ;;
  *)
    echo "auth/session returned unexpected status: $SESSION_STATUS" >&2
    cat "$SESSION_RESPONSE" >&2
    rm -f "$SESSION_RESPONSE"
    exit 1
    ;;
esac
SESSION_PAYLOAD="$(cat "$SESSION_RESPONSE")"
rm -f "$SESSION_RESPONSE"
printf '%s' "$SESSION_PAYLOAD" | python3 -c '
import json
import sys

payload = json.load(sys.stdin)
if payload.get("googleOAuthConfigured") is not True:
    raise SystemExit("auth/session did not report googleOAuthConfigured=true")
'

GOOGLE_START_STATUS="$(
  curl --connect-timeout 5 --max-time 15 -sS -o /dev/null -w '%{http_code} %{redirect_url}' \
    "$BASE_URL/auth/google/start"
)"

case "$GOOGLE_START_STATUS" in
  "302 https://accounts.google.com/"*) ;;
  *)
    echo "auth/google/start did not redirect to Google: $GOOGLE_START_STATUS" >&2
    exit 1
    ;;
esac

printf 'Production smoke passed for %s\n' "$BASE_URL"

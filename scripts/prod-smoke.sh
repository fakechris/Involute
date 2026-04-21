#!/bin/sh
set -eu

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

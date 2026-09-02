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
MCP_TOKEN="${INVOLUTE_SMOKE_AUTH_TOKEN:-${AUTH_TOKEN:-}}"

if [ -z "$BASE_URL" ]; then
  echo "Usage: scripts/prod-smoke.sh <base-url>" >&2
  exit 2
fi

if [ -z "$MCP_TOKEN" ]; then
  echo "Set INVOLUTE_SMOKE_AUTH_TOKEN to run the authenticated MCP smoke." >&2
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

MCP_RESPONSE="$(mktemp)"
cleanup_mcp_response() {
  rm -f "$MCP_RESPONSE"
}
trap cleanup_mcp_response EXIT INT TERM

mcp_call() {
  payload="$1"
  curl --connect-timeout 5 --max-time 15 -fsS \
    -H "Authorization: Bearer $MCP_TOKEN" \
    -H 'Content-Type: application/json' \
    --data "$payload" \
    "$BASE_URL/mcp/readonly" > "$MCP_RESPONSE"
}

mcp_call '{"jsonrpc":"2.0","id":"smoke-initialize","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"involute-prod-smoke","version":"1"}}}'
python3 - "$MCP_RESPONSE" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)
if payload.get("result", {}).get("serverInfo", {}).get("name") != "involute":
    raise SystemExit(f"MCP initialize returned an unexpected payload: {payload}")
PY

mcp_call '{"jsonrpc":"2.0","id":"smoke-tools","method":"tools/list","params":{}}'
python3 - "$MCP_RESPONSE" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)
names = {tool.get("name") for tool in payload.get("result", {}).get("tools", [])}
required = {"work_search", "work_get_context", "work_list_ready"}
if not required.issubset(names):
    raise SystemExit(f"MCP tools/list is missing read tools: {sorted(required - names)}")
PY

mcp_call '{"jsonrpc":"2.0","id":"smoke-search","method":"tools/call","params":{"name":"work_search","arguments":{"query":"__involute_smoke_no_match__","first":1}}}'
python3 - "$MCP_RESPONSE" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)
if "error" in payload or not payload.get("result", {}).get("content"):
    raise SystemExit(f"MCP work_search failed: {payload}")
PY

printf 'Production smoke passed for %s\n' "$BASE_URL"

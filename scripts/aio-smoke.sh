#!/bin/sh
# Container-level smoke for the AIO image: health, readiness, machine docs,
# and authenticated GraphQL + MCP round-trips. Does not require OAuth; the
# full prod-smoke (with Google OAuth assertions) runs against real deploys.
set -eu

BASE_URL="${1:-http://127.0.0.1:4200}"
TOKEN="${AIO_SMOKE_AUTH_TOKEN:?Set AIO_SMOKE_AUTH_TOKEN}"
BASE_URL="${BASE_URL%/}"

expect_status() {
  status="$(curl --connect-timeout 5 --max-time 15 -sS -o /dev/null -w '%{http_code}' "$1")"
  if [ "$status" != "$2" ]; then
    echo "$1 returned $status, expected $2" >&2
    exit 1
  fi
}

expect_status "$BASE_URL/health" 200
expect_status "$BASE_URL/ready" 200
expect_status "$BASE_URL/llms.txt" 200

curl -fsS --max-time 15 "$BASE_URL/llms.txt" | grep -q 'protocol_get_guide' || {
  echo "/llms.txt does not mention protocol_get_guide" >&2
  exit 1
}

GRAPHQL_RESPONSE="$(mktemp)"
trap 'rm -f "$GRAPHQL_RESPONSE"' EXIT
curl -fsS --max-time 15 \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data '{"query":"query { teams { nodes { key } } }"}' \
  "$BASE_URL/graphql" > "$GRAPHQL_RESPONSE"
python3 - "$GRAPHQL_RESPONSE" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
if "errors" in payload or "nodes" not in payload.get("data", {}).get("teams", {}):
    raise SystemExit(f"GraphQL teams query failed: {payload}")
PY

MCP_RESPONSE="$(mktemp)"
curl -fsS --max-time 15 \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":"aio-init","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"aio-smoke","version":"1"}}}' \
  "$BASE_URL/mcp/readonly" > "$MCP_RESPONSE"
python3 - "$MCP_RESPONSE" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
if payload.get("result", {}).get("serverInfo", {}).get("name") != "involute":
    raise SystemExit(f"MCP initialize returned an unexpected payload: {payload}")
PY

curl -fsS --max-time 15 \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":"aio-tools","method":"tools/call","params":{"name":"protocol_get_guide","arguments":{}}}' \
  "$BASE_URL/mcp/readonly" | grep -q 'Run complete is not work accepted' || {
  echo "protocol_get_guide did not return the work protocol" >&2
  exit 1
}

printf 'AIO smoke passed for %s\n' "$BASE_URL"

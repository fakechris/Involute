#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.prod.images.yml}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/.backups}"
OUTPUT_FILE="${OUTPUT_FILE:-$OUTPUT_DIR/involute-$TIMESTAMP.sql.gz}"

mkdir -p "$OUTPUT_DIR"
TEMP_FILE="$(mktemp "$OUTPUT_DIR/involute-$TIMESTAMP.XXXXXX.sql")"

cleanup() {
  rm -f "$TEMP_FILE"
}

trap cleanup EXIT INT TERM

docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  exec -T db pg_dump -U "${POSTGRES_USER:-involute}" "${POSTGRES_DB:-involute}" \
  > "$TEMP_FILE"

gzip -c "$TEMP_FILE" > "$OUTPUT_FILE"

printf 'Wrote backup to %s\n' "$OUTPUT_FILE"

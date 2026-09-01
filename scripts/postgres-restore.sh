#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.prod.images.yml}"
POSTGRES_USER="${POSTGRES_USER:-involute}"
POSTGRES_DB="${POSTGRES_DB:-involute}"
RESTORE_TARGET="${RESTORE_TARGET:-compose}"
INPUT_FILE="${1:-}"

if [ -z "$INPUT_FILE" ]; then
  echo "Usage: sh scripts/postgres-restore.sh <backup.sql.gz>" >&2
  echo "  RESTORE_TARGET=compose CONFIRM=yes   restore into the compose db (destructive)" >&2
  echo "  RESTORE_TARGET=throwaway             restore into a throwaway postgres container" >&2
  exit 2
fi

if [ ! -f "$INPUT_FILE" ]; then
  echo "Backup file not found: $INPUT_FILE" >&2
  exit 1
fi

dump_sql() {
  case "$INPUT_FILE" in
    *.gz) gzip -dc "$INPUT_FILE" ;;
    *) cat "$INPUT_FILE" ;;
  esac
}

if [ "$RESTORE_TARGET" = "throwaway" ]; then
  CONTAINER_NAME="${THROWAWAY_CONTAINER:-involute-restore-drill}"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER_NAME" \
    -e POSTGRES_USER="$POSTGRES_USER" \
    -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-involute}" \
    -e POSTGRES_DB="$POSTGRES_DB" \
    postgres:16-alpine >/dev/null

  i=0
  while [ "$i" -lt 30 ]; do
    if docker exec "$CONTAINER_NAME" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
      break
    fi
    i=$((i + 1))
    sleep 1
  done

  dump_sql | docker exec -i "$CONTAINER_NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null
  printf 'Restored %s into throwaway container %s\n' "$INPUT_FILE" "$CONTAINER_NAME"
  printf 'Inspect with: docker exec -it %s psql -U %s -d %s\n' "$CONTAINER_NAME" "$POSTGRES_USER" "$POSTGRES_DB"
  printf 'Remove with: docker rm -f %s\n' "$CONTAINER_NAME"
  exit 0
fi

if [ "$RESTORE_TARGET" != "compose" ]; then
  echo "Unknown RESTORE_TARGET: $RESTORE_TARGET (use compose or throwaway)" >&2
  exit 2
fi

if [ "${CONFIRM:-}" != "yes" ]; then
  echo "Refusing to restore into the compose database without CONFIRM=yes" >&2
  echo "This replaces ${POSTGRES_DB}. Take a fresh backup first." >&2
  exit 2
fi

docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  exec -T db \
  psql -U "$POSTGRES_USER" -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${POSTGRES_DB}' AND pid <> pg_backend_pid();" \
  >/dev/null

docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  exec -T db \
  psql -U "$POSTGRES_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS \"${POSTGRES_DB}\";" \
  >/dev/null

docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  exec -T db \
  psql -U "$POSTGRES_USER" -d postgres \
  -c "CREATE DATABASE \"${POSTGRES_DB}\" OWNER \"${POSTGRES_USER}\";" \
  >/dev/null

dump_sql | docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  exec -T db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  >/dev/null

printf 'Restored %s into compose database %s\n' "$INPUT_FILE" "$POSTGRES_DB"

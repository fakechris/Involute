#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.prod.images.yml}"
POSTGRES_USER="${POSTGRES_USER:-involute}"
POSTGRES_DB="${POSTGRES_DB:-involute}"
RESTORE_TARGET="${RESTORE_TARGET:-compose}"
INPUT_FILE="${1:-}"
RUNNING_SERVICES=""
RESTORE_SUCCEEDED=false

if [ -z "$INPUT_FILE" ]; then
  echo "Usage: sh scripts/postgres-restore.sh <backup.sql.gz>" >&2
  echo "  RESTORE_TARGET=compose CONFIRM_RESTORE_DATABASE=<db>   restore into compose (destructive)" >&2
  echo "  RESTORE_TARGET=throwaway             restore into a throwaway postgres container" >&2
  exit 2
fi

if [ ! -f "$INPUT_FILE" ]; then
  echo "Backup file not found: $INPUT_FILE" >&2
  exit 1
fi

case "$POSTGRES_USER" in
  ''|*[!A-Za-z0-9_]*) echo "Invalid POSTGRES_USER: $POSTGRES_USER" >&2; exit 2 ;;
esac
case "$POSTGRES_DB" in
  ''|*[!A-Za-z0-9_]*) echo "Invalid POSTGRES_DB: $POSTGRES_DB" >&2; exit 2 ;;
esac

case "$INPUT_FILE" in
  *.gz) gzip -t "$INPUT_FILE" ;;
esac

if [ ! -s "$INPUT_FILE" ]; then
  echo "Backup file is empty: $INPUT_FILE" >&2
  exit 1
fi

verify_checksum() {
  if [ ! -f "$INPUT_FILE.sha256" ]; then
    echo "WARNING: no checksum file found at $INPUT_FILE.sha256" >&2
    return
  fi
  expected="$(awk 'NR == 1 {print $1}' "$INPUT_FILE.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$INPUT_FILE" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "$INPUT_FILE" | awk '{print $1}')"
  fi
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || {
    echo "Backup checksum mismatch: $INPUT_FILE" >&2
    exit 1
  }
}

verify_checksum

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

  dump_sql | docker exec -i "$CONTAINER_NAME" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null
  docker exec "$CONTAINER_NAME" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c 'SELECT COUNT(*) AS migration_count FROM "_prisma_migrations";' >/dev/null
  printf 'Restored %s into throwaway container %s\n' "$INPUT_FILE" "$CONTAINER_NAME"
  printf 'Inspect with: docker exec -it %s psql -U %s -d %s\n' "$CONTAINER_NAME" "$POSTGRES_USER" "$POSTGRES_DB"
  printf 'Remove with: docker rm -f %s\n' "$CONTAINER_NAME"
  exit 0
fi

if [ "$RESTORE_TARGET" != "compose" ]; then
  echo "Unknown RESTORE_TARGET: $RESTORE_TARGET (use compose or throwaway)" >&2
  exit 2
fi

if [ "${CONFIRM_RESTORE_DATABASE:-}" != "$POSTGRES_DB" ]; then
  echo "Refusing to restore without CONFIRM_RESTORE_DATABASE=$POSTGRES_DB" >&2
  echo "This replaces ${POSTGRES_DB}. Take a fresh backup first." >&2
  exit 2
fi

RUNNING_SERVICES="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps --status running --services | awk '$0 == "server" || $0 == "web"')"

restart_services() {
  if [ "$RESTORE_SUCCEEDED" = true ] && [ -n "$RUNNING_SERVICES" ]; then
    # shellcheck disable=SC2086
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" start $RUNNING_SERVICES >/dev/null || true
  fi
  if [ "$RESTORE_SUCCEEDED" != true ] && [ -n "$RUNNING_SERVICES" ]; then
    echo "Restore failed; server and web remain stopped. Inspect the database before restarting." >&2
  fi
}
trap restart_services EXIT INT TERM

if [ -n "$RUNNING_SERVICES" ]; then
  # shellcheck disable=SC2086
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop $RUNNING_SERVICES >/dev/null
fi

docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  exec -T db \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${POSTGRES_DB}' AND pid <> pg_backend_pid();" \
  >/dev/null

docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  exec -T db \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS \"${POSTGRES_DB}\";" \
  >/dev/null

docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  exec -T db \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -c "CREATE DATABASE \"${POSTGRES_DB}\" OWNER \"${POSTGRES_USER}\";" \
  >/dev/null

dump_sql | docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  exec -T db \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  >/dev/null

docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  exec -T db \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'SELECT COUNT(*) AS migration_count FROM "_prisma_migrations";' \
  >/dev/null

RESTORE_SUCCEEDED=true
printf 'Restored %s into compose database %s\n' "$INPUT_FILE" "$POSTGRES_DB"

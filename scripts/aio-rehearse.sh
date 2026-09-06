#!/bin/sh
# AIO drill: fresh database + single container, exercise the public surface,
# take a backup, restore it into a scratch database, and verify row parity.
# This is the rehearsal behind docs/ops.md "AIO drill"; the same steps run on
# a real host during a deploy rehearsal.
#
#   sh scripts/aio-rehearse.sh [image-tag]
set -eu

IMAGE="${1:-involute-aio:drill}"
DB_PORT="${DRILL_DB_PORT:-5545}"
HTTP_PORT="${DRILL_HTTP_PORT:-4302}"
TOKEN="drill-token-$(date +%s)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE=".backups/aio-drill-${STAMP}.sql.gz"

CONTAINER_DB="involute-drill-db"
CONTAINER_AIO="involute-drill-aio"

say() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
cleanup() {
  docker rm -f "$CONTAINER_AIO" >/dev/null 2>&1 || true
  docker rm -f "$CONTAINER_DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

mkdir -p .backups

say "Starting fresh database on 127.0.0.1:${DB_PORT}"
docker run -d --name "$CONTAINER_DB" \
  -e POSTGRES_DB=involute -e POSTGRES_USER=involute -e POSTGRES_PASSWORD=drill \
  -p "127.0.0.1:${DB_PORT}:5432" \
  postgres:16-alpine >/dev/null

attempt=1
while [ "$attempt" -le 30 ]; do
  if docker exec "$CONTAINER_DB" pg_isready -U involute -d involute >/dev/null 2>&1; then
    break
  fi
  [ "$attempt" -eq 30 ] && { echo "drill database never became ready" >&2; exit 1; }
  attempt=$((attempt + 1))
  sleep 1
done

say "Starting AIO container ($IMAGE) on 127.0.0.1:${HTTP_PORT}"
docker run -d --name "$CONTAINER_AIO" --network host \
  -e DATABASE_URL="postgresql://involute:drill@127.0.0.1:${DB_PORT}/involute?schema=public" \
  -e AUTH_TOKEN="$TOKEN" \
  -e APP_ORIGIN="http://127.0.0.1:${HTTP_PORT}" \
  -e NODE_ENV=production \
  -e PORT="$HTTP_PORT" \
  "$IMAGE" >/dev/null

attempt=1
while [ "$attempt" -le 60 ]; do
  if curl -fsS "http://127.0.0.1:${HTTP_PORT}/ready" >/dev/null 2>&1; then
    break
  fi
  [ "$attempt" -eq 60 ] && {
    echo "AIO container never became ready" >&2
    docker logs "$CONTAINER_AIO" >&2 || true
    exit 1
  }
  attempt=$((attempt + 1))
  sleep 2
done
say "Migrations applied and /ready is green"

say "Seeding one team + issue through the public API"
# A fresh deployment has no teams (seeding is explicit), so create the drill
# team — with one workflow state, as import and seed paths would — directly in
# the database, then exercise the write API through GraphQL.
docker exec "$CONTAINER_DB" psql -U involute -d involute -q -c "
INSERT INTO \"Team\" (id, key, name)
SELECT gen_random_uuid(), 'DRILL', 'Drill Team'
WHERE NOT EXISTS (SELECT 1 FROM \"Team\" WHERE key = 'DRILL');
INSERT INTO \"WorkflowState\" (id, name, type, position, \"teamId\")
SELECT gen_random_uuid(), 'Backlog', 'BACKLOG', 0, id FROM \"Team\" WHERE key = 'DRILL';"
DRILL_TEAM_ID="$(docker exec "$CONTAINER_DB" psql -U involute -d involute -t -A -c "SELECT id FROM \"Team\" WHERE key = 'DRILL'")"
curl -fsS -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data "{\"query\":\"mutation { issueCreate(input: { teamId: \\\"$DRILL_TEAM_ID\\\", title: \\\"Drill issue\\\" }) { success issue { identifier } } }\"}" \
  "http://127.0.0.1:${HTTP_PORT}/graphql" | grep -q '"success":true'

say "Running container smoke (health/ready/docs/graphql/MCP)"
AIO_SMOKE_AUTH_TOKEN="$TOKEN" sh scripts/aio-smoke.sh "http://127.0.0.1:${HTTP_PORT}"

say "Backing up to $BACKUP_FILE"
docker exec "$CONTAINER_DB" pg_dump -U involute involute | gzip > "$BACKUP_FILE"

say "Restoring into a scratch database"
docker exec "$CONTAINER_DB" psql -U involute -d involute -q -c 'CREATE DATABASE restore_check'
gunzip -c "$BACKUP_FILE" | docker exec -i "$CONTAINER_DB" psql -U involute -d restore_check -q

say "Verifying row parity between live and restored databases"
PARITY="$(docker exec "$CONTAINER_DB" psql -U involute -d restore_check -t -A -c "
SELECT
  (SELECT count(*) FROM \"Team\") || ' teams / ' ||
  (SELECT count(*) FROM \"Issue\") || ' issues / ' ||
  (SELECT count(*) FROM \"User\") || ' users'
")"
echo "restored: $PARITY"
docker exec "$CONTAINER_DB" psql -U involute -d restore_check -t -A -c \
  "SELECT count(*) FROM \"Issue\" WHERE title = 'Drill issue'" | grep -q '^1$' || {
  echo "restored database is missing the drill issue" >&2
  exit 1
}

say "Drill passed. Backup kept at $BACKUP_FILE"

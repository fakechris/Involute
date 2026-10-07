#!/usr/bin/env bash
# Deploy one published image tag to the production host (INV-1008).
#
# Runs ON the host (as a user who can sudo docker), or streamed over ssh:
#   ssh oracle_5 'sudo bash -s' < scripts/deploy-prod.sh sha-<12 hex>
#   sudo bash scripts/deploy-prod.sh sha-<12 hex>
#
# What it does, in order, and stops at the first failure:
#   1. refuses to pull when the root disk has less than MIN_FREE_GB free
#      (2026-10-07: 94 old images filled the disk and the pull died after
#      .env.production already pointed at the new tag);
#   2. backs up .env.production and takes a pg_dump into .backups/;
#   3. points INVOLUTE_IMAGE_TAG at the new tag, pulls and restarts;
#   4. waits for /ready to answer 200 with JSON;
#   5. prunes application images other than the new and the previous tag.
# On a pull, restart or health failure, .env.production is restored to the
# previous tag and the previous images are started again.
#
# Env: INVOLUTE_DIR (/opt/involute), MIN_FREE_GB (8), HEALTH_URL
# (http://127.0.0.1:4200/ready), HEALTH_TIMEOUT seconds (120), KEEP_DB_BACKUPS (10).
set -euo pipefail

TAG="${1:-}"
INVOLUTE_DIR="${INVOLUTE_DIR:-/opt/involute}"
MIN_FREE_GB="${MIN_FREE_GB:-8}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4200/ready}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
KEEP_DB_BACKUPS="${KEEP_DB_BACKUPS:-10}"
ENV_FILE="$INVOLUTE_DIR/.env.production"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$INVOLUTE_DIR/docker-compose.prod.images.yml")

fail() { echo "deploy-prod: $*" >&2; exit 1; }

[[ "$TAG" =~ ^sha-[0-9a-f]{12,40}$ ]] || fail "usage: deploy-prod.sh sha-<12-40 lowercase hex> (got '${TAG}'); production pins immutable sha tags only"
[[ -f "$ENV_FILE" ]] || fail "$ENV_FILE not found"
command -v docker >/dev/null || fail "docker is not installed"
cd "$INVOLUTE_DIR"
mkdir -p .backups

PREVIOUS="$(sed -n 's/^INVOLUTE_IMAGE_TAG=//p' "$ENV_FILE" | tail -1)"
[[ -n "$PREVIOUS" ]] || fail "INVOLUTE_IMAGE_TAG is not set in $ENV_FILE"
# Redeploying the configured tag keeps the tag before it as the rollback target.
if [[ "$PREVIOUS" == "$TAG" ]]; then
  echo "deploy-prod: $TAG is already the configured tag; pulling and restarting anyway"
  PREVIOUS="$(cat .backups/previous-tag 2>/dev/null || echo "$TAG")"
fi

# 1. Disk: a pull of ~1.7 GB of images onto a full disk leaves the stack half-updated.
FREE_GB="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
if (( FREE_GB < MIN_FREE_GB )); then
  fail "only ${FREE_GB} GB free on / (need ${MIN_FREE_GB}); run 'docker image prune -a' or raise MIN_FREE_GB, then retry. Nothing was changed."
fi
echo "deploy-prod: ${FREE_GB} GB free, previous tag ${PREVIOUS}, new tag ${TAG}"

# 2. Backups.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
cp "$ENV_FILE" ".backups/.env.production.${STAMP}"
DB_CONTAINER="$("${COMPOSE[@]}" ps -q db)"
[[ -n "$DB_CONTAINER" ]] || fail "db container is not running; refusing to deploy without a backup"
docker exec "$DB_CONTAINER" pg_dump -U involute -d involute -Fc > "/tmp/involute-${STAMP}.dump"
mv "/tmp/involute-${STAMP}.dump" ".backups/involute-${STAMP}.dump"
echo "deploy-prod: backup .backups/involute-${STAMP}.dump ($(stat -c %s ".backups/involute-${STAMP}.dump") bytes)"
# Keep the newest KEEP_DB_BACKUPS dumps; they are 10s of MB each.
ls -1t .backups/involute-*.dump 2>/dev/null | tail -n +"$((KEEP_DB_BACKUPS + 1))" | xargs -r rm -f

restore_previous() {
  echo "deploy-prod: FAILED at '$1'; restoring INVOLUTE_IMAGE_TAG=${PREVIOUS}" >&2
  sed -i "s/^INVOLUTE_IMAGE_TAG=.*/INVOLUTE_IMAGE_TAG=${PREVIOUS}/" "$ENV_FILE"
  rm -f .backups/previous-tag
  "${COMPOSE[@]}" up -d >/dev/null 2>&1 || echo "deploy-prod: restart on the previous tag failed too; inspect '${COMPOSE[*]} ps'" >&2
  exit 1
}

# 3. Switch tag, pull, restart.
sed -i "s/^INVOLUTE_IMAGE_TAG=.*/INVOLUTE_IMAGE_TAG=${TAG}/" "$ENV_FILE"
echo "$PREVIOUS" > .backups/previous-tag
"${COMPOSE[@]}" pull -q || restore_previous "pull"
"${COMPOSE[@]}" up -d || restore_previous "up"

# 4. The new image must be the one running, and healthy: /ready must answer the
# API's JSON, not the SPA (INV-972).
RUNNING="$(docker inspect --format '{{.Config.Image}}' "$("${COMPOSE[@]}" ps -q server)" 2>/dev/null || true)"
[[ "$RUNNING" == *":${TAG}" ]] || restore_previous "server container runs '${RUNNING:-nothing}', not ${TAG}"
for (( waited = 0; waited < HEALTH_TIMEOUT; waited += 5 )); do
  sleep 5
  CODE="$(curl -s -o /tmp/deploy-ready.json -w '%{http_code}' -H 'accept: application/json' "$HEALTH_URL" || true)"
  if [[ "$CODE" == "200" ]] && grep -q '"status"' /tmp/deploy-ready.json 2>/dev/null; then
    echo "deploy-prod: ${HEALTH_URL} ready after ${waited}s: $(tr -d '\n' < /tmp/deploy-ready.json | cut -c1-120)"
    READY=1
    break
  fi
done
[[ "${READY:-}" == "1" ]] || restore_previous "health check (${HEALTH_URL} did not answer 200 JSON within ${HEALTH_TIMEOUT}s)"

# 5. Prune: keep the new and the previous application images for rollback.
PRUNED=0
while read -r IMAGE; do
  case "$IMAGE" in
    *":${TAG}"|*":${PREVIOUS}") ;;
    *) docker image rm -f "$IMAGE" >/dev/null 2>&1 && PRUNED=$((PRUNED + 1)) ;;
  esac
done < <(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '/involute-(server|web|cli):' || true)
docker image prune -f >/dev/null 2>&1 || true
echo "deploy-prod: pruned ${PRUNED} old application image(s); kept ${TAG} and ${PREVIOUS}"
echo "deploy-prod: done — $(df -h / | awk 'NR==2 {print $4 " free"}'); rollback: $0 ${PREVIOUS}"

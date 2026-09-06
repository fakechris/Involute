#!/usr/bin/env bash
# Involute self-host bootstrap: generate an env file, pull images, start the
# stack, and smoke-check it. Idempotent: re-running keeps existing secrets.
#
#   ./setup.sh                 # interactive (prompts for domain)
#   ./setup.sh --local         # local defaults, http://localhost:4200
set -euo pipefail

cd "$(dirname "$0")"

ENV_FILE="${INVOLUTE_ENV_FILE:-.env}"
COMPOSE_FILE="${INVOLUTE_COMPOSE_FILE:-docker-compose.aio.yml}"
LOCAL=0
for arg in "$@"; do
  case "$arg" in
    --local) LOCAL=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }

command -v docker >/dev/null 2>&1 || { echo "Docker is required: https://docs.docker.com/get-docker/"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required."; exit 1; }

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

if [ ! -f "$ENV_FILE" ]; then
  say "Creating $ENV_FILE"
  : > "$ENV_FILE"
else
  say "Reusing existing $ENV_FILE"
fi

env_has() { grep -q "^$1=" "$ENV_FILE" 2>/dev/null; }
env_set() {
  local key="$1" value="$2"
  if env_has "$key"; then
    sed -i.bak "s|^$key=.*|$key=$value|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

if ! env_has POSTGRES_PASSWORD; then
  say "Generating POSTGRES_PASSWORD"
  env_set POSTGRES_PASSWORD "$(generate_secret)"
fi
if ! env_has AUTH_TOKEN; then
  say "Generating AUTH_TOKEN"
  env_set AUTH_TOKEN "$(generate_secret)"
fi
if ! env_has VIEWER_ASSERTION_SECRET; then
  say "Generating VIEWER_ASSERTION_SECRET"
  env_set VIEWER_ASSERTION_SECRET "$(generate_secret)"
fi

if [ "$LOCAL" -eq 1 ]; then
  APP_ORIGIN_DEFAULT="http://localhost:4200"
else
  APP_ORIGIN_DEFAULT=""
fi

if ! env_has APP_ORIGIN; then
  if [ -n "$APP_ORIGIN_DEFAULT" ]; then
    env_set APP_ORIGIN "$APP_ORIGIN_DEFAULT"
  else
    printf 'Public origin (e.g. https://involute.example.com): '
    read -r ANSWER_ORIGIN
    env_set APP_ORIGIN "${ANSWER_ORIGIN:-http://localhost:4200}"
  fi
fi

# Web is served by the API process in the AIO image; same origin as APP_ORIGIN.
env_set INVOLUTE_WEB_DIST "/app/packages/web/dist"
env_set AIO_DATABASE_URL "postgresql://involute:$(grep '^POSTGRES_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)@db:5432/involute?schema=public"

say "Pulling images"
INVOLUTE_IMAGE_NAMESPACE="${INVOLUTE_IMAGE_NAMESPACE:-fakechris}" \
INVOLUTE_IMAGE_TAG="${INVOLUTE_IMAGE_TAG:-latest}" \
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull --ignore-pull-failures

say "Starting stack"
INVOLUTE_IMAGE_NAMESPACE="${INVOLUTE_IMAGE_NAMESPACE:-fakechris}" \
INVOLUTE_IMAGE_TAG="${INVOLUTE_IMAGE_TAG:-latest}" \
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d

say "Waiting for readiness"
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:4200/ready >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if curl -fsS http://127.0.0.1:4200/ready >/dev/null 2>&1; then
  say "Involute is ready at ${APP_ORIGIN:-http://localhost:4200}"
  say "Connect an agent: codex mcp add involute --url ${APP_ORIGIN:-http://localhost:4200}/mcp"
else
  echo "Stack started but /ready has not gone green yet." >&2
  echo "Check logs: docker compose --env-file $ENV_FILE -f $COMPOSE_FILE logs -f aio" >&2
  exit 1
fi

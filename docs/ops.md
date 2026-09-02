# Operator runbook

This is the production operations path for the VPS. Railway is not a supported path.

Related files:

- [README.md](../README.md) — compose, Ansible, and secrets overview
- [scripts/prod-smoke.sh](../scripts/prod-smoke.sh) — live endpoint smoke
- [scripts/postgres-backup.sh](../scripts/postgres-backup.sh)
- [scripts/postgres-restore.sh](../scripts/postgres-restore.sh)

## Layout on the host

Default deploy path: `/opt/involute`.

| Piece | Where |
|---|---|
| Compose files | `/opt/involute/docker-compose.prod.images.yml` |
| Env | `/opt/involute/.env.production` |
| API | host `:4200` behind Caddy/HTTPS |
| Web | host `:4201` behind Caddy/HTTPS |
| Postgres | compose service `db`, not published publicly |

Production uses published images (`docker-compose.prod.images.yml`), not a VPS source build.
Application images must be pinned to an immutable `sha-<commit>` tag. `latest` is not accepted by the deploy playbook.

## Status

```bash
cd /opt/involute
docker compose --env-file .env.production -f docker-compose.prod.images.yml ps
curl -fsS https://<domain>/health
curl -fsS -o /tmp/session.json -w '%{http_code}\n' https://<domain>/auth/session
```

Expected: `health` returns `OK`. `auth/session` is `200` (signed in) or `401` (anonymous) and reports `googleOAuthConfigured: true`.

## Logs

```bash
cd /opt/involute
docker compose --env-file .env.production -f docker-compose.prod.images.yml logs --tail=200 server
docker compose --env-file .env.production -f docker-compose.prod.images.yml logs --tail=200 web
docker compose --env-file .env.production -f docker-compose.prod.images.yml logs --tail=200 db
```

Follow one service:

```bash
docker compose --env-file .env.production -f docker-compose.prod.images.yml logs -f server
```

## Deploy

Images publish from `main` via `.github/workflows/docker-publish.yml`. Production deploy is Ansible:

```bash
# from a workstation with vault access
pnpm deploy:prod
```

Set `involute_image_tag: sha-<12>` in the encrypted inventory. The GitHub Actions workflow derives that tag from the selected commit unless an explicit SHA tag is supplied for rollback. The playbook pulls images and takes a timestamped Postgres backup before stopping the current stack.

Or GitHub Actions `Deploy` with `profile=production`. Keep `INVOLUTE_DEPLOY_ON_MAIN=false` unless auto-deploy on main is an explicit choice.

`server-init` runs `prisma migrate deploy` before the API starts. Do not run ad-hoc SQL against production unless recovering.

## Rollback

1. Note the running image tags:

```bash
docker compose --env-file .env.production -f docker-compose.prod.images.yml images
```

2. Set `INVOLUTE_IMAGE_TAG` (or the compose image pin) to the previous working `sha-<12>` tag from Docker Hub.
3. Run `pnpm deploy:prod` again, or on the host:

```bash
cd /opt/involute
docker compose --env-file .env.production -f docker-compose.prod.images.yml pull
docker compose --env-file .env.production -f docker-compose.prod.images.yml up -d db server web
```

4. Smoke-check `/health`, `/auth/session`, MCP, and the board.

If a migration in the new build already applied and the old image cannot boot, restore the matching database backup first (see below), then roll the images back.

## Backup

On the host or from a machine that can reach compose:

```bash
ENV_FILE=/opt/involute/.env.production \
COMPOSE_FILE=/opt/involute/docker-compose.prod.images.yml \
sh scripts/postgres-backup.sh
```

Writes `.backups/involute-<timestamp>.sql.gz`. Copy that file off the VPS.

Take a backup before every production deploy.

## Restore

Throwaway drill (does not touch production data):

```bash
RESTORE_TARGET=throwaway sh scripts/postgres-restore.sh .backups/involute-<timestamp>.sql.gz
docker exec -it involute-restore-drill psql -U involute -d involute
docker rm -f involute-restore-drill
```

Destructive restore into the compose database stops `server` and `web`, restores with `ON_ERROR_STOP`, validates the Prisma migration table, and only then restarts the services:

```bash
# take a fresh backup first
CONFIRM_RESTORE_DATABASE=involute \
ENV_FILE=/opt/involute/.env.production \
COMPOSE_FILE=/opt/involute/docker-compose.prod.images.yml \
sh scripts/postgres-restore.sh .backups/involute-<timestamp>.sql.gz
```

Then restart API/web and smoke-check.

## Production smoke checklist

Run after every deploy. Replace the domain with the live origin.

1. `curl -fsS https://<domain>/health` → `OK`
2. `INVOLUTE_SMOKE_AUTH_TOKEN=<agent-or-service-token> pnpm smoke:prod https://<domain>`
   - `/auth/session` is 200 or 401 and `googleOAuthConfigured=true`
   - `/auth/google/start` redirects to `accounts.google.com`
3. Open `https://<domain>/` in a browser
   - board loads committed work only
   - Google sign-in sets a session cookie through the reverse proxy
4. The automated smoke performs MCP `initialize`, `tools/list`, and a read-only `work_search` call.
5. Open `/candidates`, `/graph`, and one `/work/:id`; verify errors are not rendered as empty data.

Uploads are stored in the named `uploads-prod-data` volume and downloads require authentication. Include that volume in the VPS backup policy; a database backup alone does not contain uploaded files.

Do not treat comment create as an agent heartbeat. Agents use `/mcp`.

## Agent credentials

Provision a separate revocable token for each Agent. The token is accepted only on `/mcp`; it cannot use the GraphQL compatibility API. The command adds the Agent as an `EDITOR` on exactly the selected team and prints the plaintext token once:

```bash
cd /opt/involute
docker compose --env-file .env.production -f docker-compose.prod.images.yml run --rm \
  --entrypoint /bin/sh server -lc \
  'pnpm --filter @turnkeyai/involute-server agent:create -- INV "Codex production" codex-production@example.invalid'
```

Store the returned `inv_agent_...` value in the Agent's secret store. List credential metadata or revoke a leaked credential by ID:

```bash
docker compose --env-file .env.production -f docker-compose.prod.images.yml run --rm \
  --entrypoint /bin/sh server -lc \
  'pnpm --filter @turnkeyai/involute-server agent:list'

docker compose --env-file .env.production -f docker-compose.prod.images.yml run --rm \
  --entrypoint /bin/sh server -lc \
  'pnpm --filter @turnkeyai/involute-server agent:revoke -- <credential-id>'
```

Use a short-lived credential for production smoke when practical. Revocation takes effect on the next MCP request.

## Webhooks

Set `INVOLUTE_WEBHOOK_URL` and `INVOLUTE_WEBHOOK_SECRET` together. Multiple comma-separated URLs share the signing secret. Delivery state is tracked per target: a successful endpoint is not replayed merely because another endpoint needs a retry; a target is dead-lettered after eight failed attempts.

## First admin

Production bootstrap is `ADMIN_EMAIL_ALLOWLIST` plus Google OAuth. To re-assert:

```bash
docker compose --env-file .env.production -f docker-compose.prod.images.yml run --rm \
  --entrypoint /bin/sh server -lc \
  'pnpm --filter @turnkeyai/involute-server run admin:bootstrap you@example.com'
```

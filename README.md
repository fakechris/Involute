# Involute

一人团队的 Linear 式项目管理系统开源实现。

Involute bundles a GraphQL API, a kanban web app, and a CLI that can export one Linear team, import it into Involute, verify the result, and then let you visually accept it in the board UI.

## Workspace layout

- `packages/server` — GraphQL API, Prisma-backed data model, import pipeline, validation helpers
- `packages/web` — React + Vite kanban UI
- `packages/cli` — `involute` CLI for config, import/export, teams, issues, labels, and comments
- `packages/shared` — shared TypeScript utilities
- `docs/vision.md` — current product vision
- `docs/milestones.md` — active milestones and sequencing

## Environment

Create a repo-root `.env` file based on `.env.example`:

```env
DATABASE_URL=postgresql://involute:involute@127.0.0.1:5434/involute?schema=public
AUTH_TOKEN=changeme-set-your-token
VIEWER_ASSERTION_SECRET=compose-viewer-secret
APP_ORIGIN=http://localhost:4201
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:4200/auth/google/callback
ADMIN_EMAIL_ALLOWLIST=you@example.com
PORT=4200
```

Required server variables:

- `DATABASE_URL` — PostgreSQL connection string
- `APP_ORIGIN` — browser origin used for cookie/CORS handling and post-login redirects
- `PORT` — API port (defaults to `4200`)

Optional but recommended server variables:

- `AUTH_TOKEN` — trusted bearer token used by the CLI and local/dev bootstrap flows
- `VIEWER_ASSERTION_SECRET` — HMAC secret used to verify signed viewer assertions for trusted impersonation
- `GOOGLE_OAUTH_CLIENT_ID` — Google OAuth client id for browser sign-in
- `GOOGLE_OAUTH_CLIENT_SECRET` — Google OAuth client secret
- `GOOGLE_OAUTH_REDIRECT_URI` — Google callback URL handled by the API server
- `ADMIN_EMAIL_ALLOWLIST` — comma-separated allowlist of emails that should become `ADMIN`
- `SESSION_TTL_SECONDS` — browser session lifetime in seconds
- `SEED_DEFAULT_ADMIN` — dev/test-only switch to seed `admin@involute.local`; keep this `false` outside local acceptance flows
- `PRISMA_BASELINE_EXISTING_SCHEMA` — one-time upgrade switch for pre-migration databases that already have the schema but no `_prisma_migrations` history

Compatibility note:

- `GOOGLE_OAUTH_ADMIN_EMAILS` is still accepted as a legacy alias, but new deployments should use `ADMIN_EMAIL_ALLOWLIST`

Optional web runtime variables:

- `VITE_INVOLUTE_GRAPHQL_URL` — override the web app GraphQL endpoint (default: `http://localhost:4200/graphql`)
- `VITE_INVOLUTE_AUTH_TOKEN` — trusted local/dev bearer token for bypassing browser login
- `VITE_INVOLUTE_VIEWER_ASSERTION` — signed viewer assertion to act as a specific user without exposing the server secret

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm compose:up
```

Smoke check:

```bash
curl http://localhost:4200/health
curl http://localhost:4201
```

Then open `http://localhost:4201` in your browser.

If Google OAuth is configured, the web nav will expose `Sign in with Google` and use session cookies. If it is not configured, the browser can still talk to the API with `VITE_INVOLUTE_AUTH_TOKEN` for trusted local development.

Compose defaults:

- API: `http://localhost:4200`
- Web: `http://localhost:4201`
- Postgres: `127.0.0.1:5434`
- CLI export mount: tracked `.tmp/` on the host is available as `/exports` in the `cli` container
- Compose uses the `web-dev` Docker target for the live Vite UI; the published `involute-web` image uses the production `web` target
- `server-init` now applies Prisma migrations with `prisma migrate deploy` before seeding

Stop the stack with:

```bash
pnpm compose:down
```

## VPS deployment (fresh install)

This is the recommended first production path: one VPS, Docker Compose, Postgres, the Node API, the static web container, and Caddy terminating HTTPS on a single domain.

Files involved:

- [`docker-compose.prod.yml`](./docker-compose.prod.yml)
- [`Caddyfile`](./Caddyfile)
- [`.env.production.example`](./.env.production.example)
- [`scripts/postgres-backup.sh`](./scripts/postgres-backup.sh)

Assumptions:

- a fresh host with Docker and Docker Compose installed
- a DNS record for `APP_DOMAIN` already points at the VPS
- a fresh Postgres volume; no legacy schema upgrade path is needed

1. Copy the repo to the VPS and create the production env file:

```bash
cp .env.production.example .env.production
```

2. Fill at least these values in `.env.production`:

```env
APP_DOMAIN=involute.example.com
APP_ORIGIN=https://involute.example.com
POSTGRES_PASSWORD=...
AUTH_TOKEN=...
VIEWER_ASSERTION_SECRET=...
ADMIN_EMAIL_ALLOWLIST=you@example.com
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=https://involute.example.com/auth/google/callback
```

3. Bring the stack up:

```bash
pnpm compose:prod:up
```

4. Smoke check it:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml ps
curl -I https://involute.example.com
curl https://involute.example.com/health
```

5. If you need to re-assert the first admin explicitly:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm \
  --entrypoint /bin/sh server -lc \
  'pnpm --filter @involute/server run admin:bootstrap you@example.com'
```

Operational notes:

- production compose keeps Postgres internal; only Caddy exposes `80/443`
- `server-init` runs `prisma migrate deploy` before the API starts
- `SEED_DATABASE` defaults to `false` in production; turn it on only for a fresh demo seed
- the web container is the static production build, not the Vite dev server

Backups:

```bash
sh scripts/postgres-backup.sh
```

This writes a gzipped SQL dump to `.backups/`.

## Automated deployment with Ansible

Manual SSH deployment is no longer the intended path. The repo now includes an Ansible workflow under [`ops/ansible`](./ops/ansible).

Available playbooks:

- [`ops/ansible/playbooks/bootstrap-host.yml`](./ops/ansible/playbooks/bootstrap-host.yml) — install Docker/Compose and prepare the host
- [`ops/ansible/playbooks/deploy.yml`](./ops/ansible/playbooks/deploy.yml) — sync the repo, render env, run compose, and verify health

Tailscale-specific deployment reuses [`docker-compose.yml`](./docker-compose.yml) and drives bind addresses through the rendered env file. Only `4200` and `4201` bind to the Tailscale IP; Postgres stays on `127.0.0.1`.

Typical flow:

1. Copy the example inventory:

```bash
cp ops/ansible/inventory/hosts.yml.example ops/ansible/inventory/hosts.yml
```

2. Fill the target host, bind address, and secrets.

3. Prepare the host:

```bash
pnpm deploy:bootstrap
```

4. Deploy the Tailscale stack:

```bash
pnpm deploy:tailscale
```

For the current Tailscale-only test phase, use:

- `involute_stack_profile: tailscale`
- `involute_bind_address: <tailscale-ip>`
- `involute_app_origin: http://<tailscale-ip>:4201`

When the public domain and OAuth are ready, switch the inventory to `production` and use [`docker-compose.prod.yml`](./docker-compose.prod.yml).

GitHub Actions can run the same deployment path from [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml). Configure these repository secrets before enabling it:

- `DEPLOY_HOST`
- `DEPLOY_KNOWN_HOSTS`
- `DEPLOY_USER`
- `DEPLOY_SSH_PRIVATE_KEY`
- `INVOLUTE_APP_ORIGIN`
- `INVOLUTE_AUTH_TOKEN`
- `INVOLUTE_VIEWER_ASSERTION_SECRET`
- `INVOLUTE_BIND_ADDRESS` for `tailscale`
- `INVOLUTE_APP_DOMAIN` and `INVOLUTE_POSTGRES_PASSWORD` for `production`
- optional: `INVOLUTE_ADMIN_EMAIL_ALLOWLIST`, `INVOLUTE_GOOGLE_OAUTH_CLIENT_ID`, `INVOLUTE_GOOGLE_OAUTH_CLIENT_SECRET`, `INVOLUTE_GOOGLE_OAUTH_REDIRECT_URI`

Recommended repository variables:

- `INVOLUTE_DEPLOY_ON_MAIN=false` to keep deploy manual by default
- `INVOLUTE_DEPLOY_PROFILE=tailscale` for the current private test phase

## Manual single-team import

Set your Linear token in the shell:

```bash
export LINEAR_TOKEN='lin_api_xxx'
```

Run the end-to-end team import inside the compose CLI container:

```bash
docker compose run --rm cli import team --token "$LINEAR_TOKEN" --team SON --keep-export --output /exports/son-export
```

What this does:

- exports one Linear team into `.tmp/son-export`
- imports the exported data into Involute
- runs `import verify`
- writes `.tmp/son-export/involute-import-summary.json`

After it completes, open `http://localhost:4201` and visually check the imported team in the board.

Recommended acceptance checks:

- the target team appears in the board
- issue count looks complete for that team
- a few issues have the expected state, labels, assignee, and comments
- the latest imported issues are visible in the board, not hidden behind the first page

## Local development without Docker

Start the API:

```bash
DATABASE_URL="postgresql://involute:involute@127.0.0.1:5434/involute?schema=public" AUTH_TOKEN="changeme-set-your-token" VIEWER_ASSERTION_SECRET="compose-viewer-secret" APP_ORIGIN="http://127.0.0.1:4201" GOOGLE_OAUTH_REDIRECT_URI="http://127.0.0.1:4200/auth/google/callback" pnpm --filter @involute/server exec tsx src/index.ts
```

Start the web app:

```bash
VITE_INVOLUTE_AUTH_TOKEN="changeme-set-your-token" VITE_INVOLUTE_GRAPHQL_URL="http://127.0.0.1:4200/graphql" pnpm --filter @involute/web exec vite --host 127.0.0.1 --port 4201
```

Run the CLI against that local API:

```bash
pnpm --filter @involute/cli exec node dist/index.js import team --token "$LINEAR_TOKEN" --team SON --keep-export --output .tmp/son-export
```

If you need the CLI or web UI to act as a specific user, mint a short-lived viewer assertion with a trusted secret and persist it:

```bash
export INVOLUTE_VIEWER_ASSERTION_SECRET=compose-viewer-secret
pnpm --filter @involute/cli exec node dist/index.js auth viewer-assertion create user@example.com --ttl 3600
pnpm --filter @involute/cli exec node dist/index.js config set viewer-assertion SIGNED_ASSERTION_HERE
```

The web UI can use the same signed assertion via `VITE_INVOLUTE_VIEWER_ASSERTION` or localStorage key `involute.viewerAssertion`.

## Auth and permissions

- Browser auth now supports Google OAuth plus session cookies.
- `AUTH_TOKEN` and viewer assertions remain available for trusted CLI/dev flows.
- System admins can be bootstrapped through `ADMIN_EMAIL_ALLOWLIST` or `pnpm --filter @involute/server admin:bootstrap user@example.com`.
- Teams now have `PUBLIC` / `PRIVATE` visibility.
- Team edits are gated by membership role: `EDITOR` or `OWNER`.
- Team access management is available in the web UI at `/settings/access` and through GraphQL mutations: `teamUpdateAccess`, `teamMembershipUpsert`, and `teamMembershipRemove`.

## Database migrations

Use Prisma migrations as the default schema workflow:

```bash
pnpm --filter @involute/server prisma:migrate:dev -- --name your_change
pnpm --filter @involute/server prisma:migrate:deploy
```

Useful admin/database commands:

```bash
pnpm --filter @involute/server admin:bootstrap you@example.com
pnpm --filter @involute/server prisma:migrate:baseline
pnpm --filter @involute/server prisma:migrate:reset
pnpm --filter @involute/server prisma:db:push
```

Guidance:

- prefer `prisma:migrate:dev` while changing the schema locally
- use `prisma:migrate:deploy` in compose, CI, and production
- keep `prisma:db:push` as an explicit development-only escape hatch, not the default deployment path
- if you are upgrading an older database that predates `prisma/migrations`, run `prisma:migrate:baseline` once before the first `prisma:migrate:deploy`, or set `PRISMA_BASELINE_EXISTING_SCHEMA=true` for a one-time compose bootstrap

## Quality gates

Unit and integration checks:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Browser E2E:

```bash
pnpm e2e
```

The Playwright suite verifies the core board lifecycle: create, update, comment, delete comment, and delete issue.

## Docker images

This repo ships one multi-target `Dockerfile` with `server`, `web-dev`, `web`, and `cli` targets. The Docker Hub publish workflow expects these secrets:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

When they are set, `.github/workflows/docker-publish.yml` pushes:

- `${DOCKERHUB_USERNAME}/involute-server`
- `${DOCKERHUB_USERNAME}/involute-web`
- `${DOCKERHUB_USERNAME}/involute-cli`

The published `involute-web` image is a static production build. It bakes `VITE_INVOLUTE_GRAPHQL_URL` at build time, but it does not bake an auth token into the image. For local development and acceptance, the compose stack remains the reference runtime path and should stay green before publishing.

## Common CLI commands

```bash
pnpm --filter @involute/cli exec node dist/index.js teams list
pnpm --filter @involute/cli exec node dist/index.js issues list --team SON
pnpm --filter @involute/cli exec node dist/index.js issues create --team SON --title "My issue"
pnpm --filter @involute/cli exec node dist/index.js comments add SON-1 --body "Hello from Involute"
pnpm --filter @involute/cli exec node dist/index.js export --token "$LINEAR_TOKEN" --team SON --output .tmp/son-export
pnpm --filter @involute/cli exec node dist/index.js import --file .tmp/son-export
pnpm --filter @involute/cli exec node dist/index.js import verify --file .tmp/son-export
pnpm --filter @involute/cli exec node dist/index.js import team --token "$LINEAR_TOKEN" --team SON
```

## Current focus

- Make the current stack deployable on VPS and Railway
- Keep Google OAuth, admin bootstrap, and team RBAC stable while deployment hardens
- Move database changes through Prisma migrations instead of schema push shortcuts
- Keep the compose stack and CI reproducible while the product boundary hardens

See [docs/vision.md](docs/vision.md) and [docs/milestones.md](docs/milestones.md) for the product direction.

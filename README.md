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
PORT=4200
```

Required server variables:

- `DATABASE_URL` — PostgreSQL connection string
- `AUTH_TOKEN` — bearer token expected by the API and CLI clients
- `VIEWER_ASSERTION_SECRET` — HMAC secret used to verify signed viewer assertions for trusted impersonation
- `PORT` — API port (defaults to `4200`)

Optional web runtime variables:

- `VITE_INVOLUTE_GRAPHQL_URL` — override the web app GraphQL endpoint (default: `http://localhost:4200/graphql`)
- `VITE_INVOLUTE_AUTH_TOKEN` — provide the web app bearer token at build/dev time
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

Then open `http://localhost:4201`.

Compose defaults:

- API: `http://localhost:4200`
- Web: `http://localhost:4201`
- Postgres: `127.0.0.1:5434`
- CLI export mount: tracked `.tmp/` on the host is available as `/exports` in the `cli` container
- Compose uses the `web-dev` Docker target for the live Vite UI; the published `involute-web` image uses the production `web` target

Stop the stack with:

```bash
pnpm compose:down
```

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
DATABASE_URL="postgresql://involute:involute@127.0.0.1:5434/involute?schema=public" AUTH_TOKEN="changeme-set-your-token" VIEWER_ASSERTION_SECRET="compose-viewer-secret" pnpm --filter @involute/server exec tsx src/index.ts
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

- Make single-team import a repeatable acceptance loop
- Keep the compose stack and CI reproducible
- Lock the core board lifecycle down with E2E before the larger UI/UX redesign

See [docs/vision.md](docs/vision.md) and [docs/milestones.md](docs/milestones.md) for the product direction.

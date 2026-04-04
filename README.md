# Involute

一人团队的 Linear 式项目管理系统开源实现。

Involute bundles a GraphQL API, a kanban web app, and a CLI that can export one Linear team, import it into Involute, verify the result, and then let you visually accept it in the board UI.

## Workspace layout

- `packages/server`: GraphQL API, Prisma schema, import pipeline
- `packages/web`: React + Vite kanban UI
- `packages/cli`: `involute` CLI for config, export, import, verify, issues, and comments
- `docs/vision.md`: current product vision
- `docs/milestones.md`: active milestones and sequencing

## Quick start

1. Install dependencies and create the repo `.env`.

```bash
pnpm install
cp .env.example .env
```

The default `.env.example` is enough for local Docker Compose. You only need to change it when you want a different auth token, port, or database URL.

2. Start the local stack with Docker Compose.

```bash
pnpm compose:up
```

3. Smoke check the stack.

```bash
curl http://localhost:4200/health
```

Then open `http://localhost:4201` in your browser.

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
DATABASE_URL="postgresql://involute:involute@127.0.0.1:5434/involute?schema=public" AUTH_TOKEN="changeme-set-your-token" pnpm --filter @involute/server exec tsx src/index.ts
```

Start the web app:

```bash
VITE_INVOLUTE_AUTH_TOKEN="changeme-set-your-token" VITE_INVOLUTE_GRAPHQL_URL="http://127.0.0.1:4200/graphql" pnpm --filter @involute/web exec vite --host 127.0.0.1 --port 4201
```

Run the CLI against that local API:

```bash
pnpm --filter @involute/cli exec node dist/index.js import team --token "$LINEAR_TOKEN" --team SON --keep-export --output .tmp/son-export
```

## Quality gates

Unit and integration checks:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Browser E2E:

```bash
pnpm e2e
```

The Playwright suite resets the local compose Postgres, seeds the base team, starts the API and web app, and verifies the full issue lifecycle: create, update, comment, delete comment, delete issue.

## Docker images

This repo ships one multi-target `Dockerfile` with `server`, `web`, and `cli` targets. The Docker Hub publish workflow expects these secrets:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

When they are set, `.github/workflows/docker-publish.yml` pushes:

- `${DOCKERHUB_USERNAME}/involute-server`
- `${DOCKERHUB_USERNAME}/involute-web`
- `${DOCKERHUB_USERNAME}/involute-cli`

The published `involute-web` image is a static production build. It bakes `VITE_INVOLUTE_GRAPHQL_URL` at build time, but it does not bake an auth token into the image. For local development and acceptance, the compose stack remains the reference runtime path and should stay green before publishing.

## Current focus

- Make single-team import a repeatable acceptance loop
- Keep the compose stack and CI reproducible
- Lock the core board lifecycle down with E2E before the larger UI/UX redesign

See [docs/vision.md](docs/vision.md) and [docs/milestones.md](docs/milestones.md) for the product direction.

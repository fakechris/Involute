# Involute

Involute is a self-hosted, Linear-compatible project management service. It includes a GraphQL API, a Linear import/export pipeline, a web kanban UI, and a CLI for workspace and issue operations.

## Workspace layout

- `packages/server` — GraphQL API, Prisma-backed data model, import pipeline, validation data helpers
- `packages/web` — React + Vite kanban web UI
- `packages/cli` — `involute` CLI for config, import/export, teams, issues, labels, and comments
- `packages/shared` — shared TypeScript utilities

## Environment

Create a repo-root `.env` file based on `.env.example`:

```env
DATABASE_URL=YOUR_DATABASE_URL_HERE
AUTH_TOKEN=YOUR_AUTH_TOKEN_HERE
VIEWER_ASSERTION_SECRET=YOUR_VIEWER_ASSERTION_SECRET_HERE
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

## Install and setup

```bash
pnpm install
cp .env.example .env
```

Then update `.env` with your PostgreSQL connection string and auth token.

The local service wiring used in this repo expects:

- PostgreSQL reachable for the API
- API on `http://localhost:4200`
- Web UI on `http://localhost:4201`

## Run with Docker Compose

The quickest local acceptance setup is Docker Compose. It starts PostgreSQL, the API, the web app, and a reusable CLI container.

```bash
# From the repository root
mkdir -p .tmp
docker compose up --build -d db server web
```

Smoke checks:

```bash
curl http://localhost:4200/health
curl http://localhost:4201
```

To stop the stack:

```bash
docker compose down
```
## Run the API

```bash
cd packages/server
pnpm build
PORT=4200 node dist/index.js
```

Health check:

```bash
curl http://localhost:4200/health
```

## Run the web app

```bash
cd packages/web
PORT=4201 npx vite --port 4201
```

By default the web app talks to `http://localhost:4200/graphql`.

## CLI usage

Build the CLI package first:

```bash
cd packages/cli
pnpm build
```

Configure the CLI against your running API:

```bash
node dist/index.js config set server-url http://localhost:4200
node dist/index.js config set token YOUR_AUTH_TOKEN_HERE
```

If you need the CLI or web UI to act as a specific user, mint a short-lived viewer assertion with a trusted secret and persist it:

```bash
export INVOLUTE_VIEWER_ASSERTION_SECRET=YOUR_VIEWER_ASSERTION_SECRET_HERE
node dist/index.js auth viewer-assertion create user@example.com --ttl 3600
node dist/index.js config set viewer-assertion SIGNED_ASSERTION_HERE
```

The web UI can use the same signed assertion via `VITE_INVOLUTE_VIEWER_ASSERTION` or localStorage key `involute.viewerAssertion`.

Common commands:

```bash
node dist/index.js teams list
node dist/index.js issues list --team INV
node dist/index.js issues create --team INV --title "My issue"
node dist/index.js comments add INV-1 --body "Hello from Involute"
node dist/index.js export --token YOUR_LINEAR_API_TOKEN --team SON --output ./export
node dist/index.js import --file ./export
node dist/index.js import verify --file ./export
node dist/index.js import team --token YOUR_LINEAR_API_TOKEN --team SON
```

## Single-Team import acceptance

The fastest real acceptance path is to run the end-to-end team import command, then inspect the board UI.

1. Start the API:

```bash
cd packages/server
PORT=4200 node dist/index.js
```

2. Start the web app:

```bash
cd packages/web
VITE_INVOLUTE_AUTH_TOKEN="$AUTH_TOKEN" npx vite --port 4201
```

3. Export your Linear token in the shell:

```bash
export LINEAR_API_TOKEN='lin_api_xxx'
```

4. Run the end-to-end team import:

```bash
docker compose run --rm cli import team --token "$LINEAR_API_TOKEN" --team SON --keep-export --output /exports/son-export
```

This command will:

- export the selected Linear team to `.tmp/son-export` on the host
- import the exported artifacts into Involute
- run `import verify` against the same export

5. Open `http://localhost:4201` and validate:

- the imported team appears in the team selector
- the board shows every imported issue for that team, not just the first page
- spot-check identifiers, states, labels, assignees, parent-child links, and comments

The board now hydrates issue pages until the selected team has been loaded completely, so large teams are no longer truncated at the first `200` issues during visual acceptance.
## Validation

Run workspace checks from the repository root:

```bash
pnpm typecheck
pnpm test
pnpm lint
```

GitHub Actions now runs the same `typecheck`, `lint`, `test`, and `build` gates on pull requests and pushes to `main`.

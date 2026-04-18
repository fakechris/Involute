# Milestones

## M0: Single-team migration acceptance

Status: done.

Done:

- `involute import team` runs export, import, and verify in one command
- import writes a lightweight summary artifact
- board and issue detail support create, update, comment, delete comment, and delete issue
- Playwright covers the full lifecycle against a real browser
- Docker Compose brings up db, api, web, and cli

Exit criteria:

- A real Linear team can be imported and visually accepted from the board
- `pnpm e2e` is green locally and in CI
- `docker compose up --build -d db server web` is a stable demo path

## M1: Deployable self-hosting

Status: in progress.

Scope:

- ship and validate a production deployment path for VPS first
- keep Railway as a possible later hosting target, not the current blocking path
- define `.env.production` expectations and runtime secrets
- add reverse proxy / TLS guidance and database backup guidance
- exercise public-domain deployment once and OAuth callback once
- keep the VPS-hosted `SON` dataset as the active source of truth after the final Linear refresh
- keep Docker images and compose-based demo/runtime aligned

Done inside M1 already:

- the Tailscale VPS deployment path has been exercised successfully against the latest mainline build
- the public-domain deployment path is serving the latest mainline build over HTTPS
- one backup and restore drill has been executed successfully
- the canonical `SON` dataset has been refreshed from Linear into the VPS stack

Exit criteria:

- a fresh host can run Involute with Postgres, API, and web using documented steps
- a public-domain deployment has been smoke-tested with Google OAuth and session cookies
- backup and restore have both been exercised once
- deployment docs are specific enough to reproduce without reading the source
- image publishing and runtime config are consistent with the supported hosting path

## M2: Auth and team permissions

Status: done.

Scope:

- move away from the current shared-token simplification
- add a real session-backed viewer model
- start with Google OAuth rather than magic-link email
- add `admin`, `team visibility`, and `team membership` edit boundaries
- add a bootstrap path for the first admin without touching raw headers

Exit criteria:

- an admin can sign in and manage access without touching raw headers
- public teams are readable but not writable by non-members
- private teams are only visible to members and admins
- team members can be granted viewer/editor-style access explicitly

## M3: UI/UX redesign

Status: in progress, but not the current release gate.

Scope:

- replace the old generic shell with the new visual system
- improve keyboard-first navigation, palette actions, filters, sorting, and saved views
- revisit issue detail and board density after production deployment stabilizes

Exit criteria:

- the old shell and compatibility layer are gone from the shipped routes
- board, backlog, access, and issue detail all use the new shell and interaction model
- redesign does not regress the M0 lifecycle, deployment path, or team permission model
- remaining UI work is polish, not structural replacement

## M4: Multi-team workspace import

Status: later.

Scope:

- workspace-level export/import
- team mapping strategy
- repeat import semantics

Exit criteria:

- multiple Linear teams can be brought in predictably
- repeated imports have explicit behavior and reporting

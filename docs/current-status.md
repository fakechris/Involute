# Current Status

Last updated against `main` at `351fd06`.

## Summary

Involute is past the local prototype stage. The single-team Linear migration loop is stable, the issue lifecycle is covered in browser E2E, Google OAuth plus session auth is in place, team-level RBAC exists in both API and web UI, and the web client has already moved onto the new shell and keyboard-first interaction model.

The main remaining milestone is not feature breadth. It is production sign-in confidence and operator confidence: validating Google OAuth on the real public callback, then tightening operator-facing polish around auth and access.

## What is done

### M0: Single-team migration acceptance

Done:

- `involute import team` runs export, import, and verify in one command
- the import flow writes a summary artifact
- the board supports create, update, comment, delete comment, and delete issue
- Playwright covers the core board lifecycle
- Docker Compose provides a stable local demo path
- the canonical `SON` team has been re-exported from Linear, re-imported into the VPS, and verified there

### M2: Auth and team permissions

Done:

- browser auth supports Google OAuth and session cookies
- trusted CLI/dev flows still support `AUTH_TOKEN` and signed viewer assertions
- global roles exist: `ADMIN`, `USER`
- team visibility exists: `PUBLIC`, `PRIVATE`
- team membership roles exist: `VIEWER`, `EDITOR`, `OWNER`
- minimal team access management exists in the web UI at `/settings/access`
- admin bootstrap exists through `ADMIN_EMAIL_ALLOWLIST` and `admin:bootstrap`

### M3: Web UX redesign

Substantially in progress:

- the old web shell has been replaced with the new app shell
- board, backlog, access, and issue detail all run inside the redesigned surface system
- keyboard-first navigation now includes command palette actions, board/backlog search focus, drawer previous/next navigation, and `g`-prefixed route shortcuts
- board and backlog now support filtering, sorting, saved views, and persisted local view state
- board bulk actions support state, assignee, and label changes

Not finished yet:

- deeper command-palette issue actions
- denser issue detail information layout
- final visual/interaction polish after deployment hardening

### Deployment tooling foundation

Done:

- production compose files exist
- Caddy-based reverse proxy config exists
- Ansible bootstrap and deploy playbooks exist
- GitHub Actions deploy workflow exists
- the latest `main` has been deployed to the VPS successfully and is reachable on the public domain
- a Postgres backup and restore drill has been executed successfully against the VPS stack
- the VPS dataset is now the active source of truth for `SON`

## What is not done yet

### M1: Deployable self-hosting

In progress:

- the VPS deployment path exists and has been exercised successfully on both Tailscale and the public domain
- Google OAuth on the real public callback URL still needs to be exercised in production
- operator runbook polish is still thinner than the deployment automation itself

### Auth/access product polish

Not blocking for engineering correctness, but still needed before broader operator use:

- clearer access-management UX
- better success/error feedback on access changes
- stronger regression coverage for public/private visibility and owner/editor/viewer behavior
- clearer operator-facing guidance for first-admin bootstrap

## Current recommended priority

1. Validate Google OAuth against the real public callback URL.
2. Tighten the operator runbook around deploy, rollback, logs, and restore.
3. Polish access-management UX and tighten auth/RBAC regression coverage.
4. Continue product polish on the redesigned web shell after deployment hardening.

## Deliberately not next

- multi-team workspace import
- large-scale performance work
- major visual redesign
- magic-link email auth
- broader enterprise auth/SSO work
- turning Railway into a fully supported path before the VPS path is proven

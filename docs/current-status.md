# Current Status

Last updated against `main` at `fc0b7ed`.

## Summary

Involute is past the local prototype stage. The single-team Linear migration loop is stable, the issue lifecycle is covered in browser E2E, Google OAuth plus session auth is in place, and team-level RBAC exists in both API and web UI.

The main remaining milestone is not feature breadth. It is production confidence: public-domain deployment, backup/restore validation, and operator-facing polish around auth and access.

## What is done

### M0: Single-team migration acceptance

Done:

- `involute import team` runs export, import, and verify in one command
- the import flow writes a summary artifact
- the board supports create, update, comment, delete comment, and delete issue
- Playwright covers the core board lifecycle
- Docker Compose provides a stable local demo path

### M2: Auth and team permissions

Done:

- browser auth supports Google OAuth and session cookies
- trusted CLI/dev flows still support `AUTH_TOKEN` and signed viewer assertions
- global roles exist: `ADMIN`, `USER`
- team visibility exists: `PUBLIC`, `PRIVATE`
- team membership roles exist: `VIEWER`, `EDITOR`, `OWNER`
- minimal team access management exists in the web UI at `/settings/access`
- admin bootstrap exists through `ADMIN_EMAIL_ALLOWLIST` and `admin:bootstrap`

### Deployment tooling foundation

Done:

- production compose files exist
- Caddy-based reverse proxy config exists
- Ansible bootstrap and deploy playbooks exist
- GitHub Actions deploy workflow exists
- Tailscale-only VPS deployment has already been exercised successfully
- Postgres backup script exists

## What is not done yet

### M1: Deployable self-hosting

In progress:

- the VPS deployment path exists, but public-domain deployment has not yet been fully validated end-to-end
- Google OAuth on the real public callback URL still needs to be exercised in production
- backup exists, but restore still needs a real drill

### Auth/access product polish

Not blocking for engineering correctness, but still needed before broader operator use:

- clearer access-management UX
- better success/error feedback on access changes
- stronger regression coverage for public/private visibility and owner/editor/viewer behavior
- clearer operator-facing guidance for first-admin bootstrap

## Current recommended priority

1. Finish public production deployment on VPS.
2. Run one real backup and restore drill.
3. Polish access-management UX and tighten auth/RBAC regression coverage.
4. Add an operator runbook for deploy, rollback, logs, and restore.

## Deliberately not next

- multi-team workspace import
- large-scale performance work
- major visual redesign
- magic-link email auth
- broader enterprise auth/SSO work
- turning Railway into a fully supported path before the VPS path is proven

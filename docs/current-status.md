# Current Status

Last updated against `main` at `351fd06`.

## Summary

Involute is past the local prototype stage. The single-team import loop is stable, the issue lifecycle is covered in browser E2E, Google OAuth plus session auth is in place, team-level RBAC exists in both API and web UI, and the web client has already moved onto the new shell and keyboard-first interaction model.

The product identity has shifted: Involute is a headless project-state and work-graph kernel that Agents call. The board is an optional projection, not the destination. The operational remaining work on M1 still matters — the VPS must stay trustworthy while the kernel is built.

The Linear-replacement track is M5. It starts from the current Issue/GraphQL kernel and adds typed links, context bundles, candidate/commitment, claim/lease, MCP, runs, and evidence. It does not start from a new WorkItem table or a new UI.

## What is done

### M0: Single-team migration acceptance

Done:

- `involute import team` runs export, import, and verify in one command
- the import flow writes a summary artifact
- the board supports create, update, comment, delete comment, and delete issue
- Playwright covers the core board lifecycle
- Docker Compose provides a stable local demo path
- the canonical `SON` team snapshot has been re-exported from the source system, re-imported into the VPS, and verified there

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
- the public-domain VPS path is already serving the latest mainline build over HTTPS
- one Postgres backup and restore drill has already been completed

## What is not done yet

### M1: Deployable self-hosting

VPS path is live. Operator procedure is in [ops.md](./ops.md):

- deploy / rollback / logs / compose status
- backup and restore (`scripts/postgres-backup.sh`, `scripts/postgres-restore.sh`)
- production smoke checklist (`pnpm smoke:prod`)

### Auth/access product polish

Not blocking for engineering correctness, but still needed before broader operator use:

- clearer access-management UX
- better success/error feedback on access changes
- stronger regression coverage for public/private visibility and owner/editor/viewer behavior
- clearer operator-facing guidance for first-admin bootstrap

### M5: Agent-native work-graph kernel

K0–K6 are implemented: product contract, work graph, context/ready, propose/commit/claim/reject, MCP, Skill, runs, evidence, outbound webhooks, and observation UI.

Agent protocol is MCP + work mutations. Comment heartbeats are not a client protocol.

## Current recommended priority

1. Ship the kernel and deploy the VPS onto this tree.
2. Keep the operator runbook, OAuth/session path, and backup/restore trustworthy (M1).
3. Do not add Linear-clone Inbox/Cycle/AgentSession products. Existing leftover routes are frozen.

## Deliberately not next

- multi-team workspace import
- Linear Inbox / Cycle / dashboard product work
- AgentSession live UI, Loops, or hosted coding sessions
- growing Inbox, Cycles, Projects, or My Issues
- large-scale performance work
- magic-link email auth
- broader enterprise auth/SSO work
- turning Railway into a fully supported path before the VPS path is fully operationalized

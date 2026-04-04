# Milestones

## M0: Single-team migration acceptance

Status: in progress, core path now implemented.

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

## M1: UI/UX redesign

Status: queued behind stability.

Scope:

- replace the current generic look with a sharper visual system
- improve typography, spacing, and hierarchy
- revisit issue detail and board density

Exit criteria:

- visual direction is intentional and no longer feels placeholder-like
- redesign does not regress the M0 lifecycle and import flow

## M2: Multi-team workspace import

Status: later.

Scope:

- workspace-level export/import
- team mapping strategy
- repeat import semantics

Exit criteria:

- multiple Linear teams can be brought in predictably
- repeated imports have explicit behavior and reporting

## M3: Auth and multi-user hardening

Status: later.

Scope:

- move away from the current shared-token simplification
- define a real viewer identity model
- add clearer trust boundaries for API and UI clients

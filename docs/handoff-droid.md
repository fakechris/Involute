# Droid Handoff

## Snapshot

- Repo baseline: `main` at `b0b459a` (`Add automated deployment tooling (#9)`).
- Product status:
  - `M0` single-team import acceptance: done
  - `M2` Google OAuth + team RBAC foundation: done
  - `M1` deployable self-hosting: partially done, not yet fully production-validated on a public domain
- Current slogan:
  - `一人团队的 Linear 式项目管理系统开源实现。`

## What Exists Today

### Core product

- Linear single-team migration loop is implemented:
  - `involute import team`
  - import summary artifact
  - `import verify`
  - board-based visual acceptance
- Web supports:
  - board view
  - issue detail
  - create/update issue
  - comment create/delete
  - issue delete
- E2E exists for the board lifecycle.

### Auth and permissions

- Browser auth path:
  - Google OAuth
  - session cookie
- Trusted local/dev path still exists:
  - `AUTH_TOKEN`
  - viewer assertion
- RBAC model exists:
  - global role: `ADMIN` / `USER`
  - team visibility: `PUBLIC` / `PRIVATE`
  - membership role: `VIEWER` / `EDITOR` / `OWNER`
- Minimal access UI exists at:
  - `packages/web/src/routes/AccessPage.tsx`

### Deployment and ops

- Compose demo/dev path exists:
  - `docker-compose.yml`
- Production compose path exists:
  - `docker-compose.prod.yml`
  - `Caddyfile`
  - `.env.production.example`
- Automated deployment exists:
  - local wrapper: `pnpm deploy:bootstrap`, `pnpm deploy:tailscale`, `pnpm deploy:prod`
  - Ansible: `ops/ansible/*`
  - GitHub Actions deploy workflow: `.github/workflows/deploy.yml`
- Backup script exists:
  - `scripts/postgres-backup.sh`
- Prisma is migration-driven now:
  - `packages/server/prisma.config.ts`
  - `packages/server/prisma/migrations/20260405093000_init/migration.sql`

## Important Files

- Product/docs:
  - `README.md`
  - `docs/vision.md`
  - `docs/milestones.md`
- Deployment:
  - `docker-compose.yml`
  - `docker-compose.prod.yml`
  - `Caddyfile`
  - `.github/workflows/deploy.yml`
  - `ops/ansible/playbooks/bootstrap-host.yml`
  - `ops/ansible/playbooks/deploy.yml`
  - `ops/ansible/templates/env.tailscale.j2`
  - `ops/ansible/templates/env.production.j2`
  - `scripts/ansible-playbook.sh`
  - `scripts/ensure-ansible.sh`
  - `scripts/postgres-backup.sh`
- Auth/RBAC:
  - `packages/server/src/auth.ts`
  - `packages/server/src/auth-routes.ts`
  - `packages/server/src/google-oauth.ts`
  - `packages/server/src/session.ts`
  - `packages/server/src/access-control.ts`
  - `packages/server/src/schema.ts`
  - `packages/web/src/App.tsx`
  - `packages/web/src/routes/AccessPage.tsx`
- Data model:
  - `packages/server/prisma/schema.prisma`
  - `packages/server/prisma/migrations/20260405093000_init/migration.sql`

## Non-Negotiable Constraints

- Do not commit:
  - real `.env`
  - `.env.production`
  - `ops/ansible/inventory/hosts.yml`
  - real hostnames, IPs, OAuth secrets, tokens, SSH private keys
- Keep local/dev and production deploy paths aligned:
  - do not add a second divergent deployment mechanism
- Do not regress:
  - `import team`
  - single-team acceptance flow
  - Google OAuth/session path
  - team visibility and write guards
- Preserve migration discipline:
  - prefer Prisma migrations
  - do not reintroduce `db push` as the normal production path

## Current Known Good Checks

- CI:
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm e2e`
  - `pnpm build`
  - `docker compose build`
- Manual deploy validation already exercised:
  - `pnpm deploy:bootstrap`
  - `pnpm deploy:tailscale`
- Remote smoke checks already validated on a Tailscale-only VPS path:
  - API `/health`
  - web `HTTP 200`

## Recommended Next Plan

### Phase 1: Finish M1 for Real Production

This is the highest-value next milestone. The tooling exists; what is missing is a real public production rollout with documented operator confidence.

#### Goal

- Make a fresh public VPS deployment reproducible without handholding.

#### Tasks

1. Production secrets and CI deploy rollout
- Configure repository secrets and vars for `.github/workflows/deploy.yml`.
- Add `DEPLOY_KNOWN_HOSTS` using a pinned host key, not runtime discovery.
- Decide whether production deploy remains manual-only or auto-on-main.

2. Public domain deployment
- Move from Tailscale-only validation to public domain + Caddy + HTTPS.
- Fill:
  - `APP_DOMAIN`
  - `APP_ORIGIN`
  - `POSTGRES_PASSWORD`
  - `GOOGLE_OAUTH_*`
  - `ADMIN_EMAIL_ALLOWLIST`
- Run `pnpm deploy:prod`.

3. Production smoke test checklist
- `curl -I https://<domain>`
- `curl https://<domain>/health`
- open web UI
- verify board loads
- verify login path renders correctly
- verify session cookie works through reverse proxy

4. Backup and restore drill
- Run `scripts/postgres-backup.sh`
- Restore that dump into a throwaway Postgres container
- confirm restored schema is valid and app boots

#### Exit Criteria

- A clean VPS can be deployed from repo state + docs + secrets only.
- Google login works on the public domain.
- Backup/restore has been exercised once, not just documented.

### Phase 2: Auth and Access Productization

The auth foundation exists, but the operational and UI experience still needs polish.

#### Goal

- Make admin/bootstrap/access management usable by a real operator without reading source code.

#### Tasks

1. Access UI polish
- Improve `AccessPage`:
  - clearer disabled states
  - owner/member explanations
  - explicit success/error feedback
  - better empty states
- Add small-screen polish and usability cleanup.

2. Admin bootstrap UX
- Surface current admin bootstrap expectations more clearly in UI/docs.
- Make it obvious how the first admin is created in production.
- Consider a read-only “system status” card for:
  - current viewer
  - whether OAuth is configured
  - whether the viewer is admin

3. Auth regression coverage
- Add E2E or integration coverage for:
  - unauthenticated user behavior
  - public team readable / non-member not writable
  - private team hidden from non-member
  - owner can manage access
  - non-owner editor cannot manage memberships

#### Exit Criteria

- First admin bootstrap is obvious and documented.
- Team access behavior is validated in tests, not only by code inspection.

### Phase 3: Production Hardening

This is the next technical layer once production is online.

#### Goal

- Reduce operational surprises and security gaps.

#### Tasks

1. Session and auth hardening
- Review cookie settings for production:
  - `Secure`
  - `HttpOnly`
  - `SameSite`
- Review OAuth error handling and user mismatch flows.

2. Observability
- Add structured request logging for API errors and deploy-time failures.
- Add a minimal operator runbook:
  - where logs live
  - how to inspect compose status
  - how to roll back to previous image/commit

3. Deployment ergonomics
- Consider splitting deploy workflow into:
  - `deploy-tailscale`
  - `deploy-production`
  if it improves readability
- Consider prebuilt image pull path for production to reduce VPS build time.

4. Restore confidence
- Add a restore script next to backup.
- Optionally add a CI job that validates backup script syntax.

#### Exit Criteria

- Production deploys are observable and reversible.
- Backup is paired with a documented restore path.

## Deliberately Not Next

These are not the next priority unless product direction changes:

- multi-team workspace import
- large-scale performance work
- major visual redesign
- magic-link email auth
- enterprise auth / SSO sprawl

## Suggested Detailed Task Order For Droid

1. Validate current `main` locally:
- `pnpm typecheck`
- `pnpm test`
- `pnpm e2e`

2. Validate current deploy path on a clean branch:
- `pnpm deploy:bootstrap`
- `pnpm deploy:tailscale`

3. Wire public production secrets into GitHub and/or operator environment.

4. Run first public `pnpm deploy:prod`.

5. Configure Google OAuth for the public callback URL.

6. Smoke test:
- sign in
- view board
- verify access rules

7. Add auth/access regression tests for public/private/member roles.

8. Run backup + restore drill.

9. Only after production is stable, revisit UI/UX redesign.

## Risks Droid Should Watch

1. Prisma config and Docker build coupling
- `packages/server/prisma.config.ts` now fails fast if `DATABASE_URL` is missing.
- Docker build already injects a build-time placeholder URL.
- Do not remove that path accidentally.

2. Compose variable interpolation
- Docker Compose will eagerly expand `$FOO` in shell snippets inside YAML.
- If shell variables are needed inside compose `command`, they must be escaped as `$$FOO`.

3. Sensitive inventory handling
- `ops/ansible/inventory/hosts.yml` must stay local-only.
- The example file is safe; the real inventory is ignored.

4. Session/auth dual path
- Browser path is OAuth + session.
- CLI/dev path still uses trusted token + viewer assertion.
- Do not accidentally break CLI while tightening browser auth.

5. RBAC regressions are easy to introduce in GraphQL resolvers
- Read guards and write guards live in server code, not only the UI.
- Any schema change around teams/issues/comments should be checked against `access-control.ts`.

## Recommended Acceptance Standard For Future PRs

Every PR touching deploy/auth/access should include:

- exact commands run
- whether Tailscale deploy was exercised
- whether public deploy behavior changed
- whether Google OAuth behavior changed
- whether RBAC behavior changed
- any env var additions/removals

## If Droid Has Time After M1

- Add a dedicated admin/system settings page instead of only team access.
- Add nicer operator feedback for deploy state.
- Add a small “import history” or “latest import summary” surface in the UI.
- Then start the UI/UX redesign track.

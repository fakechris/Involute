# npm-v0.2.0

Release date: 2026-09-01

`npm-v0.2.0` is the first release of the hardened Agent-native work-graph lifecycle. It completes Release A–E on top of the work-graph kernel merged in `cf3feb9`.

This is a source, npm, and container-image release. It does not mean the production VPS has been upgraded. Production remains on its previous deployment until an operator deploys the immutable image SHA and completes the authenticated smoke checklist in [docs/ops.md](../ops.md).

## Highlights

- Immutable SHA-only production deployments with a mandatory pre-deploy Postgres backup, fail-closed restore behavior, persistent uploads, and authenticated MCP smoke coverage.
- Revocable, hashed, MCP-only Agent credentials; scoped idempotency; revision compare-and-swap; and team-scoped human ownership validation.
- Claim-bound runs and run-bound evidence, explicit In Review state, human accept/reject operations, and independently retried webhook deliveries.
- One readiness predicate shared by ready-list and claim, semantic workflow-state matching, correct blocker handling, and serialized cycle-safe graph writes.
- Paginated candidate and graph observation, explicit UI error states, human review actions in web and CLI, and a documented boundary between graph `PROJECT` work and the frozen legacy `Project` entity.

## Release-review hardening

The release-candidate review also closed cross-layer failures that were not visible in the original unit-test pass:

- GraphQL now serializes the semantic `REVIEW` workflow type, and commit fails closed if a team has no `UNSTARTED` state.
- Ready-list and claim cover every work kind unless a caller explicitly filters by kind.
- Active runs remain bound to a live claim, concurrent run updates use compare-and-swap, and completing a run clears its claim reference before the lease row is removed.
- Agent credentials match only the `/mcp` path segment; MCP validates link types and required evidence run IDs at runtime.
- Webhook requests time out, active upload formats such as SVG are forced to download in a sandboxed response, and pagination/revision conflicts have explicit retry or reload behavior.
- Deployment validates the exact `sha-<12-40 hex>` image format and a production HTTPS origin; host backups survive rsync and occur before any legacy stack is stopped.

## Agent lifecycle

The supported execution path is:

1. Search or list ready committed work through MCP.
2. Read the work context and current revision.
3. Atomically claim work with a lease.
4. Report a run bound to that claim.
5. Attach evidence bound to the run.
6. Leave the item In Review for a human to accept or reject.

Agents do not claim through status changes, occupy the human assignee field, commit candidates, or move work directly to Done or Canceled. GraphQL Issue APIs remain the compatibility surface for the web app and CLI; MCP plus work mutations are the Agent protocol.

## Database migrations

Deployments must apply all four migrations in order:

- `20260901000000_agent_credentials_and_scoped_idempotency`
- `20260901005000_add_review_workflow_state`
- `20260901010000_run_claim_review_chain`
- `20260901015000_webhook_deliveries`

The production playbook runs the migration path as part of the immutable image deployment. Take and verify a backup first; do not substitute `prisma db push` for the production migration workflow.

## Operator checklist

Before production rollout:

- confirm the target image is the exact `sha-<commit>` built from this release
- run `sh scripts/postgres-backup.sh`
- run `pnpm deploy:prod`
- export `INVOLUTE_SMOKE_AUTH_TOKEN=<production-auth-token>` and run
  `pnpm smoke:prod https://<your-domain>` with valid MCP credentials
- verify uploads survive a server/container restart
- verify candidates, graph, work context, claim, run, evidence, and human review against production

If GitHub Actions is used, the required `DEPLOY_*` and `INVOLUTE_*` secrets must exist before dispatching the production profile. A successful npm or Docker publish does not prove that production was deployed.

## Compatibility notes

- Existing issue identifiers, imports, board flows, GraphQL Issue APIs, and CLI issue operations remain supported.
- Board and backlog surfaces project only `COMMITTED` work.
- Inbox, Cycles, Projects, My Issues, and Views remain frozen compatibility surfaces; this release does not extend them as products.
- Agent bearer credentials are accepted only by MCP endpoints, not GraphQL or browser APIs.
- Callers should supply idempotency keys and expected revisions for retryable Agent mutations.

# Work graph integrity and migration

Hierarchy writes require explicit repositories on both endpoints, with exactly equal persisted values, matching
project-scope queries (including case). Surrounding whitespace is rejected. Legal `CONTAINS` edges are PROJECT → MILESTONE,
MILESTONE → ISSUE and PROJECT → DECISION. Self links, cycles, cross-team edges and
cross-repository containment are rejected. Same-team cross-project `BLOCKS` remain
supported. Unattached work remains valid for intake; it is not silently assigned
to a guessed project or milestone.

`workLink(type: CONTAINS)` is idempotent for the same edge. Adding a different
parent now fails instead of removing the old parent. Use `issueUpdate` with
`parentId` and `expectedRevision` for an intentional move. Creating an issue with
a parent writes both `parentId` and `CONTAINS`; kind/repository changes validate
incident edges too. Direct link changes update the child's revision and audit.
All application graph writes use the same per-team transaction lock and reread
nodes after acquiring it.

These checks protect new writes; they do not rewrite historical invalid graphs.
Existing malformed structures can still be read. Resolve their intended milestone
before generating a migration. Query compatibility by repository does not imply
the stored hierarchy has been repaired.

The import pipeline imports source issues without hierarchy and reports every source
parent relationship as deferred in its warnings. Source exports and legacy ID
mappings remain available for explicit kind/repository selection through this tool.
Re-import never overwrites repaired parent mappings. Generic source-parity verification
will report deferred parent relationships as differences until those are resolved.

## Operator workflow

Run from a trusted operator shell with the intended `DATABASE_URL` in its secret
environment. The CLI requires a HUMAN ADMIN actor for apply and rollback. Database
access remains the operator boundary; use an audited shell session. No raw database
URL or exception is printed by CLI failures.

Create a request JSON with `teamId`, `reason` and 1–100 `entries`. Each entry must
provide `id`, `expectedRevision` and the complete intended `to` structure:

```json
{
  "teamId": "<team-uuid>",
  "reason": "Repair reviewed historical milestone membership",
  "entries": [{
    "id": "<work-uuid>",
    "expectedRevision": 7,
    "to": {
      "parentId": "<milestone-uuid>",
      "kind": "ISSUE",
      "repository": "owner/repository"
    }
  }]
}
```

An explicit `parentId: null` means an intentional detach, not an unresolved target.
Do not generate an apply plan until target selection is complete. Unknown fields,
missing fields, invalid IDs, duplicate entries and invalid projected graphs fail.

```sh
pnpm --filter @turnkeyai/involute-server graph:migrate preview \
  --request request.json --out reviewed-plan.json
pnpm --filter @turnkeyai/involute-server graph:migrate apply \
  --plan reviewed-plan.json --actor-id <human-admin-uuid>
pnpm --filter @turnkeyai/involute-server graph:migrate status --receipt <receipt-uuid>
pnpm --filter @turnkeyai/involute-server graph:migrate rollback \
  --receipt <receipt-uuid> --actor-id <human-admin-uuid>
```

Preview uses a repeatable-read transaction and writes no database rows. The output
file is created exclusively with mode 0600; an existing file is never overwritten.
Keep plans/receipts in private operator storage, outside the published repository.
Input files are limited to 4 MiB.

Apply compares the current team graph with the preview, validates the projected
batch and updates all entries, edges, revisions, audits and receipt in one
transaction. Any conflict rolls back the entire batch. A lost CLI response can be
recovered by repeating the same plan: its digest returns the existing database
receipt. A previously rolled-back plan also returns that receipt; generate a new
preview for a new operation.

The freshness guard deliberately covers the whole team's structural graph and
node revisions. An unrelated edit may therefore require a new preview. This
conservative boundary suits small operator repair batches; schedule a quiet window
instead of editing the generated snapshot to bypass a conflict.

Rollback requires the graph to match the recorded post-apply snapshot. It restores
only the changed nodes' old kind/repository/parent mappings and original incoming
edge identities, incrementing revisions and adding audits. It preserves workflow,
ownership, runs and evidence. It can restore a recorded historical invalid mapping;
this exception is restricted to the immutable receipt and never exposed through
ordinary graph writes. Newer graph/revision changes block rollback. Cross-team or
missing endpoints require separate recovery and cannot be invented by this tool.

## Release and verification

Apply `20260914000000_graph_migration_receipts` before starting the new server/CLI.
The migration only adds the receipt table. Existing rows are untouched. Old clients
must supply hierarchy kinds and repositories, and use explicit parent updates when
moving work. During a rolling upgrade, old instances can still write malformed
edges; upgrade all writers before relying on the new boundary.

Keep receipts when rolling back application code. An older server cannot perform
receipt-based recovery; retain a compatible operator CLI. This document does not
authorize any particular production repair batch.

On a dedicated `_test` database, run the `graph-integrity`, `graph-migration`,
`link-service` and `issue-service` test files. They cover stale lock reads, direct
link revision/audit, strict containment, safe reparenting, zero-write preview,
serialized duplicate apply, stale previews, atomic failure and guarded rollback.

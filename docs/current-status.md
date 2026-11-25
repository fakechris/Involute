# Current Status

Last reviewed on 2026-11-24 for the `npm-v0.3.0` release
([release notes](./releases/npm-v0.3.0.md)).

## Summary

Involute is a headless project-state and work-graph kernel that agents call
over MCP, with a web app where people plan, decide and review. The board is a
projection of committed work, not the destination.

It runs in production at <https://involute.lumenopen.com> on one VPS
(`oracle_5`), deployed by immutable `sha-<12>` image from `main`, with a
pre-deploy backup on every deploy and a daily verified backup with tiered
retention. The Involute repository itself, and several others, are tracked in
it day to day by people and agents.

## What is done

### Kernel and agent protocol (M5, K0–K6 and after)

- work graph with stable identifiers, delivery contracts and typed links;
  every committed item has exactly one parent (INV-718)
- propose → commit → claim → run → evidence → In Review → Done, with human
  gates; status is read from the server, never remembered (INV-1245)
- 21 grouped MCP tools at `/mcp` (read-only mirror `/mcp/readonly`), the
  protocol guide from `protocol_get_guide`, machine-readable docs at
  `/llms.txt`
- contract amendments, required acceptance and follow-ups, harness-issued
  branch names, PR traceability alerts and audit, project alias prefixes
- agent identity: profiles, owners, trust levels, push channels, hand-off
  chains, decision receipts
- autonomy policy L0–L3 per team and project
  ([autonomy-policy.md](./autonomy-policy.md))
- delivery packages and external executors
  ([external-executors.md](./external-executors.md)), scheduled rounds

### People's work

- Board, Backlog, Candidates, In Review, Needs you, Activity, Search, Graph,
  Projects, Milestones, Delivery, Bugs, Incidents, Hygiene, Ops and Settings —
  see the [user manual](./manual/README.md)
- bug flow with zero-bug triage, SLA and triage rotation; incident flow with
  severity, impact timestamps, postmortem and follow-up deadlines
- undo for common edits, custom fields, private files, saved views shared with
  the team, work-graph export / import
- one design system and a controlled on-screen vocabulary, both enforced in CI
  ([design-system.md](./design-system.md))

### Access and operations (M1, M2)

- Google OAuth sessions, invite-only sign-in with approved domains, workspace
  roles Admin / Member / Guest, team roles Viewer / Editor / Owner, project
  sharing ([permissions.md](./permissions.md))
- per-team GitHub connections through a GitHub App
  ([github-connection.md](./github-connection.md)), webhook intake with
  watermark reconciliation and dead-letter quarantine
- `scripts/deploy-prod.sh` (disk check, backup, rollback, prune), daily
  verified backup timer, restore drill, authenticated smoke
  ([ops.md](./ops.md))
- AIO single container, compose stacks, Ansible playbooks and a private
  Kubernetes deployment (`ops/k8s/involute-private`)

## Open

- **Off-box backups**: daily backups stay on the VPS disk; a second copy
  off the box is not set up yet.
- **npm publishing**: the `npm-v0.2.0` publish was refused (E404); the
  `NPM_TOKEN` repository secret must be renewed for tag releases to reach npm.
- Frozen compatibility surfaces (Inbox, Cycles, My Issues, the legacy Project
  entity) are kept working but not extended.

## Deliberately not next

- Linear-clone Inbox / Cycle / dashboard product work
- AgentSession live UI or hosted coding sessions
- multi-team workspace import
- magic-link email auth
- Railway as a supported hosting path

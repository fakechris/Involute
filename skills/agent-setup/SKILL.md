---
name: agent-setup
description: Use when wiring an MCP client to Involute (URL + Bearer inv_agent_…). Secrets stay in the agent secret store — never commit tokens.
---

# Agent setup

See full guide: [`docs/agent-setup.md`](../../docs/agent-setup.md).

## Local box defaults

- MCP URL: `http://127.0.0.1:4200/mcp` (or `/mcp/readonly`)
- Auth: `Authorization: Bearer inv_agent_…` (minted by Involute Ops / Settings → Agents)
- Example root config: [`mcp.json`](../../mcp.json) — placeholder header only

## Checklist

1. Confirm `/health` is OK.
2. Store token in the client secret store (chmod 600 file or secret manager).
3. Prefer readonly until propose/claim/report is required.
4. Load skills under `skills/` — start with [involute](../involute/SKILL.md) overview.

## Never

- Commit `inv_agent_…` values, token files, or `.env` auth.
- Point agents at `/graphql` with agent tokens.

## Verify the connection

Run `involute doctor --project <PROJECT identifier> --repository <owner/repo> --json`
after configuring the private CLI config. Exit 0 means every check passed; 2 means
configuration/authentication/compatibility is unresolved; 3 means service access
failed. The native MCP equivalent is `protocol_get_guide(project_id, repository)`:
inspect its `protocol` object, then refresh `tools/list`. Missing versions are
unknown, never assumed compatible. See [client diagnostics](../../docs/mcp-conformance.md).

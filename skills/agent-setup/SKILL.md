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

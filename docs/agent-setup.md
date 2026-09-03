# Connect an agent to Involute

Involute exposes a Streamable HTTP MCP server. Any MCP-compatible client
(Codex, Claude Code, Cursor, Opencode, Kimi, Droid, Amp, ZCode, Agy, …) can
connect with a URL plus an `Authorization` header. Behavior rules for agents
live in [`skills/involute/SKILL.md`](../skills/involute/SKILL.md).

## 0. Where is the server?

Pick the endpoint that matches where your agents run:

| Agents run… | MCP URL | How to bring it up |
|---|---|---|
| On this machine (local dev) | `http://localhost:4200/mcp` | `pnpm compose:up`, token = `AUTH_TOKEN` from repo-root `.env` |
| On the tailnet (private test phase) | `http://<tailscale-ip>:4200/mcp` | `pnpm deploy:tailscale` (see README VPS section) |
| Anywhere (production) | `https://<APP_DOMAIN>/mcp` | `pnpm deploy:prod` with `.env.production` |

The examples below use `https://involute.example.com/mcp`; substitute your
row from the table above. If `curl <your-base>/health` is not `OK`, stop —
agents cannot connect until the server is up.

## 1. Get a token

Each agent gets its own revocable credential with Linear-style scopes (`read`
always granted; add `propose`, `claim`, `report`, `update`, `link` as needed —
start least-privilege, e.g. read-only analysis starts on `/mcp/readonly`).

Fastest path: a team owner opens Settings → Agents in the web UI, picks
scopes, and copies the one-time token. Equivalent operator/SSH path (scoped
to exactly one team, optional expiry):

```bash
pnpm --filter @turnkeyai/involute-server agent:create -- INV "Codex production" codex-production@example.invalid
# scoped + expiring: agent:create -- INV "Temp reviewer" temp@example.invalid 2026-10-01T00:00:00Z --scopes read,propose
```

Store the printed `inv_agent_…` value in the agent's secret store. It is shown
once; only its hash is persisted. Agent tokens work on `/mcp` only, never on
`/graphql`. List or revoke at any time:

```bash
pnpm --filter @turnkeyai/involute-server agent:list
pnpm --filter @turnkeyai/involute-server agent:revoke -- <credential-id>
```

Start agents on the read-only endpoint until they need to create or claim work:

- full: `https://<host>/mcp`
- read-only: `https://<host>/mcp/readonly` (`work_search`, `work_get_context`, `work_list_ready` only)

## 2. Connect from each client

All examples below use `https://involute.example.com/mcp` and
`Authorization: Bearer inv_agent_…`. Replace the host and prefer
`/mcp/readonly` for analysis-only agents.

### Codex

```bash
codex mcp add involute --url https://involute.example.com/mcp
# analysis-only:
codex mcp add involute-readonly --url https://involute.example.com/mcp/readonly
```

Authenticate with the agent token when prompted, or export it per the Codex
MCP auth settings.

### Claude Code

```bash
claude mcp add --transport http involute https://involute.example.com/mcp \
  --header "Authorization: Bearer inv_agent_…"
```

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "involute": {
      "url": "https://involute.example.com/mcp",
      "headers": { "Authorization": "Bearer inv_agent_…" }
    }
  }
}
```

### Opencode

`opencode.json`:

```json
{
  "mcp": {
    "involute": {
      "type": "remote",
      "url": "https://involute.example.com/mcp",
      "headers": { "Authorization": "Bearer inv_agent_…" }
    }
  }
}
```

### Kimi / Droid / Amp / ZCode / Agy and other MCP clients

Add a remote (Streamable HTTP) MCP server with:

- URL: `https://involute.example.com/mcp` (or `/mcp/readonly`)
- Header: `Authorization: Bearer inv_agent_…`

Refer to the client's own docs for where it stores MCP server entries; the
wire protocol is standard MCP JSON-RPC (`initialize` → `tools/list` →
`tools/call`).

## 3. Verify the connection

```bash
curl -s -X POST https://involute.example.com/mcp \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer inv_agent_…' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400
```

You should see `work_search`, `work_propose`, `work_claim`, `run_report`, …
(`tools/list` on `/mcp/readonly` returns only the three read tools.)

## 4. What agents may and may not do

Enforced server-side, not just documented:

- agents can propose candidates, claim ready work, update non-contract fields,
  report runs, and attach evidence
- agents **cannot** commit or reject candidates, accept work, move anything to
  Done, or rewrite `acceptance/scope/verification/outcome/constraints` on
  committed work — those calls fail with `FORBIDDEN` and the agent must ask a
  human
- completed runs move work to In Review, never Done

## 5. Rotate or revoke

- Rotate: create a replacement credential, update the agent's secret store,
  then revoke the old credential ID. Revocation takes effect on the next MCP
  request.
- If a token leaks, revoke first (`agent:revoke`), ask questions later —
  revocation is immediate and auditable per credential ID.

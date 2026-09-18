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

### Where each client keeps its global MCP entry

Every client below reads a **user-level** file. Put the Involute entry there,
not in a repository-level file, so two people sharing a checkout never share a
credential. Paths are for macOS/Linux home directories; key names differ per
client and are the exact ones each client parses.

| Client | Global file | Entry shape |
|---|---|---|
| Claude Code | `~/.claude.json` → `mcpServers.involute` | `{"type":"http","url":…,"headers":{"Authorization":"Bearer …"}}` (or `claude mcp add --scope user`) |
| Codex | `~/.codex/config.toml` → `[mcp_servers.involute]` | `url = "…"` + `http_headers = { "Authorization" = "Bearer …" }` |
| ZCode | `~/.zcode/cli/config.json` → `mcp.servers.involute` | `{"type":"http","url":…,"headers":{…}}` |
| Droid (Factory) | `~/.factory/mcp.json` → `mcpServers.involute` | `{"type":"http","url":…,"headers":{…}}` |
| Gemini CLI | `~/.gemini/settings.json` → `mcpServers.involute` | `{"url":…,"headers":{…}}` |
| Antigravity CLI (`agy`) | `~/.gemini/config/mcp_config.json` → `mcpServers.involute` | `{"serverUrl":…,"headers":{…}}` — note `serverUrl`, and this is a different file from Gemini CLI's |
| Grok CLI | `~/.grok/config.toml` → `[mcp_servers.involute]` | `url = "…"` + `headers = { "Authorization" = "Bearer …" }` |
| Cursor | `~/.cursor/mcp.json` → `mcpServers.involute` | `{"url":…,"headers":{…}}` |
| Opencode | `~/.config/opencode/opencode.json` → `mcp.involute` | `{"type":"remote","url":…,"headers":{…}}` |
| Kimi Code | check `kimi mcp list` for the active file | remote entry with `url` + `headers` |
| DeepSeek Harness (`dsh`) | per profile under `~/.dsh/profiles/<name>/`; check the profile's MCP section | remote entry with `url` + `headers` |

Add a second entry named `involute-readonly` pointing at `/mcp/readonly` for
analysis-only use.

### Rules that keep identities straight

1. **One client, one credential, named after the client.** Issue `codex`,
   `claude-code`, `droid`, `gemini`, … as separate agents in Settings → Agents.
   Involute attributes proposals, claims, runs and inbox requests to the
   credential; two clients on one token are indistinguishable.
2. **The credential lives only in the user-level file above, as plain text.**
   Do not reference it as `${SOME_VAR}`: desktop apps launched from the Dock or
   a launcher do not read `~/.zshrc`, and the client silently fails to
   authenticate. Do not put a real token in a repository-level `.mcp.json`,
   `.cursor/mcp.json` or `.grok/config.toml`; those are shared by everyone who
   opens the checkout. The repo-root `mcp.json` here is a placeholder example.
3. **The server's `AUTH_TOKEN` is not an agent identity.** It authenticates as
   a trusted system with no actor; on production, writes made with it have no
   attributable author. It exists for the `involute` CLI and operator scripts
   only. Never hand it to a coding agent.

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
- completed runs move work to In Review; Done is human review or CLEAR auto-accept (agents still cannot mark Done)

## 5. Rotate or revoke

- Rotate: create a replacement credential, update the agent's secret store,
  then revoke the old credential ID. Revocation takes effect on the next MCP
  request.
- If a token leaks, revoke first (`agent:revoke`), ask questions later —
  revocation is immediate and auditable per credential ID.
- Retire an actor from its page (`/agents/<handle>` → Manage → Deactivate):
  every credential is revoked, the id and history stay, and the change is
  recorded in ActorAudit with your reason. Reactivate from the same place;
  revoked credentials stay revoked, so issue a fresh one afterwards. Only the
  accountable owner or an ADMIN sees these controls.
- Every step is on the actor's page under Recent activity: `created`,
  `credential-issued`, `credential-revoked`, `deactivated`, `reactivated`,
  `owner-transferred`, each with who did it and the reason given. Each
  credential also shows who issued it. Actors and credentials older than
  INV-604 (2026-09-18) have no issuer and may have no creation time; those
  blanks are real gaps, not defaults.

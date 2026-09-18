# Connect an agent to Involute

Involute exposes a Streamable HTTP MCP server. Any MCP-compatible client
(Codex, Claude Code, Cursor, Opencode, Kimi, Droid, Amp, ZCode, Agy, Grok, …)
can connect with a URL plus an `Authorization` header. Behavior rules for
agents live in [`skills/involute/SKILL.md`](../skills/involute/SKILL.md).

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

Each **coding client** gets its own revocable `inv_agent_…` credential with
Linear-style scopes (`read` always granted; add `propose`, `claim`, `report`,
`update`, `link` as needed — start least-privilege, e.g. read-only analysis
starts on `/mcp/readonly`). Name the agent after the client (`grok`, `codex`,
`droid`, `gemini`, …) so inbox, claims and audits can tell them apart.

Fastest path: a team owner opens Settings → Agents in the web UI, picks
scopes, and copies the one-time token. Equivalent operator/SSH path (scoped
to exactly one team, optional expiry):

```bash
pnpm --filter @turnkeyai/involute-server agent:create -- INV "Grok" grok@agents.involute.local
# scoped + expiring: agent:create -- INV "Temp reviewer" temp@example.invalid 2026-10-01T00:00:00Z --scopes read,propose
```

Store the printed `inv_agent_…` value in that client's **user-level** config
file (see §2). It is shown once; only its hash is persisted. Agent tokens work
on `/mcp` only, never on `/graphql`. List or revoke at any time:

```bash
pnpm --filter @turnkeyai/involute-server agent:list
pnpm --filter @turnkeyai/involute-server agent:revoke -- <credential-id>
```

Start agents on the read-only endpoint until they need to create or claim work:

- full: `https://<host>/mcp`
- read-only: `https://<host>/mcp/readonly` (`work_search`, `work_get_context`, `work_list_ready` only)

The server's static `AUTH_TOKEN` is **not** an agent identity. It authenticates
as a trusted system with no actor; production writes made with it have no
attributable author. Keep it in `~/.involute/config.json` for the `involute`
CLI (`/graphql`) and operator scripts. Never hand it to a coding agent.

## 2. Connect from each client

All examples below use `https://involute.example.com/mcp` and
`Authorization: Bearer inv_agent_…`. Replace the host and prefer
`/mcp/readonly` for analysis-only agents.

There is no cross-CLI MCP config. Each client has its own global file and
variable-expansion rules. `~/.agents/mcp.json` is a ZCode optional source, not
an industry default.

### Rules that keep identities straight

1. **One client, one credential, named after the client.** Two clients on one
   token are indistinguishable in audit. A client with no `inv_agent_` token
   that falls back to `AUTH_TOKEN` is not a "generic agent" — it is **no
   identity**.
2. **The credential lives only in the user-level file below, as plain text.**
   Do not write `${SOME_VAR}`: desktop apps launched from the Dock or a
   launcher do not read `~/.zshrc`, and the client silently fails to
   authenticate. Do not put a real token in a repository-level `.mcp.json`,
   `.cursor/mcp.json`, or `.grok/config.toml`; those are shared by everyone who
   opens the checkout. The repo-root [`mcp.json`](../mcp.json) is a placeholder
   example (`Bearer ${INV_AGENT_TOKEN}` only).
3. **Grok, Codex and similar clients may also scan Claude/Cursor configs.**
   If the native user file has no `involute` entry, the client will inherit
   another client's token and every write is attributed to that other agent.
   Put a same-named `involute` entry in the native file so it wins.

### Where each client keeps its global MCP entry

Paths are for macOS/Linux home directories. Key names differ per client and
are the exact ones each client parses. Add a second entry named
`involute-readonly` pointing at `/mcp/readonly` for analysis-only use.

| Client | Global file | Entry shape | Verify |
|---|---|---|---|
| Claude Code | `~/.claude.json` → `mcpServers.involute` | `{"type":"http","url":…,"headers":{"Authorization":"Bearer inv_agent_…"}}` | `claude mcp list`; header must be plaintext `inv_agent_`, not `AUTH_TOKEN` |
| Codex | `~/.codex/config.toml` → `[mcp_servers.involute]` | `url = "…"` + `http_headers = { "Authorization" = "Bearer inv_agent_…" }` (note `http_headers`, not `headers`) | `codex mcp list` |
| ZCode | `~/.zcode/cli/config.json` → `mcp.servers.involute` | `{"type":"http","url":…,"headers":{…}}` | `zcode mcp list` (or open the file) |
| Droid (Factory) | `~/.factory/mcp.json` → `mcpServers.involute` | `{"type":"http","url":…,"headers":{…}}` | open the file; restart Droid |
| Gemini CLI | `~/.gemini/settings.json` → `mcpServers.involute` | `{"url":…,"headers":{…}}` | open the file; restart Gemini |
| Antigravity CLI (`agy`) | `~/.gemini/config/mcp_config.json` → `mcpServers.involute` | `{"serverUrl":…,"headers":{…}}` — note `serverUrl`, and this is a **different file** from Gemini CLI | open the file |
| Grok CLI | `~/.grok/config.toml` → `[mcp_servers.involute]` | `url = "…"` + `[mcp_servers.involute.headers] Authorization = "Bearer inv_agent_…"` (note `headers`, not Codex's `http_headers`) | `grok mcp doctor involute`; `grok inspect` → `source.type` must be `configToml` |
| Cursor | `~/.cursor/mcp.json` → `mcpServers.involute` | `{"url":…,"headers":{…}}` | open the file; reload MCP |
| Opencode | `~/.config/opencode/opencode.json` → `mcp.involute` | `{"type":"remote","url":…,"headers":{…}}` | open the file |
| Kimi Code | check `kimi mcp list` for the active file | remote entry with `url` + `headers` | `kimi mcp list` |
| DeepSeek Harness (`dsh`) | per profile under `~/.dsh/profiles/<name>/` | remote entry with `url` + `headers` | check the active profile's MCP section |
| involute CLI | `~/.involute/config.json` | GraphQL `token` = server `AUTH_TOKEN` (not `inv_agent_`) | CLI talks to `/graphql`; do not reuse this token in any coding agent |

Wire-level check that works for every `inv_agent_` token (see §3): `POST /mcp`
`tools/list` returns `work_search`, `work_propose`, `work_claim`, …

### Grok CLI

Grok's native MCP config is **independent**: user-level `~/.grok/config.toml`.
It is not `~/.agents/mcp.json`. Default `grok mcp add` writes `--scope user`.
Do not use `--scope project` for Involute — that writes `.grok/config.toml` in
the checkout.

```toml
[mcp_servers.involute]
url = "https://involute.example.com/mcp"
enabled = true

[mcp_servers.involute.headers]
Authorization = "Bearer inv_agent_…"
```

```bash
grok mcp add --transport http involute https://involute.example.com/mcp \
  --header "Authorization: Bearer inv_agent_…"
```

Write the token as plain text. Grok *does* expand `${VAR}` in `url` / `headers`
at load time; a Dock-launched Grok still will not see variables from
`~/.zshrc`.

Grok also scans Claude (`~/.claude.json`) and Cursor (`~/.cursor/mcp.json`) by
default. Merge order: `config.toml` > Claude > Cursor > project `.mcp.json`.
A missing native `involute` entry means Grok silently uses Claude's (or
Cursor's) token. Confirm the native file won:

```bash
grok mcp doctor involute
grok inspect --json
# involute.source.type == "configToml"
# involute.source.path == "~/.grok/config.toml"
```

In an already-running TUI: `/mcps`, then `r` to reload.

### Codex

Global file: `~/.codex/config.toml`. Codex uses `http_headers`, not `headers`.

```bash
codex mcp add involute --url https://involute.example.com/mcp
# analysis-only:
codex mcp add involute-readonly --url https://involute.example.com/mcp/readonly
```

```toml
[mcp_servers.involute]
url = "https://involute.example.com/mcp"
http_headers = { "Authorization" = "Bearer inv_agent_…" }
```

Authenticate with the agent token when prompted, or paste it into
`http_headers` as plain text. Do not leave this entry on the server
`AUTH_TOKEN`.

### Claude Code

Global file: `~/.claude.json` (`mcpServers.involute`). Prefer `--scope user`
so the token is not stored in a project file.

```bash
claude mcp add --scope user --transport http involute https://involute.example.com/mcp \
  --header "Authorization: Bearer inv_agent_…"
```

### Cursor

User-level `~/.cursor/mcp.json` (not `<repo>/.cursor/mcp.json`):

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

User-level `~/.config/opencode/opencode.json`:

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

### ZCode / Droid / Gemini / Agy and other MCP clients

Add a remote (Streamable HTTP) MCP server with:

- URL: `https://involute.example.com/mcp` (or `/mcp/readonly`)
- Header: `Authorization: Bearer inv_agent_…` (plain text, in the global file
  from the table above)

The wire protocol is standard MCP JSON-RPC (`initialize` → `tools/list` →
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

For Grok specifically, `grok mcp doctor involute` must report a healthy
handshake and `grok inspect` must show `source.type = configToml`. If the
source is `claudeJson` or `mcpJson`, Grok is still borrowing another client's
token.

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

- Rotate: create a replacement credential, update **that client's** user-level
  file, then revoke the old credential ID. Revocation takes effect on the next
  MCP request.
- If a token leaks, revoke first (`agent:revoke`), ask questions later —
  revocation is immediate and auditable per credential ID.

# Connecting GitHub (INV-1677)

Involute reads pull requests and branches to put commits, PRs and merge SHAs on
work (AGENTS.md §8). Each **team** connects its own GitHub accounts and
organisations; credentials live in the database, sealed with one server key.

## The one server setting

`INVOLUTE_SECRET_KEY` — any long random string (`openssl rand -hex 32`), set
once in the server environment and passed to the server container. It seals
every GitHub secret Involute stores (App private key, webhook secret, team
tokens). Losing or changing it makes those values unreadable: reconnect GitHub;
no other data is affected.

## How a repository is read

A repository belongs to the team whose PROJECT names it (`repository` on the
PROJECT, §8.6). Its credential is, in order:

1. the team's **App installation** for the repository's owner — an hour-long
   token minted from the instance GitHub App, cached and renewed;
2. a read-only **token the team pasted** for that owner;
3. the server-wide `GITHUB_TOKEN`, kept only as a fallback for installations
   that set it before connections existed.

One team's credential never reads another team's repositories.

## Routing

GitHub delivers to `<APP_ORIGIN>/api/webhooks/github`. Both the web container's
nginx (`packages/web/nginx.conf`) and the Caddy front (`Caddyfile`) forward
`/api/webhooks/*` to the server unchanged; the server checks the
`X-Hub-Signature-256` HMAC.

## The wizard: Settings → GitHub

1. **The deployment's GitHub App** — a workspace Admin clicks *Create GitHub
   App* (optionally under an organisation). GitHub opens with a prefilled
   manifest: read-only Pull requests / Contents / Metadata / Checks / Actions,
   events `pull_request` and `create`, deliveries to `/api/webhooks/github`,
   setup URL `/auth/github-app/installed`. After *Create*, GitHub returns to
   `/auth/github-app/created`; the server exchanges the one-time code for the
   App id, private key and webhook secret and seals them. The App is public so
   other teams' organisations can install it; an installation does nothing
   until a team binds it (step 2). Once the App exists the server starts its
   inbound worker and sync engine without a restart.
2. **Connect your teams** — a team Owner (or Admin) clicks *Install on GitHub*.
   Involute signs a one-hour state naming the team and the person; GitHub
   passes it back on the setup URL and the installation is bound to that team.
   One installation belongs to one team. *Repositories* lists what the
   connection reads and offers *Create project* for repositories without a
   PROJECT. *Use a token instead* stores a read-only fine-grained token for one
   owner (checked with GitHub first). *Disconnect* removes the connection.
3. **Is it working** — every repository a team's PROJECT names: the credential
   that reads it (App, team token, server `GITHUB_TOKEN`, or none), how far the
   sync has read its pull requests, and dead letters.

A delivery from an installation acts only on repositories routed to the team
that installation belongs to. An uninstall or suspension (GitHub's
`installation` event), a refused installation token or an HTTP 401 marks the
connection disconnected; it then waits for the team's Owners in Needs you
(`GITHUB_DISCONNECTED`) until it is reconnected or removed.

## Production record

- 2026-11-07: fakechris/Involute's production created the deployment App
  (`Involute involute.lumenopen.com`, owned by fakechris) and team INV
  installed it on the fakechris account for all repositories. This page's
  pull request was the first delivered through the App.

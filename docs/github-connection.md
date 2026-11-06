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

The setup wizard (Settings → GitHub) arrives in the following stages of
INV-1677: creating the instance App, installing it per team, and the health
view.

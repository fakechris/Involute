# Project sharing (INV-832 / INV-833)

## The problem

Read access is team-shaped: a person reads the issues of the teams they are
on (or PUBLIC teams), an agent reads the team its credential is bound to.
That leaves no way to show one project to someone outside the team. Moving
the project out is not an option either: an issue's team cannot change, and
identifiers carry the team key, so a move would either renumber every issue
(breaking every PR, branch and comment that references it) or scatter
`INV-…` identifiers across teams.

## The rule

A `PROJECT` node (an `Issue` with `kind = PROJECT`) can be **shared** with a
person or an agent. The share is the permission carrier; nothing moves.

A share on project P grants its holder access to the **scope of P**:

1. P itself;
2. everything P contains, transitively, through `parentId` and `CONTAINS`
   links (`getContainsDescendantIds`);
3. every issue in P's team whose `repository` equals P's repository — the
   board's older notion of "project", which predates the node.

Two roles:

| role | may |
|---|---|
| `VIEWER` | read the scope |
| `EDITOR` | read and write the scope: update, comment, claim, link |

Creating new work under P still needs write access on the team. Team
management (roster, visibility, agents) is never granted by a share.

## Where it is enforced

- `resolveShareScope` (`project-sharing.ts`) computes the holder's scope
  once per request in `createGraphQLContext`; ADMIN and trusted-system
  callers skip it. The result lives on `context.shareScope`.
- `buildReadableIssueWhere` = *(in a team you are on) OR (in your share
  scope)*. Every list, search and MCP read goes through it.
- `buildReadableTeamWhere` additionally exposes a team that has a shared
  project in it — name, key and workflow states, so the board can render —
  but `assertCanReadIssue` does **not** treat such a team as readable: an
  issue outside the scope in that team stays invisible. Rosters remain
  behind `canManageTeamMemberships`; `buildVisibleUsersWhere` is unchanged.
- `assertCanWriteIssue` accepts an `EDITOR` share over the issue before
  falling back to team write rights.
- `workShareUpsert` / `workShareRemove` require `assertCanManageTeam` on the
  project's team (team OWNER or ADMIN). `Issue.shares` is empty for anyone
  else. Every change writes a `WorkAudit` row on the project with the reason
  (`shared with @x as EDITOR`, `share for @x removed`).

## Sharing with an agent

Agents are users too; a share can name an agent actor. Its credential still
binds it to one team for team-level writes, but the shared scope becomes
readable (or writable) through the same rule. This is how one agent can be
handed a single project in another team.

## What a share holder sees

Open `/?team=<KEY>&project=<identifier or alias>`. The team appears in the
switcher, the project filter is preselected, and the board holds only the
issues in scope. Members and Settings show nothing for that team.

# Permissions

Who can get in, what they can see, what they can change, and where in the
product each of those is decided. This document is the rule; code and tests
follow it. Decisions recorded here were made on 2026-09-28.

## 1. Who can sign in

Google sign-in is the only door. An account gets in when **one** of these is
true, checked in this order:

1. A user row already exists for the email and is not suspended. This covers
   everyone who has signed in before and everyone who was **invited** (an
   invite creates the row before the person first signs in).
2. The email's domain is in the workspace's **approved domains**
   (Settings → Administration → Security). The person joins as a Member and
   is added to the **default teams**.
3. The email is in `ADMIN_EMAIL_ALLOWLIST`. This exists to bootstrap the first
   admin of a fresh server; see §2.3.

Anyone else is refused at the callback with "This workspace is invite-only.
Ask an admin to invite you." No row is created for them.

A suspended person (§2.4) is refused even though their row exists.

## 2. Workspace roles

| Role | Stored as | Sees | Can |
|---|---|---|---|
| **Admin** | `globalRole = ADMIN` | everything, including private teams | everything below, plus the Administration settings |
| **Member** | `globalRole = USER` | public teams, the teams they belong to, projects shared with them | work in their teams per team role (§3); join public teams; create teams when allowed (§5) |
| **Guest** | `globalRole = GUEST` | only the teams they were added to and projects shared with them — never public teams by default | work per team role; never a team Owner; cannot create teams or issue agent credentials |

The stored value `USER` is displayed as "Member" everywhere.

### 2.1 Changing a role

Only an Admin changes someone's workspace role, from Settings →
Administration → Members. The last active Admin cannot be demoted or
suspended. Every change is written to `ActorAudit` with who made it.

### 2.2 Inviting

Admins invite from Settings → Administration → Members. A Member may invite
only when "Members can invite" is on (Security); Members can invite Members
and Guests, never Admins. An invite names an email, a workspace role and the
teams (with team roles) the person joins. It creates the user row with no
Google identity yet: that row is the invite, shown as **Pending** until the
person first signs in. Revoking a pending invite deletes that row and its
memberships; nothing else refers to it yet.

A team Owner can also add an existing workspace member to their team from the
team's Members page; adding a brand-new email there is an invite and follows
the rules above.

### 2.3 The admin allowlist

`ADMIN_EMAIL_ALLOWLIST` makes a person Admin **only when their row is
created** by sign-in, and as a recovery path when the workspace has no active
Admin at all. It no longer re-promotes on every sign-in: an Admin who was
demoted in the UI stays demoted.

### 2.4 Suspending

An Admin can suspend a person (Members → ⋯ → Suspend). Suspension sets
`deactivatedAt`, deletes their sessions (they are signed out at once) and
refuses future sign-in. Their history, assignments and authored work stay.
Reactivation clears the flag; team memberships are kept throughout. The last
active Admin cannot be suspended. Agents and services keep their own
lifecycle (see `docs/actor-model.md`).

## 3. Team roles

| Team role | Shown as | Can |
|---|---|---|
| `VIEWER` | Viewer | read the team's work |
| `EDITOR` | Member | also create and edit work, comment, claim, commit and review |
| `OWNER` | Owner | also manage the team: members and roles, name, visibility, archive, workflow states, triage rotation, agent credentials, webhooks, project sharing |

Admins act as Owner of every team without being on the roster.

Rules:

- A team always keeps at least one Owner.
- Guests cannot be Owners.
- Every member of a team sees the whole roster with roles; only Owners and
  Admins change it.
- Any member can **leave** a team, except its last Owner.
- A Member (workspace role) can **join a public team** themself as a team
  Member (`EDITOR`). Private teams are joined only by being added.

## 4. Visibility

- **Public team**: every workspace Member can see it and its work, and join it.
  Guests cannot see it unless added.
- **Private team**: only its members and Admins.
- **Shared project** (`docs/project-sharing.md`): a person or agent given a
  project sees that project, what it contains and the team's issues on its
  repository, and nothing else in the team.
- People: you see yourself, members of teams you can see, agents you own and
  agents bound to teams you can see. A person on no team sees only themself.

Only the permission a screen needs is shown. Every create, invite, manage and
share control is rendered only when the server says the viewer may use it
(`Team.viewerCanWrite`, `Team.viewerCanManage`, `Issue.viewerCanShare`,
`AgentProfile.viewerCanManage`, the viewer's workspace role). The server
check is the rule; the UI never offers what the server would refuse.

## 5. Team lifecycle

| Action | Who | Notes |
|---|---|---|
| Create | Admin; Members too when "Members can create teams" is on | creator becomes Owner; the team gets the default workflow states |
| Rename, change visibility | team Owner, Admin | the key never changes: identifiers (`INV-123`) carry it |
| Archive / unarchive | team Owner, Admin | archived teams are read-only and hidden from the sidebar; nothing is deleted |
| Delete | nobody | identifiers, PR references and audit rows must keep resolving |

## 6. Agents

Unchanged from `docs/actor-model.md`: a credential is bound to one team and
carries scopes; issuing or revoking it is managing that team (Owner or Admin).
Guests cannot issue credentials. Agents never sign in to the web app and
never hold a workspace role.

## 7. Where each thing lives

**Settings → Account** (everyone): Profile, Preferences.

**Settings → Administration** (Admins only):

- **Members** — every person: role, teams, status (Active / Pending /
  Suspended), last seen. Invite, change role, suspend, reactivate, revoke
  a pending invite.
- **Teams** — every team including private and archived: members count,
  visibility, Owners. Create team; open a team's settings.
- **Security** — approved domains, default teams for people who join by
  domain, "Members can invite", "Members can create teams".
- **Labels**, **Server features** (unchanged).

**Team → Members** (`/teams/<KEY>/members`, in the sidebar under each team):
the roster with roles. Owners and Admins add, change roles and remove;
members leave; non-members of a public team join.

**Team → Settings** (`/teams/<KEY>/settings`, Owners and Admins): General
(name, visibility, archive), Workflow states, Bug triage, Agents (credentials
for this team), Webhooks.

Retired: the "Members & access" settings tab, `/settings/access` and the
workspace-level `/members` page; their links redirect to the pages above.

# API Reference

## Overview

Involute exposes three HTTP surfaces today:

- REST-like auth and health endpoints on the same server origin
- a GraphQL API at `/graphql`
- a Streamable HTTP MCP endpoint at `/mcp` (read-write) and `/mcp/readonly`

The GraphQL schema is the compatibility facade used by the web app and CLI. Agent-facing reads should prefer `workContext` and `readyWork` over composing `issues` filters. Writes for the kernel are `workPropose`, `workCommit`, `workReject`, and `workClaim`. `runReport` and `evidenceAttach` move work to In Review, never Done. Comments are a human observation surface, not an agent heartbeat.

See [vision.md](./vision.md) and [milestones.md](./milestones.md) for the kernel direction.

Default local endpoints:

- `http://localhost:4200/health`
- `http://localhost:4200/auth/*`
- `http://localhost:4200/graphql`
- `http://localhost:4200/mcp`
- `http://localhost:4200/mcp/readonly`

Production example:

- `https://involute.example.com/health`
- `https://involute.example.com/auth/*`
- `https://involute.example.com/graphql`
- `https://involute.example.com/mcp`
- `https://involute.example.com/mcp/readonly`

## Authentication model

Supported auth modes:

- browser session cookie via Google OAuth
- trusted bearer token via `Authorization: Bearer <AUTH_TOKEN>`
- trusted viewer assertion via the configured viewer assertion header

Typical browser flow:

1. `GET /auth/google/start`
2. Google redirects back to `/auth/google/callback`
3. server sets the session cookie
4. browser calls `GET /auth/session`
5. browser uses the session cookie for `/graphql`

## HTTP endpoints

### `GET /health`

Returns plain text health status (process liveness; always `200` when the
process is up).

Response:

```text
OK
```

### `GET /ready`

Readiness probe: pings PostgreSQL. Orchestrators should gate traffic on this,
not `/health`.

- `200` with `{"database":"ok","status":"ready"}` when the database answers
- `503` with `{"database":"unavailable","status":"not-ready"}` otherwise

### `GET /llms.txt`, `GET /llms-full.txt`, `GET /docs/<file>.md`

Machine-readable documentation for agents. `/llms.txt` is a generated index;
`/llms-full.txt` concatenates the protocol guide and the whitelisted docs.
`/docs/` serves an allowlist of repository docs (`api.md`, `agent-setup.md`,
`ops.md`, `milestones.md`, `vision.md`) as `text/markdown`; everything else is
`404`. No authentication.

### `GET /auth/session`

Returns the current session state.

Response shape:

```json
{
  "authMode": "session",
  "authenticated": true,
  "googleOAuthConfigured": true,
  "viewer": {
    "email": "user@example.com",
    "globalRole": "ADMIN",
    "id": "uuid",
    "name": "User Name"
  }
}
```

Unauthenticated example:

```json
{
  "authMode": "none",
  "authenticated": false,
  "googleOAuthConfigured": true,
  "viewer": null
}
```

### `GET /auth/google/start`

Starts the Google OAuth login flow.

Behavior:

- returns `302`
- sets the temporary OAuth state cookie
- redirects to Google authorization

### `GET /auth/google/callback`

OAuth callback endpoint.

Behavior:

- validates the OAuth state
- exchanges the authorization code
- upserts the user
- creates the session
- redirects back to `APP_ORIGIN`

Failure behavior:

- redirects to `APP_ORIGIN?authError=<reason>`

### `POST /auth/logout`

Clears the session cookie and deletes the backing session.

Response:

```json
{
  "success": true
}
```

## GraphQL endpoint

### `POST /graphql`

The GraphQL API uses a single endpoint.

Example:

```bash
curl https://involute.example.com/graphql \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_AUTH_TOKEN' \
  --data '{"query":"query { teams { nodes { id key name visibility } } }"}'
```

## GraphQL queries

### `viewer`

Returns the authenticated viewer or `null`.

```graphql
query Viewer {
  viewer {
    id
    name
    email
    globalRole
    isMe
  }
}
```

### `issue(id: String!)`

Looks up an issue by UUID or business identifier.

```graphql
query Issue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    createdAt
    updatedAt
    state { id name }
    team { id key name visibility }
    assignee { id name email }
    labels { nodes { id name } }
    parent { id identifier title }
    children {
      nodes { id identifier title }
    }
    kind
    commitmentStatus
    revision
    outcome
    scope
    constraints
    acceptance
    verification
    repository
    links(type: CONTAINS) {
      nodes {
        type
        from { id identifier }
        to { id identifier }
      }
    }
    comments(first: 50) {
      nodes {
        id
        body
        createdAt
        user { id name email }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
```

### `issues(first: Int!, after: String, filter: IssueFilter)`

Returns the issue connection. The server clamps `first` to a safe limit.

Supported filters:

- team key
- workflow state name
- `assignee.isMe`
- label name via `some` / `every`
- nested `and`
- `kind`
- `commitmentStatus`
- `priority.eq`
- `updatedAt.gte`

The web board and backlog always send `commitmentStatus: COMMITTED`. Candidates are reviewed at `/candidates`, not on the board.

### `workContext(id: String!)`

Returns the Agent context bundle for an issue identifier or UUID: contract fields, contains-ancestors, blockers, and recent audits.

```graphql
query WorkContext($id: String!) {
  workContext(id: $id) {
    work {
      identifier
      title
      kind
      commitmentStatus
      revision
      outcome
      acceptance
    }
    ancestors { identifier title }
    blockedBy { identifier title }
    blocks { identifier title }
    audits { revision actorKind surface reason createdAt }
    runs { publicId status phase summary }
    evidence { kind url summary }
  }
}
```

### `readyWork(filter: ReadyWorkFilter)`

Returns committed, unblocked, unfinished work in urgency order (Urgent → High → Medium → Low → none). Excludes `In Progress` / `In Review` / `Done` / `Canceled`, `BLOCKS` targets, and `blocked` / `needs-clarification` labels.

```graphql
query ReadyWork {
  readyWork(filter: { repository: "fakechris/involute", first: 20 }) {
    nodes {
      identifier
      title
      priority
      state { name }
    }
  }
}
```

CLI:

```bash
involute work context INV-142
involute work ready --repository fakechris/involute --json
```

```graphql
query Issues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter) {
    nodes {
      id
      identifier
      title
      updatedAt
      state { id name }
      assignee { id name }
      labels { nodes { id name } }
      team { id key name }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

Example variables:

```json
{
  "first": 100,
  "filter": {
    "team": {
      "key": {
        "eq": "SON"
      }
    }
  }
}
```

### `teams(filter: TeamFilter)`

Returns visible teams.

```graphql
query Teams {
  teams {
    nodes {
      id
      key
      name
      visibility
      states {
        nodes {
          id
          name
        }
      }
    }
  }
}
```

### `issueLabels(filter: IssueLabelFilter)`

Returns issue labels.

```graphql
query Labels {
  issueLabels {
    nodes {
      id
      name
    }
  }
}
```

### `users`

Returns users visible to the current viewer.

```graphql
query Users {
  users {
    nodes {
      id
      name
      email
      globalRole
      isMe
    }
  }
}
```

## GraphQL mutations

### `issueCreate`

Creates an issue inside a team.

```graphql
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id
      identifier
      title
      state { id name }
      team { id key name }
    }
  }
}
```

Example variables:

```json
{
  "input": {
    "teamId": "team-uuid",
    "title": "Refine workspace shell spacing",
    "description": "Tighten toolbar alignment and chip density.",
    "stateId": "workflow-state-uuid"
  }
}
```

### `issueUpdate`

Updates any combination of:

- `stateId`
- `labelIds`
- `parentId`
- `title`
- `description`
- `assigneeId`

```graphql
mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {
      id
      identifier
      title
      updatedAt
      state { id name }
      assignee { id name }
      labels { nodes { id name } }
    }
  }
}
```

### `issueDelete`

Deletes an issue.

```graphql
mutation IssueDelete($id: String!) {
  issueDelete(id: $id) {
    success
    issueId
  }
}
```

### `workPropose`

Creates candidate work. It does not enter `readyWork`. Retries with the same `idempotencyKey` return the original candidate.

```graphql
mutation Propose($input: WorkProposeInput!) {
  workPropose(input: $input) {
    success
    issue { identifier commitmentStatus }
  }
}
```

### `workCommit`

Promotes a candidate to a committed contract. Requires `expectedRevision`, acceptance criteria, and a human `assigneeId`. Agents receive `FORBIDDEN`.

```graphql
mutation Commit($id: String!, $input: WorkCommitInput!) {
  workCommit(id: $id, input: $input) {
    success
    issue { identifier commitmentStatus revision }
  }
}
```

### `workReject`

Rejects a candidate so it never enters the committed graph. Requires `expectedRevision`. Agents receive `FORBIDDEN`.

```graphql
mutation Reject($id: String!, $input: WorkRejectInput!) {
  workReject(id: $id, input: $input) {
    success
    issue { identifier commitmentStatus revision }
  }
}
```

### `workClaim`

Atomically leases committed work to the current actor. Does not change `assignee`. Unexpired claims are excluded from `readyWork`.

```graphql
mutation Claim($id: String!) {
  workClaim(id: $id) {
    success
    issue { identifier }
    claim { leaseUntil actor { id name } }
  }
}
```

CLI:

```bash
involute work propose --team SON --title "..." --json
involute work commit INV-142 --acceptance "..." --assignee <userId>
involute work reject INV-142 --reason "out of scope"
involute work claim INV-142
```

### `commentCreate`

Creates a comment on an issue, and resolves its `@handle` mentions server-side
in the same transaction (INV-558).

```graphql
mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment {
      id
      body
      createdAt
      user { id name email }
      mentions { id actor { id name handle actorKind } }
    }
  }
}
```

#### Mention resolution

`@handle` in a comment body is resolved to an `actorId` by the server, not by
the consumer. Matching strings in a client would double-fire when a second
consumer comes online, and would treat `@foo` inside a pasted snippet as a real
mention.

- **Handle** — `User.handle`, lowercase, `^[a-z0-9][a-z0-9_-]{0,31}$`, unique
  across all actors. `agent:create` assigns one automatically (slugified from
  the agent name, numeric suffix on collision); `--handle mia` sets it
  explicitly. Re-issuing a credential backfills a handle for agents created
  before INV-558.
- **Only AGENT actors resolve.** A handle owned by a HUMAN produces no mention
  row; mentioning humans is a separate notification surface.
- **Code is never a mention.** `@` inside a fenced block (triple backtick or
  triple tilde, including an unterminated one) or an inline code span is
  ignored.
- **Not every `@` is a mention.** An `@` preceded by a word character, `.`, `-`,
  `/`, or another `@` is skipped, so `admin@involute.local` and `@@unique` do
  not resolve. A run longer than 32 characters resolves to nothing rather than
  being truncated onto a real actor.
- **Unknown handles are silently dropped** — a typo must not fail the write.
- **Repeats collapse** — `(commentId, actorId)` is unique, so `@mia @mia` is one
  mention row.

Mentions are stored by difference, so an edit that withdraws an `@` deletes that
row while leaving untouched mentions (and their `createdAt`) alone.

### `commentDelete`

Deletes a comment.

```graphql
mutation CommentDelete($id: String!) {
  commentDelete(id: $id) {
    success
    commentId
  }
}
```

### `teamUpdateAccess`

Changes team visibility.

```graphql
mutation TeamUpdateAccess($input: TeamUpdateAccessInput!) {
  teamUpdateAccess(input: $input) {
    success
    team {
      id
      key
      name
      visibility
    }
  }
}
```

### `teamMembershipUpsert`

Creates or updates a membership by email.

```graphql
mutation TeamMembershipUpsert($input: TeamMembershipUpsertInput!) {
  teamMembershipUpsert(input: $input) {
    success
    membership {
      id
      role
      user {
        id
        name
        email
        globalRole
      }
    }
  }
}
```

### `teamMembershipRemove`

Removes a team membership.

```graphql
mutation TeamMembershipRemove($input: TeamMembershipRemoveInput!) {
  teamMembershipRemove(input: $input) {
    success
    membershipId
  }
}
```

## Core enums

### `TeamVisibility`

- `PRIVATE`
- `PUBLIC`

### `TeamMembershipRole`

- `VIEWER`
- `EDITOR`
- `OWNER`

### `GlobalRole`

- `ADMIN`
- `USER`

## Pagination

Issue and comment connections return:

```graphql
type PageInfo {
  hasNextPage: Boolean!
  endCursor: String
}
```

Use `endCursor` as the next `after` value.

## Authorization rules

### Read rules

- `ADMIN` can read all teams
- members can read their teams
- signed-in users can read `PUBLIC` teams
- `PRIVATE` teams stay hidden from non-members

### Write rules

- `ADMIN` can manage all teams
- `OWNER` can manage team visibility and memberships
- `EDITOR` and `OWNER` can modify issues and comments
- `VIEWER` is read-only

## Work graph (read-only facade)

Existing issues are work nodes. New fields are queryable; `issueCreate` / `issueUpdate` input shapes are unchanged.

- `kind` defaults to `ISSUE`
- `kind: PROJECT` means a work-graph project contract. It is not the legacy GraphQL `Project` row and is not synchronized with `projectId`; use `CONTAINS` links for new graph hierarchy.
- Ready selectors (`readyWork.filter.projectId`, MCP `project_id`, CLI `--project-id`) accept a Work Graph PROJECT UUID or identifier, as well as a legacy Project UUID. A graph root declaring `repository` selects the same repository-declared work as the repository filter, including work awaiting hierarchy repair. A root without a repository selects its readable, same-team CONTAINS/parentId subtree; an explicit repository filter further narrows it. Resolving a scope does not change stored membership.
- Repository roots prefer COMMITTED over CANDIDATE declarations; multiple preferred readable roots return `PROJECT_SCOPE_AMBIGUOUS`. A selector naming a noncanonical candidate root or a different repository returns `PROJECT_SCOPE_CONFLICT`; an unknown, rejected, wrong-kind or inaccessible root returns `NOT_FOUND`. Legacy Project UUIDs continue to filter `Issue.projectId` and intersect the caller's read scope. A repository without a graph root keeps the existing repository filter.
- Ready retains the shared commitment/owner/state/claim/blocker checks and all-kind default. Use `kind:ISSUE` (IQL) or GraphQL `kind: ISSUE` for executable leaves. `first` limits the same ordered prefix for every selector; `hasNextPage` indicates more results (this change does not introduce a cursor parameter).
- `commitmentStatus` defaults to `COMMITTED` (imported and currently created issues are already commitments)
- `revision` starts at `1` and increments on each domain update
- `links` returns incident `WorkLink` rows (`CONTAINS`, `BLOCKS`, `DERIVED_FROM`, `DISCOVERED_DURING`, `RELATED_TO`, `DUPLICATE_OF`)
- setting `parentId` through `issueCreate` or `issueUpdate` also writes a `CONTAINS` link (parent → child) and records a `WorkAudit` row
- `CONTAINS` requires explicit matching repositories and PROJECT → MILESTONE → ISSUE (or PROJECT → DECISION). Adding a second parent fails; use a revision-checked `issueUpdate` for an intentional move. Kind/repository edits validate incident edges. See [graph migration operations](graph-migration.md) for historical repairs.
- `viewer.actorKind` is `HUMAN`, `AGENT`, or `SERVICE`

## MCP

Streamable HTTP JSON-RPC at `POST /mcp` and `POST /mcp/readonly`. Same bearer token / session / viewer assertion as GraphQL.

```bash
codex mcp add involute --url https://involute.example.com/mcp
codex mcp add involute-readonly --url https://involute.example.com/mcp/readonly
```

Tools: `protocol_get_guide`, `work_search`, `work_get_context`, `work_list_ready`, `work_propose`, `work_commit`, `work_update`, `work_link`, `work_claim`, `run_report`, `evidence_attach`. The readonly endpoint exposes only the read-only four (including `protocol_get_guide`, which returns the full work protocol as markdown). `tools/list` advertises `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`) per tool. `work_search` and `work_list_ready` accept an IQL `filter` argument. Agent behavior is in `skills/involute/SKILL.md`.

Completed runs and attached evidence move work to In Review, never Done. Outbound webhooks use `INVOLUTE_WEBHOOK_URL` and `INVOLUTE_WEBHOOK_SECRET`.

### Webhook delivery contract

See the **payload v2** section above for the full envelope. Summary:

- Delivery is **at-least-once**: a crash between a successful POST and the
  delivery bookkeeping row causes redelivery of the same event.
- Receivers **dedupe on `event_id` / `involute-event-id`** (stable across
  retries); `involute-delivery` and `delivery_id` are unique per attempt.
- Authenticity: `involute-signature` is `sha256=` + HMAC-SHA256 of the raw
  body with the subscription's secret. `involute-event` carries the event
  type (`run.completed`, `work.accepted`, …).
- Each target is retried independently on an exponential backoff (1m → 10h,
  5 attempts); 4xx except 408/429 is terminal; one slow or failing target
  does not block the others. An event is dead-lettered only when **every**
  target has either been delivered or exhausted its retries.
- Review events (`work.accepted`, `work.review_rejected`) include
  `selfReviewed: true` when the reviewer is also the work owner or run actor.

### Comment events (INV-559)

Two event types ride the same outbox as everything else — same HMAC signing,
same claim lease, same backoff, same dead-lettering.

- **`comment.created`** — one per comment. Payload `data`: `comment { id, body,
  createdAt, rootCommentId }`, `speaker { actorId, actorKind, handle, name }`,
  `mentionedActorIds`.
- **`agent.mentioned`** — one per **mentioned actor**, not one per comment, so a
  consumer filters on the addressee and B3's per-target ledger lines up. Payload
  `data`: the same `comment` and `speaker`, plus `target { actorId, handle }`
  and `promptContext`.

`promptContext` is the assembled briefing (Linear's field of the same name): the
work identifier and state, its parent chain, the contract (`description`), the
acceptance criteria, and the most recent runs and evidence — as markdown, capped
at 8,000 characters. The point is that a consumer can answer without first
going and collecting context itself; when it needs more than the briefing it
calls `work_get_context`.

`rootCommentId` is the thread root — the comment's `parentCommentId` when it is
a reply, the comment itself when it is a root.

Both events are enqueued **inside the comment's transaction**: an event never
announces a comment that was then rolled back, and the mentions it references
are already resolved.

When the mention opened a ledger row, `agent.mentioned` also carries
`requestId` — the row to claim. See the request ledger below.

### The agent request ledger (INV-560)

A question put to one actor, with a state, a deadline and an owner. Claiming and
answering happen on the server, so two consumers polling the same actor cannot
both answer.

**States — A2A's task lifecycle, borrowed rather than invented:**

```
submitted ─claim─► working ─┬─ answer ────────► completed
                            ├─ answer(failed) ► failed
                            ├─ answer(input-required) ► input-required ─claim─► working
                            ├─ cancel ────────► canceled
                            └─ deadline ──────► failed
```

`completed`, `failed` and `canceled` are terminal. Because the hyphen in
`input-required` cannot be a Prisma enum identifier, storage spells the states
`SUBMITTED` / `WORKING` / `INPUT_REQUIRED` / … and maps them; every API surface
uses the A2A spelling.

**Who may open one.** A request is opened when a **human** mentions an agent. An
agent mentioning another agent posts an ordinary comment and nothing more —
agent↔agent questions are an echo risk, and the first version keeps a human at
the head of every chain. Opening that up will take an explicit delegation action
carrying a root request id, a budget and a hop limit, not a relaxed check here.

**Tools** (agent tokens need the new `answer` scope; `agent_inbox` needs `read`):

| Tool | Does |
|---|---|
| `agent_inbox(since?, cursor?, first?)` | Requests addressed to you that are still open. Reading reserves nothing. |
| `agent_request_claim(id, claim_token?)` | Take the claim, moving the request to `working`. Returns a `claim_token`. |
| `agent_request_answer(id, claim_token, body, state?, evidence[]?)` | Post the answer and move the request. |

- **The claim belongs to an execution, not to an actor.** Two sessions can carry
  the same actor credential. Every take mints a new **claim generation** and a
  `claim_token` bound to that execution; renewing and answering require the
  token. A stalled session that wakes up after a fresh one re-claimed is
  rejected as *superseded* — being the same actor is not enough. Persist the
  token with your execution; it is not recoverable. If you lose it, wait for
  your lease to lapse and claim again for a new generation.
- **The claim is a 60s lease.** Exactly one execution holds it; a second gets an
  error rather than a duplicate answer. A consumer that dies holding one
  releases it when the lease lapses.
- **The answer comment is authored by the answering actor**, not by whatever
  process is carrying its token. Otherwise every answer looks like it came from
  the same person again.
- **`completed` is reached only once `answeredCommentId` is set**, so a failed
  answer cannot leave a request looking answered.
- **`input-required` is a first-class state, not a failure.** The agent asks
  back, hands the claim over, and the request waits — the deadline keeps running.
- **Deadlines are enforced server-side**, sweeping every 30s — and the
  expiry is not silent. See "When nobody answers" below.
- **`idempotencyKey`** is `mention:<commentId>:<targetActorId>` for
  mention-opened requests, so a replayed comment write lands one request.

### When nobody answers (INV-562)

An expired request used to flip to `failed` and say nothing, which from the
asker's side is indistinguishable from the question vanishing. Expiry now, in
one transaction per request:

1. **Posts a notice in the thread** the question was asked in, authored by the
   `SERVICE` actor `system@involute.local` — not by a person, and not by the
   agent that did not answer. Impersonating either would be a lie in the audit
   trail.
2. **Notifies the person who asked** (`agent.request_expired`), with `advice`
   naming who to ask instead.
3. **Emits `agent.request_expired`** on the outbox for consumers.

The state move is a CAS, so two servers sweeping at once produce one notice.

**What the notice may say.** That no answer arrived before the deadline, and who
to ask next. **Not** why. The server knows the deadline passed and nothing else;
"the agent isn't running" is a guess, and a person who believes it goes and
debugs the wrong thing. A test asserts the copy contains no such claim.

**Who to ask instead** is `User.successorActorId` when the agent declares one,
otherwise the team's human owners, otherwise an explicit statement that there is
nobody — never silence. (The field is declared and used for advice here;
automatic successor takeover is INV-556.)

### Actor lifecycle (INV-586)

- **Every non-human actor has a human owner** (`User.ownerId`). Ownership is a
  responsibility — who is accountable, where escalations end — not a
  permission. `agent:create` requires `--owner <human-email>`; the GraphQL
  `agentCredentialCreate` defaults the owner to the creating human.
- **Actors are deactivated, never deleted.** `WorkAudit.actor` is `Restrict`:
  the database refuses to delete an actor that has written history.
  `actorDeactivate` keeps the id, handle and every audit row, revokes the
  actor's credentials, and ends its ability to act — it stops resolving as a
  principal and stops being mentionable. The directory hides deactivated actors
  unless asked (`agents(includeDeactivated: true)`).
- **Ownership transfer is explicit and recorded.** `actorTransferOwner` is
  human-only and writes an `ActorAudit` row (who, before, after, why).
- **SERVICE actors can be provisioned** for external programs — CI, cron, a
  bridge — via `serviceActorCreate` or `agent:service`, with an owner. They
  authenticate from outside like an agent, and are still SERVICE: no human
  gates, nothing to ask.

### Presence: will it actually reply?

`AgentRequest.presence` answers the question a person actually has, which the
A2A state does not. It is **derived at read time, never stored**, so the A2A
lifecycle stays the only stored state machine:

| presence | meaning |
|---|---|
| `waiting` | nobody has claimed it yet |
| `live` | claimed, active within the last 10s |
| `unresponsive` | claimed, silent for over 10s |
| `stale` | claimed, silent for over 30 minutes — recoverable |
| `settled` | terminal |

`unresponsive` and `stale` are observations about silence, not conclusions about
the consumer: it may be thinking, busy, or on a slow host. `stale` is
recoverable — the holder can renew its claim, or the lease lapses and another
consumer takes over. Thresholds follow Linear's.

### Comment threads (INV-561)

One work item carries several independent conversations. `CommentCreateInput`
takes `parentCommentId`; `Comment` exposes `parentCommentId` and `replies`, and
`issue.comments(rootsOnly: true)` lists the threads rather than every comment
across all of them.

**Threads are one level deep.** Replying to a reply attaches to the same root,
so every comment has exactly one unambiguous `rootCommentId`. Arbitrary nesting
would make "which thread is this request on" a tree walk, and two parallel
questions on one work item could drift into each other.

A parent must be a comment on the same work item; replying across work items is
rejected. Deleting a root deletes its replies.

Each `AgentRequest` is anchored to a `rootCommentId`, not to the work item, and
an answer is posted **into the thread its question was asked in**. So two people
can ask two different questions of the same agent on the same work item, and
neither the requests nor the answers cross.

### Webhook subscriptions (Linear-style, per-endpoint secrets)

Preferred over the legacy shared `INVOLUTE_WEBHOOK_URL`/`INVOLUTE_WEBHOOK_SECRET`
pair. The env pair is used only when **zero enabled subscriptions** exist
(disabled subscriptions do not count — disabling your last subscription
silently reactivates the env fallback, so remove the env values when you cut
over). Each subscription carries its
own signing secret, optional team scope (`team` null = all teams), and event
type filter (empty = all `work.*`/`run.*`/`artifact.*` types). Only team owners
(team-scoped) or global admins (all-teams) can manage them; secrets are
returned once at create/rotate and never listed.

```graphql
mutation {
  webhookCreate(input: {
    team: "INV"
    url: "https://ci.example.com/hooks/involute"
    label: "CI"
    eventTypes: ["run.completed", "work.accepted"]
  }) {
    success
    secret        # shown once — store it now
    subscription { id url teamId eventTypes enabled }
  }
}
```

Rotation is immediate: `webhookRotateSecret(id)` returns a fresh secret and
resets the failure counter. For zero-downtime rotation, create a temporary
second subscription with the new secret, update the receiver, then delete the
old one. Subscriptions that exhaust retries across 10 consecutive flushes are
automatically disabled (`enabled: false`); re-enable with `webhookUpdate`.

```graphql
query { webhooks(teamId: "INV") { id url label teamId eventTypes enabled consecutiveFailures } }
mutation { webhookUpdate(id: "<id>", input: { enabled: true }) { success } }
mutation { webhookDelete(id: "<id>") { success } }
```

### Agent credentials and scopes (Linear-style)

Agent tokens (`inv_agent_…`) work on `/mcp` only. Each credential carries
scopes, enforced per MCP tool; `read` is always granted (as in Linear):

| Scope | Tools |
|---|---|
| `read` | `work_search`, `work_get_context`, `work_list_ready` |
| `propose` | `work_propose` |
| `claim` | `work_claim` |
| `report` | `run_report`, `evidence_attach` |
| `update` | `work_update` (contract fields on committed work stay human-only) |
| `link` | `work_link` |

`work_commit`/`reject`/`accept` have no scope: they are human-only by
`actorKind`. Team owners issue scoped credentials without SSH, from Settings →
Agents or via GraphQL (plaintext token returned once):

```graphql
mutation {
  agentCredentialCreate(input: {
    team: "INV", name: "Codex review",
    scopes: ["read", "propose", "claim", "report"]
  }) {
    success
    token         # shown once
    credential { id name scopes user { email } }
  }
}
```

```graphql
query { agentCredentials(teamId: "INV") { id name scopes revokedAt user { email } } }
mutation { agentCredentialRevoke(id: "<id>") { success } }
```

## IQL — unified work filter

`issues(query:)`, `readyWork(query:)`, the MCP `work_search`/`work_list_ready`
`filter` argument, CLI `--query`, web saved views, and webhook `filterQuery`
all share one small filter language. Terms combine with AND; prefix `-`
negates.

```text
team:SON state:"In Review" state-type:STARTED kind:ISSUE commitment:CANDIDATE
assignee:me assignee:none label:infra priority:>=2 updated:>30d
link:blocked-by:none has:contract -state:done "free text"
```

- `updated` takes durations (`30m`, `7d`, `2w`); `updated:>30d` means "updated
  within the last 30 days".
- `link:<type>:<identifier|none>` matches incoming links of that type, where
  `none` means "no incoming link of this type from unresolved work".
- Parse failures return GraphQL errors with `extensions.code = 'IQL_PARSE'`;
  they are never silently swallowed.

## Notifications

Kernel notifications are projected in the same transaction as the work event
they describe. Human-gate events (`decision.requested`, `run.completed`,
`work.accepted`, `work.review_rejected`, `webhook.disabled`) notify the human
assignee, falling back to human team owners.

**Delivery is per consumer, not per actor kind (INV-562).** The rule used to be
"agent actors never receive notifications"; it is now:

- **Agents** are reached through the outbox — webhook delivery when a consumer
  is subscribed, and `agent_inbox` when one is not. An agent with no live
  consumer is not dropped; its work waits in the inbox to be claimed.
- **Humans** are reached through the in-app inbox. For an expired request the
  recipient is **the person who asked**, not the team owners — they are the one
  left waiting.

`agent.request_expired` notifications carry `advice`: who to ask instead.

```graphql
query {
  notifications(first: 20, unreadOnly: true) {
    nodes { id type payload readAt createdAt work { id identifier } }
    pageInfo { hasNextPage endCursor }
  }
  unreadNotificationCount
}

mutation { notificationMarkRead(id: "...") { success } }
mutation { notificationsMarkAllRead { count success } }
mutation { notificationPreferencesUpdate(emailNotifications: false) { success } }
```

Email digests are off by default. Set `NOTIFICATION_EMAIL_ENABLED=true` plus
`NOTIFICATION_EMAIL_SMTP_HOST`, `NOTIFICATION_EMAIL_SMTP_PORT`,
`NOTIFICATION_EMAIL_SMTP_USER`, `NOTIFICATION_EMAIL_SMTP_PASSWORD`,
`NOTIFICATION_EMAIL_FROM` to batch per-user digests every 30 seconds (2-minute
coalescing window). Read notifications are swept after 90 days, unread after
180.

## Webhooks — payload v2

Envelopes carry, on every delivery:

```json
{
  "type": "work.committed",
  "event": "work.committed",
  "event_id": "stable across retries (== EventOutbox id)",
  "delivery_id": "unique per attempt (<delivery row id>:<attempt>)",
  "occurred_at": "ISO timestamp",
  "work": { "id": "...", "identifier": "SON-42" },
  "data": { "event-specific fields" },
  "updatedFrom": { "changed fields before the update, when applicable" }
}
```

Headers: `involute-event` (type), `involute-event-id` (stable id),
`involute-delivery` (per-attempt id), `involute-attempt` (1-based),
`involute-signature: sha256=<hex HMAC-SHA256 of the raw body>`.

Retry schedule: ~1m, 5m, 30m, 2h, 10h (±20% jitter), 5 attempts. HTTP 4xx
(except 408/429) is terminal for that attempt set. Ten consecutively exhausted
delivery rounds disable the subscription and emit `webhook.disabled`
(internally projected as a notification to the subscription creator or the
instance admins).

Subscriptions accept an optional IQL `filterQuery` (validated at create/update,
evaluated against the work snapshot per delivery). Internal event
`webhook.disabled` also appears in `WORK_EVENT_TYPES`.

GitHub lifecycle transitions emit `work.state_changed` with `data.source = "github"`
and `data.stateType` (the resulting workflow type). The state change and outbox
row commit together; duplicate or ignored events emit no additional transition.
See [GitHub inbound operations](github-inbound.md) for receipt and recovery semantics.

## Error model

The API exposes safe validation and permission errors as GraphQL errors.

Typical categories:

- validation errors
- not found errors
- forbidden errors

Mutation payloads still return `success`, but authorization failures are not silently downgraded into a fake success response.


## Trusted evidence (shadow)

`runReport` accepts optional `commitSha` and `pullRequestNumber`; MCP uses `commit_sha` and `pr_number`, CLI uses `--commit-sha` and `--pr-number`. Set both before the run completes. The server freezes the semantic contract at run creation and exposes `contractRevision` / `acceptanceDigest` on the run. `WorkEvidenceRecord.verifications` and MCP context expose append-only server observations, never a client-writable verified flag.

GitHub merge now stops at Review and appends its evidence without overwriting an agent declaration. CLEAR is a shadow grade with SKIPPED outcome, not an acceptance decision. See [evidence verification](evidence-verification.md) for coverage and setup.

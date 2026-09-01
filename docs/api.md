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

Returns plain text health status.

Response:

```text
OK
```

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

Creates a comment on an issue.

```graphql
mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment {
      id
      body
      createdAt
      user { id name email }
    }
  }
}
```

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
- `commitmentStatus` defaults to `COMMITTED` (imported and currently created issues are already commitments)
- `revision` starts at `1` and increments on each domain update
- `links` returns incident `WorkLink` rows (`CONTAINS`, `BLOCKS`, `DERIVED_FROM`, `DISCOVERED_DURING`, `RELATED_TO`, `DUPLICATE_OF`)
- setting `parentId` through `issueUpdate` also writes a `CONTAINS` link (parent → child) and records a `WorkAudit` row
- `viewer.actorKind` is `HUMAN`, `AGENT`, or `SERVICE`

## MCP

Streamable HTTP JSON-RPC at `POST /mcp` and `POST /mcp/readonly`. Same bearer token / session / viewer assertion as GraphQL.

```bash
codex mcp add involute --url https://involute.example.com/mcp
codex mcp add involute-readonly --url https://involute.example.com/mcp/readonly
```

Tools: `work_search`, `work_get_context`, `work_list_ready`, `work_propose`, `work_commit`, `work_update`, `work_link`, `work_claim`, `run_report`, `evidence_attach`. The readonly endpoint exposes only the first three. Agent behavior is in `skills/involute/SKILL.md`.

Completed runs and attached evidence move work to In Review, never Done. Outbound webhooks use `INVOLUTE_WEBHOOK_URL` and `INVOLUTE_WEBHOOK_SECRET`.

## Error model

The API exposes safe validation and permission errors as GraphQL errors.

Typical categories:

- validation errors
- not found errors
- forbidden errors

Mutation payloads still return `success`, but authorization failures are not silently downgraded into a fake success response.

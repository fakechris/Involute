# API Reference

## Overview

Involute exposes two HTTP surfaces:

- REST-like auth and health endpoints on the same server origin
- a GraphQL API at `/graphql`

Default local endpoints:

- `http://localhost:4200/health`
- `http://localhost:4200/auth/*`
- `http://localhost:4200/graphql`

Production example:

- `https://involute.example.com/health`
- `https://involute.example.com/auth/*`
- `https://involute.example.com/graphql`

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

## Error model

The API exposes safe validation and permission errors as GraphQL errors.

Typical categories:

- validation errors
- not found errors
- forbidden errors

Mutation payloads still return `success`, but authorization failures are not silently downgraded into a fake success response.

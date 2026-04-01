---
name: backend-worker
description: Implements backend features — database schema, GraphQL resolvers, API endpoints, data pipelines
---

# Backend Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Features involving:
- Database schema design and Prisma migrations
- GraphQL resolvers, type definitions, and filter logic
- API authentication and middleware
- Data import/export pipelines
- Server-side business logic

## Required Skills

None.

## Work Procedure

### 1. Understand the Feature
- Read the feature description, preconditions, expectedBehavior, and verificationSteps from features.json
- Read `docs/legacy/` specs as needed (especially `04_GraphQL_Schema_子集_v0.md` for API compat)
- Read `.factory/library/architecture.md` and `.factory/library/environment.md`
- Check existing code to understand current state

### 2. Write Tests First (TDD)
- Create test files BEFORE implementation
- For GraphQL resolvers: write integration tests that send actual GraphQL queries and verify responses
- For data logic: write unit tests for business rules
- Use vitest as the test framework
- Tests must be runnable with `pnpm test --run` from the package directory
- Run tests to confirm they FAIL (red phase)

### 3. Implement
- Prisma schema changes: update `schema.prisma`, run `npx prisma db push` or generate migration
- GraphQL types: follow Linear-compatible naming exactly (field names, connection types, filter shapes)
- Resolvers: implement query/mutation logic using Prisma client
- Follow existing patterns in the codebase
- Run `npx prisma generate` after schema changes

### 4. Verify
- Run tests to confirm they PASS (green phase): `cd packages/server && pnpm test --run`
- Run typecheck: `cd packages/server && pnpm typecheck`
- Run lint: `cd packages/server && pnpm lint`
- For API features: manually test with curl against running server:
  ```
  cd packages/server && PORT=4200 npx tsx src/index.ts &
  curl -X POST http://localhost:4200/graphql \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer involute-dev-token-001" \
    -d '{"query":"{ teams { nodes { id key name } } }"}'
  ```
- Kill test server after verification

### 5. Commit
- Stage and commit all changes with a descriptive message

## Example Handoff

```json
{
  "salientSummary": "Implemented issues list query with full filter engine (and, team.key.eq, state.name.eq, assignee.isMe.eq, labels.some/every). Wrote 12 integration tests covering all filter paths including edge cases. Verified via curl with compound filter matching SpecOrch's Q2 query.",
  "whatWasImplemented": "GraphQL issues(first, filter) query with IssueFilter supporting and combinator, team.key.eq, state.name.eq, assignee.isMe.eq, labels.some.name.in, labels.every.name.nin. Prisma query builder translates GraphQL filters to SQL. Connection type returns { nodes: [...] }.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      { "command": "cd packages/server && pnpm test --run", "exitCode": 0, "observation": "12 tests passing, all filter paths covered" },
      { "command": "cd packages/server && pnpm typecheck", "exitCode": 0, "observation": "No type errors" },
      { "command": "curl -X POST http://localhost:4200/graphql -H 'Authorization: Bearer involute-dev-token-001' -H 'Content-Type: application/json' -d '{\"query\":\"{ issues(first:5, filter:{and:[{team:{key:{eq:\\\"INV\\\"}}},{state:{name:{eq:\\\"Ready\\\"}}}]}) { nodes { id identifier title state { name } } } }\"}'", "exitCode": 0, "observation": "Returns filtered issues correctly, only Ready state issues from INV team" }
    ],
    "interactiveChecks": []
  },
  "tests": {
    "added": [
      {
        "file": "packages/server/src/__tests__/issues-filter.test.ts",
        "cases": [
          { "name": "filters by team.key.eq", "verifies": "Only issues from matching team returned" },
          { "name": "filters by state.name.eq", "verifies": "Only issues in matching state returned" },
          { "name": "filters by assignee.isMe.eq", "verifies": "Only issues assigned to token user returned" },
          { "name": "filters by labels.some.name.in", "verifies": "Issues with at least one matching label returned" },
          { "name": "filters by labels.every.name.nin", "verifies": "Issues with excluded labels filtered out" },
          { "name": "compound and filter", "verifies": "All conditions applied conjunctively" }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- Database connection issues that init.sh doesn't resolve
- Prisma migration conflicts that require manual resolution
- Schema design ambiguity (e.g., unclear filter semantics)
- Feature depends on another feature's work that doesn't exist yet
- Existing tests fail before changes (pre-existing issue)

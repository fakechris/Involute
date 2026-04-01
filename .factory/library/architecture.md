# Architecture

**What belongs here:** Architectural decisions, patterns, module structure.

---

## Monorepo Structure

```
involute/
├── packages/
│   ├── server/          # GraphQL API (Yoga + Prisma + PostgreSQL)
│   ├── web/             # React Vite app (kanban board)
│   ├── cli/             # Commander.js CLI tool
│   └── shared/          # Shared TypeScript types
├── .factory/            # Mission infrastructure
├── docs/legacy/         # Original design specifications
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
└── .env
```

## Backend Architecture

- **GraphQL Yoga** as the GraphQL server (lightweight, modern)
- **Prisma** as the ORM connecting to PostgreSQL
- **Facade pattern**: Internal domain model (Prisma) decoupled from external Linear-compatible GraphQL schema
- **Token auth**: Accepts either `Authorization: Bearer <token>` or a raw token value in the `Authorization` header, validated against `AUTH_TOKEN` for Linear-compatibility
- **Viewer resolution**: Authorized requests populate `context.viewer` by loading the seeded user identified by `DEFAULT_ADMIN_EMAIL`; `assignee.isMe` behavior depends on that fixed viewer mapping
- Schema matches Linear's GraphQL API subset exactly (see docs/legacy/04)

## Data Model

Core entities (maps to Prisma schema):
- Team (id, key, name)
- WorkflowState (id, name, teamId)
- IssueLabel (id, name)
- User (id, name, email)
- Issue (id, identifier, title, description, stateId, assigneeId, parentId, teamId)
- Comment (id, body, createdAt, issueId, userId)
- LegacyLinearMapping (oldId, newId, entityType, migratedAt)

Issue.identifier format: `{TEAM_KEY}-{N}` (auto-incrementing per team)

## Frontend Architecture

- **React** (Vite) — no SSR/Next.js, simple SPA
- **Apollo Client** for GraphQL queries/mutations
- **dnd-kit** for drag-and-drop kanban
- Component structure per docs/legacy/06: BoardPage, Column, IssueCard, IssueDetailDrawer, LabelPicker, AssigneePicker, CommentList, CommentComposer

## CLI Architecture

- **Commander.js** for CLI framework
- **graphql-request** for talking to the server
- Config stored in `~/.involute/config.json` (server-url, token)

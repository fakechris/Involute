---
name: frontend-worker
description: Implements frontend features — React components, Apollo Client queries, UI interactions, styling
---

# Frontend Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Features involving:
- React components (kanban board, issue cards, detail drawer)
- Apollo Client GraphQL integration
- Drag-and-drop interactions (dnd-kit)
- UI state management
- Styling and responsive layout

## Required Skills

- `agent-browser` — MUST invoke for manual verification of UI features. Use to navigate the web app, test interactions (drag-and-drop, clicks, form submissions), and verify visual correctness.

## Work Procedure

### 1. Understand the Feature
- Read feature description, preconditions, expectedBehavior, verificationSteps
- Read `docs/legacy/06_最小看板与编辑_UI_方案.md` for UI spec
- Read `.factory/library/architecture.md` for component structure
- Check existing components and Apollo queries

### 2. Write Tests First (TDD)
- Create component test files BEFORE implementation
- Test rendering, user interactions, and GraphQL query/mutation behavior
- Use vitest + @testing-library/react where appropriate
- Run tests to confirm they FAIL (red phase)

### 3. Implement
- React components following existing patterns
- Apollo Client queries/mutations matching the GraphQL schema exactly
- Use dnd-kit for drag-and-drop functionality
- Responsive CSS (simple, functional — not pixel-perfect)
- Follow component structure from UI spec: BoardPage, Column, IssueCard, IssueDetailDrawer, LabelPicker, AssigneePicker, CommentList, CommentComposer

### 4. Verify Automated
- Run tests: `cd packages/web && pnpm test --run`
- Run typecheck: `cd packages/web && pnpm typecheck`
- Run lint: `cd packages/web && pnpm lint`

### 5. Verify Interactive (REQUIRED)
- Start the API server: `cd /Users/chris/workspace/Involute/packages/server && PORT=4200 npx tsx src/index.ts &`
- Start the web dev server: `cd /Users/chris/workspace/Involute/packages/web && PORT=4201 npx vite --port 4201 &`
- Wait for both to be healthy
- Invoke `agent-browser` skill to test each UI flow:
  - Navigate to `http://localhost:4201`
  - Verify the feature works as expected (visual check, interaction test)
  - Each flow tested = one `interactiveChecks` entry
- Kill servers after verification: `lsof -ti :4200 | xargs kill; lsof -ti :4201 | xargs kill`

### 6. Commit
- Stage and commit all changes

## Example Handoff

```json
{
  "salientSummary": "Built kanban board with 6 columns, issue cards showing identifier/title/labels/assignee, and drag-and-drop state changes via dnd-kit. Verified via agent-browser: dragged card from Backlog to In Progress, confirmed state persisted after refresh.",
  "whatWasImplemented": "BoardPage component fetching issues grouped by workflow state. Column component rendering IssueCards. DndContext with drag-and-drop between columns triggering issueUpdate mutation. Cards display identifier, title, label chips, and assignee avatar.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      { "command": "cd packages/web && pnpm test --run", "exitCode": 0, "observation": "8 tests passing" },
      { "command": "cd packages/web && pnpm typecheck", "exitCode": 0, "observation": "No type errors" }
    ],
    "interactiveChecks": [
      { "action": "Navigated to http://localhost:4201, verified 6 columns render (Backlog, Ready, In Progress, In Review, Done, Canceled)", "observed": "All 6 columns visible with correct headers" },
      { "action": "Verified issue cards show identifier 'INV-1', title, labels 'task', assignee 'Admin'", "observed": "Card displays all fields correctly" },
      { "action": "Dragged INV-1 from Backlog to In Progress column", "observed": "Card moved to In Progress, network showed issueUpdate mutation with stateId" },
      { "action": "Refreshed page, checked INV-1 position", "observed": "INV-1 remains in In Progress column — state persisted" }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "packages/web/src/__tests__/BoardPage.test.tsx",
        "cases": [
          { "name": "renders 6 columns", "verifies": "All workflow state columns rendered" },
          { "name": "renders issue cards in correct columns", "verifies": "Cards grouped by state" },
          { "name": "drag triggers state update mutation", "verifies": "issueUpdate called with new stateId" }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- API server not available or returning unexpected errors
- GraphQL schema mismatch (query/mutation shape differs from what frontend expects)
- Missing API endpoints that the feature depends on
- dnd-kit or Apollo Client version incompatibility
- agent-browser cannot interact with a critical UI element

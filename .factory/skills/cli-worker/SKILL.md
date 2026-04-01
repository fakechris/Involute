---
name: cli-worker
description: Implements CLI features — Commander.js commands, GraphQL client, config management, import/export
---

# CLI Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Features involving:
- Commander.js CLI commands
- GraphQL client for server communication
- Config file management (~/.involute/config.json)
- Import/export data pipelines
- Terminal output formatting (table/JSON modes)

## Required Skills

None.

## Work Procedure

### 1. Understand the Feature
- Read feature description, preconditions, expectedBehavior, verificationSteps
- Read `docs/legacy/05_Linear_全量导出_迁移与导入方案.md` for import/export spec
- Check existing CLI commands and patterns

### 2. Write Tests First (TDD)
- Create test files BEFORE implementation
- Test command parsing, output formatting, error handling
- Mock GraphQL responses for unit tests
- Use vitest
- Run tests to confirm they FAIL (red phase)

### 3. Implement
- Commander.js command definitions
- graphql-request client for server communication
- Config management: read/write `~/.involute/config.json`
- Table output via a simple formatter (no heavy dependency)
- JSON output mode via `--json` flag
- Meaningful error messages for user-facing errors
- Non-zero exit codes for errors

### 4. Verify
- Run tests: `cd packages/cli && pnpm test --run`
- Run typecheck: `cd packages/cli && pnpm typecheck`
- Run lint: `cd packages/cli && pnpm lint`
- Manual verification with running server:
  ```
  # Start API server
  cd /Users/chris/workspace/Involute/packages/server && PORT=4200 npx tsx src/index.ts &
  
  # Test CLI commands
  cd /Users/chris/workspace/Involute
  node packages/cli/dist/index.js config set server-url http://localhost:4200
  node packages/cli/dist/index.js config set token $(grep AUTH_TOKEN /Users/chris/workspace/Involute/.env | cut -d= -f2)
  node packages/cli/dist/index.js teams list
  node packages/cli/dist/index.js issues list
  node packages/cli/dist/index.js issues create --title "Test" --team INV
  node packages/cli/dist/index.js --help
  
  # Kill server
  lsof -ti :4200 | xargs kill
  ```
- Each manual test = one `interactiveChecks` entry with command and output

### 5. Commit
- Stage and commit all changes

## Example Handoff

```json
{
  "salientSummary": "Implemented full issue management CLI: list/show/create/update + comments list/add. All commands support --json flag. Tested against running server: created issue, updated state, added comment, verified all reflected correctly.",
  "whatWasImplemented": "Commander.js CLI with commands: issues list/show/create/update, comments list/add, teams list, states list, labels list, config set/get. Table and JSON output modes. graphql-request client with token auth. Error handling for missing config, invalid token, not found.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      { "command": "cd packages/cli && pnpm test --run", "exitCode": 0, "observation": "15 tests passing" },
      { "command": "cd packages/cli && pnpm typecheck", "exitCode": 0, "observation": "No type errors" }
    ],
    "interactiveChecks": [
      { "action": "node packages/cli/dist/index.js teams list", "observed": "Table showing INV team with id, key, name" },
      { "action": "node packages/cli/dist/index.js issues create --title 'CLI Test' --team INV", "observed": "Created issue INV-5, output shows id and identifier" },
      { "action": "node packages/cli/dist/index.js issues show INV-5", "observed": "Shows full detail: title, state Backlog, no labels, no assignee" },
      { "action": "node packages/cli/dist/index.js issues list --json | jq .", "observed": "Valid JSON array of issues" },
      { "action": "node packages/cli/dist/index.js issues show NONEXISTENT", "observed": "Error: Issue not found: NONEXISTENT (exit code 1)" }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "packages/cli/src/__tests__/commands.test.ts",
        "cases": [
          { "name": "issues list formats table", "verifies": "Table output with identifier, title, state columns" },
          { "name": "issues create sends correct mutation", "verifies": "GraphQL mutation with teamId, title, description" },
          { "name": "issues show displays all fields", "verifies": "Output includes identifier, title, description, state, labels, comments" },
          { "name": "missing config shows helpful error", "verifies": "Suggests running config set" }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- API server schema doesn't match expected queries/mutations
- Config directory permissions issues
- Feature requires server-side changes not yet implemented
- Linear API access needed but no token available

# User Testing

**What belongs here:** Testing surface, tools, setup, concurrency limits.

---

## Validation Surface

### 1. GraphQL API (port 4200)
- **Tool:** curl
- **Setup:** Start API server (`cd packages/server && PORT=4200 node dist/index.js`)
- **Auth:** Include `Authorization: Bearer $AUTH_TOKEN` from the repo `.env` file (`.factory/init.sh` currently writes `changeme-set-your-token` by default)
- **Endpoint:** `POST http://localhost:4200/graphql` with `Content-Type: application/json`

### 2. Web UI (port 4201)
- **Tool:** agent-browser
- **Setup:** Start API server first, then web dev server (`cd packages/web && PORT=4201 npx vite --port 4201`)
- **Entry point:** `http://localhost:4201`
- **Prerequisite:** API server must be running and healthy
- **Preferred team for board validation:** Use the seeded `INV` team for canonical six-column workflow checks. Imported teams like `SON` are valid for import-consistency checks, but may not expose the exact six-state workflow needed for full board/dnd coverage.
- **Validation data note:** Before manual board/dnd checks, confirm the selected team actually has visible issues. If the board is empty, switch to a team with imported issues (for example `SON`) or create a fresh issue through the UI first, then perform drag/detail/comments validation on that card.

### 3. CLI
- **Tool:** terminal commands (Execute tool)
- **Setup:** Build CLI package, then run commands directly
- **Config:** Must set server-url and token before running data commands
- **Binary:** `node packages/cli/dist/index.js` or via pnpm script

## Validation Concurrency

- **Machine:** 32 GB RAM, 10 CPU cores
- **Baseline usage:** ~20 GB used, ~12 GB reclaimable
- **Headroom (70%):** ~8.4 GB

### Per-surface limits:
- **curl (API):** 5 concurrent validators (minimal resource usage)
- **agent-browser (Web):** 4 concurrent validators (~500 MB each: 300 MB Chromium + 200 MB shared dev server)
- **CLI:** 5 concurrent validators (minimal resource usage)

## Test Data Strategy

- Seed data provides baseline (1 team, 6 states, 10+ labels, 1 user)
- Tests should create their own issues/comments for isolation
- Import tests need fixture data (mock Linear export files) or actual Linear API access
- Current scope note: `VAL-FOUND-003` now requires an authenticated `__typename` probe, and `VAL-FOUND-010` has moved to the api-compat milestone where mutation-enabled flows can verify `User.isMe` on the real surface.

## Flow Validator Guidance: curl

- Surface boundary: use only the live API at `http://localhost:4200/graphql` and `http://localhost:4200/health`.
- Isolation rule: foundation API assertions are read-only; do not mutate database state unless the assigned assertion explicitly requires it.
- Auth source: read `AUTH_TOKEN` from the repo `.env` file; send it as `Authorization: Bearer <token>`.
- Evidence: save raw request/response bodies and status codes for every assertion in the assigned evidence directory.
- Concurrency: curl validators may run in parallel up to 5 at a time because they share only read-only seeded data.

## Flow Validator Guidance: curl (api-compat)

- **Surface boundary:** Use only the live API at `http://localhost:4200/graphql`.
- **Auth:** `Authorization: Bearer changeme-set-your-token` (the AUTH_TOKEN from .env).
- **Isolation rule for mutation tests:** Each subagent must create its own test issues/comments with UNIQUE titles (prefix with the group-id, e.g., "grp1-test-issue"). Query by returned ID, never by count. This ensures parallel validators don't interfere.
- **Seed data available:**
  - Teams: "INV" (Involute) and "APP" (Application Team)
  - 6 workflow states per team: Backlog, Ready, In Progress, In Review, Done, Canceled
  - 10+ labels: task, epic, spec, needs-clarification, blocked, agent-ready, Feature, Bug, Improvement, spec-orch
  - 1 admin user (admin@involute.local) — this is the authenticated user (isMe=true)
- **Creating test data:** Use `issueCreate` mutation to create issues needed for query tests. Use `issueUpdate` to set states/labels/assignees. Use `commentCreate` to add comments.
- **Team ID resolution:** Query `teams(filter: { key: { eq: "INV" } })` to get the team ID. Then query `teams { nodes { states { nodes { id name } } } }` to get state IDs.
- **Label ID resolution:** Query `issueLabels(filter: { name: { eq: "task" } })` to get label IDs.
- **User ID resolution:** The admin user is the only user. Query teams or create an issue and check its fields.
- **Evidence:** Save raw JSON request/response for every assertion in the assigned evidence directory.
- **Concurrency:** Up to 5 concurrent curl validators. Each creates its own test data for isolation.

## Flow Validator Guidance: CLI

- Surface boundary: use only the built CLI binary at `node packages/cli/dist/index.js` against the live local API/server data.
- Isolation rule: each validator must use its own export directory under `.factory/validation/import/user-testing/tmp/<group-id>` and its own CLI config home via `HOME=<isolated-home>` so config writes do not collide.
- Shared database is allowed, but create/import unique fixture exports per validator and verify by identifiers from that validator's export only.
- Real Linear export note: this environment provides `LINEAR_TOKEN` (not `LINEAR_API_TOKEN`). For real export validation, pass it explicitly to the CLI as `--token "$LINEAR_TOKEN"`.
- Evidence: save CLI stdout/stderr, exit codes, and any generated export directory listings/files needed to prove the assertion.
- Concurrency: limit to 2 concurrent CLI import/export validators because import and verify can be database-heavy and mutate shared mapping tables.

## Linear Export Timing Notes

- Exporting from Linear for a workspace with ~400 issues and ~90 comments takes 2-3 minutes due to API rate limits on comment fetching.
- Use at least 300s timeout for the export command when running against a real Linear workspace.
- The CLI mid-export progress messages may show raw Linear API counts (e.g., 10 labels, 2 users) before team-scoped filtering. The final summary and written files reflect the filtered counts (e.g., 5 labels, 1 user for team SON).

## Flow Validator Guidance: curl (import)

- Surface boundary: use only the live API at `http://localhost:4200/graphql` for post-import verification.
- Isolation rule: query only identifiers and entities from the assigned validator's export fixture; do not mutate unrelated imported records.
- Auth: send `Authorization: Bearer changeme-set-your-token` from the repo `.env`.
- Evidence: save raw GraphQL request/response JSON for each checked assertion.
- Concurrency: up to 3 concurrent validators if they verify disjoint imported fixtures.

## Flow Validator Guidance: Web UI

- Surface boundary: use only the live browser app at `http://localhost:4201` and the paired local API at `http://localhost:4200/graphql` for cross-checks.
- Isolation rule: each validator must use its assigned `agent-browser --session` name and avoid shared-service teardown or disruptive environment changes while other validators are running.
- Data isolation: prefer creating uniquely prefixed issues/comments for the assigned validator (`<group>-<timestamp>`) and re-query those exact records via GraphQL instead of relying on global counts.
- **Team selection (CRITICAL)**: Use the **INV** team (key="INV") for six-column board validation. INV has 6 workflow states: Backlog, Ready, In Progress, In Review, Done, Canceled. Do NOT use APP team which has only 2 states. Query `teams(filter: { key: { eq: "INV" } })` to resolve the INV team ID.
- **Data seeding before board tests**: Before testing board/dnd/drawer assertions, create 3-5 test issues via `issueCreate` mutation against the INV team in various states. Use uniquely-prefixed titles like `ut2-<group>-test-1`. This ensures the board is not empty and cards are available for drag/click/edit testing.
- **Stable DnD automation targets**: Use the dedicated drag handle selectors `data-testid="issue-drag-handle-<IDENTIFIER>"` on cards and target destination columns via `data-droppable-state-id="<STATE_ID>"` / state-based board column selectors. Do not rely on generic accessibility refs alone for drag validation.
- **Labels are seeded**: The database contains 10+ labels (task, epic, spec, Feature, Bug, etc.). If `issueLabels` query returns empty, re-seed: `cd ./packages/server && npx prisma db seed`.
- **Imported team for cross-checks**: The imported team is "SON" when the imported dataset is present. Use the team selector in the web UI header to switch to SON for VAL-CROSS-005 import-to-web validation; if SON is absent after alignment setup, do not treat it as a blocker for rerunning unrelated assertions.
- **Multi-team selector**: The team selector is in the shared header. INV and APP must be present after alignment setup; SON is only required when rerunning import-to-web assertions.
- **API error state (VAL-WEB-018)**: Do not stop shared services. Use the runtime override path by navigating with `?involuteApiUrl=http://127.0.0.1:9/graphql` to force a browser-session-only unreachable API and validate the friendly error UI non-destructively.
- Evidence: capture annotated screenshots for every UI assertion and save supporting GraphQL responses when browser network tooling does not expose enough detail.
- Known friction: agent-browser may lose refs after drawer transitions/reloads, so re-snapshot frequently; browser network output may list URLs without GraphQL payloads, requiring curl cross-verification.
- Concurrency: cap Web UI validators at 3 concurrent sessions on this machine because available free memory was ~2.35 GiB during this run and each browser session adds meaningful overhead.

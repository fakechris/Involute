# Executive summary
- The repository is directionally sound for its M0 milestone; the data model, import pipeline, and CLI/web layers cleanly orchestrate a workable single-team import and visual acceptance workflow.
- Top 3 risks to M0 success: 
  1. Identifier uniqueness collisions that crash repeated imports if mixed with local issue creation.
  2. Hardcoded workflow state names in the UI causing non-standard imported Linear issues to be rendered invisible on the board.
  3. Non-transactional execution in the import pipeline, leading to silent data corruption or orphaned tracking mappings upon partial failure.
- Top 3 strengths:
  1. The robust idempotency framework using `LegacyLinearMapping` to ensure safe, repeatable pipeline reruns.
  2. The cohesive `docker compose` orchestrator providing a completely reproducible stack without complex manual config.
  3. High-quality module boundaries (`server`, `web`, `cli`, `shared`) eliminating tight coupling and encouraging independent evolution.

# Architectural judgment
Mostly sound. 
The monorepo structure cleanly separates responsibilities. `packages/cli` interacts exclusively via GraphQL without leaking database internals. `packages/web` acts as a pure consumer. The `packages/server` GraphQL API provides appropriate queries and mutations for the product intent. The choice to decouple Linear JSON consumption into an atomic, standalone script (`import-pipeline.ts`) ensures the core `issue-service.ts` isn't polluted with migration logic. However, the BoardPage UI state is becoming fragile due to an overly ambitious optimistic update implementation, and a few data modeling shortcuts threaten M0 reliability.

# Findings by severity

## [P0] Identifier uniqueness collisions in mixed import scenarios
- Category: data-model
- Why it matters: In a migration rehearsal, users will import a team, manually create a few test issues, and then attempt to re-import missing data. This will crash the pipeline.
- Evidence: 
  - `prisma/schema.prisma` enforces `@unique` on `identifier`. 
  - `packages/server/src/import-pipeline.ts` uses `prisma.issue.create` providing the raw imported identifier (e.g., "SON-42"). There is no pre-flight collision check outside of the `legacyLinearMapping` lookup. If a user manually created "SON-42", the import fails ungracefully.
- Risk: Immediate pipeline crash, violating the M0 goal of reliable, repeatable execution.
- Recommendation: Transition issue creation in `import-pipeline.ts` to an `upsert` or gracefully check and re-allocate identifier collision boundaries before creating.
- Confidence: high

## [P0] Hardcoded workflow states cause imported issues to "disappear"
- Category: ui-state
- Why it matters: The M0 goal is to "visually accept the data". If a team uses customized Linear workflow states (e.g., "Todo" instead of "Ready"), these issues are successfully imported but hidden from the Kanban board.
- Evidence: 
  - `packages/web/src/board/constants.ts` defines a strict `BOARD_COLUMN_ORDER = ['Backlog', 'Ready', 'In Progress', 'In Review', 'Done', 'Canceled']`.
  - `packages/web/src/routes/BoardPage.tsx` blindly uses this array to group and render issues. Unmatched states are simply dropped from view.
- Risk: Produces immediately misleading acceptance results. The operator will assume data loss occurred during import.
- Recommendation: Derive board columns dynamically by querying the `states` belonging to the specific `Team`, using `BOARD_COLUMN_ORDER` merely as an optional sort heuristic.
- Confidence: high

## [P1] Non-transactional import entity/mapping insertion
- Category: import-pipeline
- Why it matters: Network or database connectivity issues during a 10,000-issue import can leave the DB in a corrupted halfway state.
- Evidence: 
  - `packages/server/src/import-pipeline.ts` loops through issues and sequentially performs `await prisma.issue.create(...)` followed by `await createMapping(...)`. 
  - These are not wrapped in a `prisma.$transaction`. 
- Risk: If the script halts immediately after the issue is created but before the mapping is saved, a subsequent run will not find the mapping in `existingMappings` and will attempt to create the issue again, triggering the unique identifier collision constraint and bricking the migration.
- Recommendation: Wrap the entity creation and the mapping record creation in a single Prisma transaction for atomicity.
- Confidence: high

## [P1] Cancelled DnD interactions commit to wrong state
- Category: ui-state
- Why it matters: General UI instability actively degrades user trust during the "visual acceptance" phase.
- Evidence: 
  - `packages/web/src/routes/BoardPage.tsx` `handleDragEnd` uses `const targetStateId = getDropTargetStateId(event) ?? dragPreviewStateId;`.
  - If a drag is cancelled via ESC or dropped out of bounds, `getDropTargetStateId` returns null, falling back to whatever column was last previewed (`dragPreviewStateId`), actively moving the card instead of returning it to its origin.
- Risk: M0 testability risk. Users idly dragging cards will corrupt issue states without explicit intent.
- Recommendation: Directly validate `targetStateId`. If invalid, explicitly restore the issue to its `originState` cache and skip the API mutation.
- Confidence: high

## [P1] Silent escalation of privileges via Admin Fallback
- Category: auth
- Why it matters: Security degradation shouldn't silently yield superuser permissions.
- Evidence: 
  - `packages/server/src/auth.ts` `getViewerLookup` returns `{ email: DEFAULT_ADMIN_EMAIL }` if the `viewer-assertion` header is unset or fails verification, granting unrestricted access so long as the base `AUTH_TOKEN` is present.
- Risk: Operational hazard during M0 deployment if `VIEWER_ASSERTION_SECRET` is improperly configured.
- Recommendation: Throw an explicit `401 Unauthorized` GraphQL error if the context builder fails to derive an identity, unless explicitly bypassed via a `DEV_MODE` flag.
- Confidence: high

## [P2] In-memory map iteration risks OOM on large exports
- Category: import-pipeline
- Why it matters: Real-world single teams can possess over 100,000 comments.
- Evidence: 
  - `packages/server/src/import-pipeline.ts` uses `prisma.legacyLinearMapping.findMany()` unconditionally pulling all mappings into memory for its `existingMappings` map.
- Risk: V8 heap memory exhaustion leading to pipeline death on large datasets. Doesn't block small POCs but will block multi-year Linear exports.
- Recommendation: Do a batch chunked check inside the mapping creation logic rather than pre-loading the entire mapping table into RAM.
- Confidence: medium

## [P2] N+1 calculation for nextIssueNumber
- Category: data-model
- Why it matters: Heavy unoptimized computational loop blocking the pipeline's completion phase.
- Evidence: 
  - `packages/server/src/import-pipeline.ts` runs a `reduce` across all arrays of fetched issues in JS memory inside `updateTeamNextIssueNumbers` to parse suffixes via RegExp.
- Risk: Slower imports on large datasets and redundant load.
- Recommendation: Use a raw Postgres query or Prisma aggregation to compute `MAX()` directly based on the identifier split.
- Confidence: medium

## [P3] Redundant 'orderWorkflowStates' implementations
- Category: maintainability
- Why it matters: Code duplication across critical service paths.
- Evidence: 
  - `schema.ts` and `issue-service.ts` both maintain identical hardcoded implementations of `orderWorkflowStates` and `workflowStateOrder`.
- Risk: Low, merely an annoyance.
- Recommendation: Centralize to a single map/function inside `packages/shared` or `packages/server/src/constants.ts`.
- Confidence: high

## [Deferred / not a current defect] Missing Issue Position/Ordering
- Category: data-model
- Why it matters: Linear supports dragging cards to rank them within a column. Involute does not.
- Evidence: The DB `Issue` model lacks an `order` or `position` float schema. The API `UpdateIssueInput` only accepts `stateId`.
- Risk: None for M0. Intentional product gap meant for later refinement.
- Recommendation: Defer until M2 or UI polish milestone.
- Confidence: high

# Cross-cutting analysis

## Import correctness and replay semantics
The decision to utilize an isolated `LegacyLinearMapping` table instead of polluting core tables with `linearId` columns is an excellent architectural choice. It permits zero-downtime re-imports and idempotency. However, the lack of transaction boundaries fundamentally undermines the replay safety net, rendering it theoretically correct but physically fragile in failure modes.

## API consistency and error model
The usage of `graphql-yoga` masked errors cleanly shields the system from internal leakage. The error mapping (especially recognizing Prisma unique constraints) provides a strong foundation. Pagination heavily adheres to the Relay Connection standard perfectly. However, bounds limits (e.g. `first: 1000000`) are not validated defensively at the schema layer.

## UI state complexity
`BoardPage.tsx` acts as a God-component for local state. The matrix of `baseIssues`, `issueOverrides`, and `createdIssues` successfully accomplishes offline-feeling optimistic responses, but standard Apollo cache mutations (`cache.modify`) would radically reduce this file's 15+ `useState` dependencies and ease the impending M1 rewrite.

## Trust boundaries
Using `timingSafeEqual` for string comparisons demonstrates mature security awareness. The shared-token model with HMAC-signed viewer assertions perfectly strikes the balance between the "one-person" scope limits of M0 and the multi-user future of M3. It prevents complex OAuth flows while preserving trusted impersonation. The only flaw is the lax fallback mechanism returning the Admin user when assertions fail.

## Test adequacy versus milestone
Playwright tests efficiently cover the "golden path" UI flow, and the CI structure is healthy. However, the tests lag significantly behind the stated M0 goals. The E2E suite focuses exclusively on fresh item creation and deletion; it conspicuously lacks any test case asserting that *an imported dump renders correctly inside the columns*, leaving the primary acceptance criteria structurally unverified.

# Best next moves

**3 fixes to do immediately this week:**
1. Dynamically render Board columns based on the Team's actual workflow states rather than the hardcoded `BOARD_COLUMN_ORDER`.
2. Wrap `prisma.issue.create/upsert` and mapping updates in Prisma `$transaction` blocks inside `import-pipeline.ts`.
3. Add a strict `targetStateId` validation to the DND `handleDragEnd` callback to prevent accidental misallocation on cancellations.

**3 refactors to do after M0 is green:**
1. Migrate the `BoardPage.tsx` manual override states (`createdIssues`, `issueOverrides`) natively into Apollo's `Update` function and Optimistic Responses.
2. Abstract the duplicated mutation execution blocks (`runIssueMutation`, `runCommentMutation`) into a single wrapped higher-order resolver to clean `schema.ts`.
3. Clean up the dual-write conflict on `nextIssueNumber` between `updateTeamNextIssueNumbers` and the PG trigger.

**3 things to explicitly postpone:**
1. Advanced custom layout caching / issue ranking within vertical kanban columns.
2. Multi-team / Workspace wide RBAC definitions (M3).
3. Implementing chunked / paginated fetch loops for comments on the CLI. (Wait until real demand necessitates it).

# Patch candidates
- **`packages/web/src/routes/BoardPage.tsx`**: Fix cancelled drag handler. (Impact: Prevents silent data corruption. Risk: Low)
- **`packages/web/src/board/utils.ts`**: Alter `groupIssuesByState` to loop over team-provisioned states, appending unmapped values. (Impact: Unhides imported issues. Risk: Low)
- **`packages/server/src/import-pipeline.ts`**: Implement `$transaction` wrapper for entities and `createMapping`. (Impact: Restores idempotent safety net. Risk: Medium)
- **`packages/server/src/auth.ts`**: Replace implicit `DEFAULT_ADMIN_EMAIL` fallback with thrown error if viewer is requested but invalid. (Impact: Hardened implicit trust boundaries. Risk: Low)
- **`e2e/board-flow.spec.ts`**: Append new check testing that a seeded DB appropriately populates custom columns and issues. (Impact: Directly tests M0 acceptance goal. Risk: Low)
- **`packages/server/src/import-pipeline.ts`**: Swap `issue.create` for `issue.upsert` to defend against identifier constraint breakage. (Impact: Smoother re-import paths. Risk: Medium)

### Maintainer-facing verdict

- **What I would keep as-is**: The `LegacyLinearMapping` approach to idempotency, the monorepo abstraction boundaries, the Docker Compose developer experience, and the Playwright tooling. They are stellar.
- **What I would change before trusting this for a real Linear team import**: I would immediately rewrite the UI's Board State hardcoding (so custom issues don't disappear) and wrap the server's Import Pipeline mutations in `$transaction` blocks so a mid-import crash doesn't permanently brick the retry path with unique-constraint errors.
- **What I would not spend time on yet**: Implementing complex comment pagination logic in the CLI, rewriting the `BoardPage.tsx` cache update logic (save it for M1's redesign), and fine-grained team labeling. Focus completely on the stable migration path.

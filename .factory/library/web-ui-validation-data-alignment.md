# Web UI validation data alignment

- Run `cd ./packages/server && pnpm setup:web-ui-validation` before web-ui user-testing reruns.
- The setup is idempotent and backend-owned. It ensures:
  - `INV` exists with the canonical 6 workflow states.
  - `APP` exists with the canonical 6 workflow states for team-selector validation.
  - `VAL` exists as a dedicated empty-board validation team with the canonical 6 workflow states and no seeded issues.
  - Canonical labels are present/queryable.
  - `INV` has six uniquely titled validation cards (`web-ui-validation: <State> validation card`) plus 60 backlog cards titled `web-ui-validation: Many issues NN`.
  - Imported `SON` data remains intact; if `SON` exists, the setup backfills the canonical 6 workflow states so web validators can switch to SON without missing-column drift.
- Safe rerun behavior:
  - Existing matching validation issues are reused rather than duplicated.
  - Existing imported issues/comments are untouched.
  - The many-issues scenario is topped up to 60 cards if validators consumed or deleted some.

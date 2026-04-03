# SON validation dataset restore

- Purpose: restore the imported `SON` dataset needed by CLI/web/API cross-surface validation (`VAL-CROSS-007`, `VAL-CROSS-015`) without disturbing the seeded `INV`/`APP`/`VAL` validation data.
- Command: `cd ./packages/server && pnpm setup:son-validation`
- Equivalent manifest command: `.factory/services.yaml` → `commands.restore_son_validation_data`
- Source export: `./.factory/validation/import/user-testing/tmp/import-export-flow/export`
- What it does:
  - re-runs the import pipeline against the saved SON export fixture (idempotent),
  - then runs the existing web-ui validation setup so `INV`, `APP`, and `VAL` fixtures remain available,
  - leaves existing imported SON issues/comments intact on reruns.
- Expected result after a successful run:
  - `SON` team exists with ~404 imported issues,
  - CLI `issues list --team SON --json` returns imported issues,
  - API queries for `team.key = SON` return imported rows,
  - `INV` still contains the repeatable web-ui validation cards and `VAL` remains empty.
- Known caveat:
  - CLI `issues show SON-363` can still fail until the separate pre-existing CLI identifier lookup regression (current workspace baseline failure in `packages/cli/src/commands/issues.test.ts`) is fixed; list-based SON verification remains valid meanwhile.

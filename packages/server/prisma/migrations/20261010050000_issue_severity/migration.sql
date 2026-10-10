-- INV-1115: impact (severity) kept apart from priority; nullable, no backfill.
CREATE TYPE "IssueSeverity" AS ENUM ('SEV1', 'SEV2', 'SEV3');
ALTER TABLE "Issue" ADD COLUMN "severity" "IssueSeverity";

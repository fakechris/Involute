-- INV-996: when an executor last did something on a run, and when its owner
-- was told the run went quiet.
ALTER TABLE "WorkRun" ADD COLUMN "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "WorkRun" ADD COLUMN "staleNotifiedAt" TIMESTAMP(3);
-- Existing runs: their last known activity is their last update.
UPDATE "WorkRun" SET "lastActivityAt" = COALESCE("endedAt", "updatedAt");

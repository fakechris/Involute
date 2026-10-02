ALTER TABLE "WorkClaim" ADD COLUMN "executionTokenHash" TEXT, ADD COLUMN "executionId" TEXT;
ALTER TABLE "WorkRun" ADD COLUMN "executionTokenHash" TEXT, ADD COLUMN "executionId" TEXT;

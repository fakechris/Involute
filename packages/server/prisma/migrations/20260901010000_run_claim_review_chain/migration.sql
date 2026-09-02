CREATE TYPE "WorkReviewDecisionKind" AS ENUM ('ACCEPTED', 'REJECTED');

ALTER TABLE "WorkRun" ADD COLUMN "claimId" UUID;
ALTER TABLE "WorkRun" ADD COLUMN "baseRevision" INTEGER;
CREATE INDEX "WorkRun_claimId_idx" ON "WorkRun"("claimId");
ALTER TABLE "WorkRun"
  ADD CONSTRAINT "WorkRun_claimId_fkey"
  FOREIGN KEY ("claimId") REFERENCES "WorkClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkEvidence" ADD COLUMN "actorId" UUID;

CREATE INDEX "WorkEvidence_actorId_idx" ON "WorkEvidence"("actorId");
ALTER TABLE "WorkEvidence"
  ADD CONSTRAINT "WorkEvidence_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "WorkReviewDecision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workId" UUID NOT NULL,
    "runId" UUID,
    "reviewerId" UUID NOT NULL,
    "decision" "WorkReviewDecisionKind" NOT NULL,
    "reason" TEXT,
    "fromRevision" INTEGER NOT NULL,
    "toRevision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkReviewDecision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkReviewDecision_workId_createdAt_idx" ON "WorkReviewDecision"("workId", "createdAt");
CREATE INDEX "WorkReviewDecision_runId_idx" ON "WorkReviewDecision"("runId");
CREATE INDEX "WorkReviewDecision_reviewerId_idx" ON "WorkReviewDecision"("reviewerId");

ALTER TABLE "WorkReviewDecision"
  ADD CONSTRAINT "WorkReviewDecision_workId_fkey"
  FOREIGN KEY ("workId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkReviewDecision"
  ADD CONSTRAINT "WorkReviewDecision_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "WorkRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkReviewDecision"
  ADD CONSTRAINT "WorkReviewDecision_reviewerId_fkey"
  FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE "WorkflowState" SET "type" = 'REVIEW' WHERE lower("name") = 'in review';

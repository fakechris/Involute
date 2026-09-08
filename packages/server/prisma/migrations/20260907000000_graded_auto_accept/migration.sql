-- INV-11: graded auto-accept evaluations + enums
CREATE TYPE "AutoAcceptTier" AS ENUM ('CLEAR', 'LIKELY', 'AMBIGUOUS', 'INSUFFICIENT');
CREATE TYPE "AutoAcceptOutcome" AS ENUM ('ACCEPTED', 'SKIPPED');

CREATE TABLE "WorkAutoAcceptEvaluation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workId" UUID NOT NULL,
    "runId" UUID,
    "actorId" UUID,
    "tier" "AutoAcceptTier" NOT NULL,
    "outcome" "AutoAcceptOutcome" NOT NULL,
    "reasons" TEXT[] NOT NULL,
    "signals" JSONB NOT NULL,
    "decisionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkAutoAcceptEvaluation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkAutoAcceptEvaluation_decisionId_key" ON "WorkAutoAcceptEvaluation"("decisionId");
CREATE INDEX "WorkAutoAcceptEvaluation_workId_createdAt_idx" ON "WorkAutoAcceptEvaluation"("workId", "createdAt");
CREATE INDEX "WorkAutoAcceptEvaluation_runId_idx" ON "WorkAutoAcceptEvaluation"("runId");
CREATE INDEX "WorkAutoAcceptEvaluation_tier_outcome_idx" ON "WorkAutoAcceptEvaluation"("tier", "outcome");

ALTER TABLE "WorkAutoAcceptEvaluation"
  ADD CONSTRAINT "WorkAutoAcceptEvaluation_workId_fkey"
  FOREIGN KEY ("workId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkAutoAcceptEvaluation"
  ADD CONSTRAINT "WorkAutoAcceptEvaluation_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "WorkRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkAutoAcceptEvaluation"
  ADD CONSTRAINT "WorkAutoAcceptEvaluation_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkAutoAcceptEvaluation"
  ADD CONSTRAINT "WorkAutoAcceptEvaluation_decisionId_fkey"
  FOREIGN KEY ("decisionId") REFERENCES "WorkReviewDecision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

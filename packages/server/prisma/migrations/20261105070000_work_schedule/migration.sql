-- Scheduled rounds of work (INV-1582).
ALTER TABLE "WorkRun" ADD COLUMN "scheduleRound" INTEGER;

CREATE TABLE "WorkSchedule" (
  "id" UUID NOT NULL,
  "workId" UUID NOT NULL,
  "cron" TEXT NOT NULL,
  "timezone" TEXT NOT NULL,
  "agentId" UUID NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "nextRunAt" TIMESTAMP(3),
  "lastFiredAt" TIMESTAMP(3),
  "round" INTEGER NOT NULL DEFAULT 0,
  "missedRounds" INTEGER NOT NULL DEFAULT 0,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkSchedule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkSchedule_workId_key" ON "WorkSchedule"("workId");
CREATE INDEX "WorkSchedule_active_nextRunAt_idx" ON "WorkSchedule"("active", "nextRunAt");
ALTER TABLE "WorkSchedule" ADD CONSTRAINT "WorkSchedule_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkSchedule" ADD CONSTRAINT "WorkSchedule_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkSchedule" ADD CONSTRAINT "WorkSchedule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

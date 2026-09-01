-- CreateEnum
CREATE TYPE "WorkRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'BLOCKED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "WorkEvidenceKind" AS ENUM ('PR', 'TEST', 'LOG', 'SCREENSHOT', 'ARTIFACT', 'DECISION');

-- CreateTable
CREATE TABLE "AppSequence" (
    "name" TEXT NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "AppSequence_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "WorkRun" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "publicId" TEXT NOT NULL,
    "workId" UUID NOT NULL,
    "actorId" UUID,
    "status" "WorkRunStatus" NOT NULL DEFAULT 'RUNNING',
    "phase" TEXT,
    "summary" TEXT,
    "externalUrl" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkEvidence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workId" UUID NOT NULL,
    "runId" UUID,
    "kind" "WorkEvidenceKind" NOT NULL,
    "url" TEXT NOT NULL,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventOutbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "EventOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkRun_publicId_key" ON "WorkRun"("publicId");

-- CreateIndex
CREATE INDEX "WorkRun_workId_createdAt_idx" ON "WorkRun"("workId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkRun_actorId_idx" ON "WorkRun"("actorId");

-- CreateIndex
CREATE INDEX "WorkRun_status_idx" ON "WorkRun"("status");

-- CreateIndex
CREATE INDEX "WorkEvidence_workId_createdAt_idx" ON "WorkEvidence"("workId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkEvidence_runId_idx" ON "WorkEvidence"("runId");

-- CreateIndex
CREATE INDEX "EventOutbox_deliveredAt_createdAt_idx" ON "EventOutbox"("deliveredAt", "createdAt");

-- CreateIndex
CREATE INDEX "EventOutbox_type_idx" ON "EventOutbox"("type");

-- AddForeignKey
ALTER TABLE "WorkRun" ADD CONSTRAINT "WorkRun_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkRun" ADD CONSTRAINT "WorkRun_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkEvidence" ADD CONSTRAINT "WorkEvidence_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkEvidence" ADD CONSTRAINT "WorkEvidence_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

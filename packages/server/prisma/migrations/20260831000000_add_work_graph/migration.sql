-- CreateEnum
CREATE TYPE "ActorKind" AS ENUM ('HUMAN', 'AGENT', 'SERVICE');

-- CreateEnum
CREATE TYPE "WorkKind" AS ENUM ('ISSUE', 'PROJECT', 'MILESTONE', 'DECISION', 'EPIC');

-- CreateEnum
CREATE TYPE "CommitmentStatus" AS ENUM ('CANDIDATE', 'COMMITTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WorkLinkType" AS ENUM ('CONTAINS', 'BLOCKS', 'DERIVED_FROM', 'DISCOVERED_DURING', 'RELATED_TO', 'DUPLICATE_OF');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "actorKind" "ActorKind" NOT NULL DEFAULT 'HUMAN';

-- AlterTable
ALTER TABLE "Issue" ADD COLUMN "kind" "WorkKind" NOT NULL DEFAULT 'ISSUE';
ALTER TABLE "Issue" ADD COLUMN "commitmentStatus" "CommitmentStatus" NOT NULL DEFAULT 'COMMITTED';
ALTER TABLE "Issue" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Issue" ADD COLUMN "outcome" TEXT;
ALTER TABLE "Issue" ADD COLUMN "scope" TEXT;
ALTER TABLE "Issue" ADD COLUMN "constraints" TEXT;
ALTER TABLE "Issue" ADD COLUMN "acceptance" TEXT;
ALTER TABLE "Issue" ADD COLUMN "verification" TEXT;
ALTER TABLE "Issue" ADD COLUMN "repository" TEXT;

-- CreateTable
CREATE TABLE "WorkLink" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "WorkLinkType" NOT NULL,
    "fromId" UUID NOT NULL,
    "toId" UUID NOT NULL,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkLink_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkLink_no_self_loop" CHECK ("fromId" <> "toId")
);

-- CreateTable
CREATE TABLE "WorkAudit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "actorKind" "ActorKind" NOT NULL,
    "actorId" UUID,
    "surface" TEXT,
    "sessionId" TEXT,
    "sourceMessageId" TEXT,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkLink_fromId_toId_type_key" ON "WorkLink"("fromId", "toId", "type");

-- CreateIndex
CREATE INDEX "WorkLink_fromId_type_idx" ON "WorkLink"("fromId", "type");

-- CreateIndex
CREATE INDEX "WorkLink_toId_type_idx" ON "WorkLink"("toId", "type");

-- CreateIndex
CREATE INDEX "WorkLink_actorId_idx" ON "WorkLink"("actorId");

-- CreateIndex
CREATE INDEX "WorkAudit_workId_createdAt_idx" ON "WorkAudit"("workId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkAudit_actorId_idx" ON "WorkAudit"("actorId");

-- CreateIndex
CREATE INDEX "Issue_kind_idx" ON "Issue"("kind");

-- CreateIndex
CREATE INDEX "Issue_commitmentStatus_idx" ON "Issue"("commitmentStatus");

-- CreateIndex
CREATE INDEX "Issue_repository_idx" ON "Issue"("repository");

-- AddForeignKey
ALTER TABLE "WorkLink" ADD CONSTRAINT "WorkLink_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkLink" ADD CONSTRAINT "WorkLink_toId_fkey" FOREIGN KEY ("toId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkLink" ADD CONSTRAINT "WorkLink_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkAudit" ADD CONSTRAINT "WorkAudit_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkAudit" ADD CONSTRAINT "WorkAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill contains links from existing parent/child rows.
INSERT INTO "WorkLink" ("id", "type", "fromId", "toId", "createdAt")
SELECT gen_random_uuid(), 'CONTAINS', "parentId", "id", CURRENT_TIMESTAMP
FROM "Issue"
WHERE "parentId" IS NOT NULL;

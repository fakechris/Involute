-- INV-869: agents propose changes to a committed contract; a person accepts or rejects them.
-- CreateEnum
CREATE TYPE "ContractAmendmentStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "ContractAmendment" (
    "id" UUID NOT NULL,
    "workId" UUID NOT NULL,
    "proposedById" UUID NOT NULL,
    "baseRevision" INTEGER NOT NULL,
    "changes" JSONB NOT NULL,
    "before" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ContractAmendmentStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractAmendment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContractAmendment_workId_status_idx" ON "ContractAmendment"("workId", "status");

-- CreateIndex
CREATE INDEX "ContractAmendment_proposedById_idx" ON "ContractAmendment"("proposedById");

-- AddForeignKey
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "ContractAmendment_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "ContractAmendment_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "ContractAmendment_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

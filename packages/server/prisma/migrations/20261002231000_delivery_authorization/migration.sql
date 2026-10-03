-- AlterTable
ALTER TABLE "Issue" ADD COLUMN     "deliveryGrantRevision" INTEGER,
ADD COLUMN     "deliveryRootId" UUID,
ADD COLUMN     "deliveryUnitKey" TEXT,
ADD COLUMN     "supersededById" UUID;

-- CreateTable
CREATE TABLE "DeliveryPackage" (
    "workId" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "policy" JSONB NOT NULL,
    "contractDigest" TEXT NOT NULL,
    "approvedById" UUID NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "DeliveryPackage_pkey" PRIMARY KEY ("workId")
);

-- CreateTable
CREATE TABLE "DeliveryChangeSet" (
    "id" UUID NOT NULL,
    "workId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "before" JSONB NOT NULL,
    "proposedById" UUID NOT NULL,
    "decidedById" UUID,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "DeliveryChangeSet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryChangeSet_status_createdAt_idx" ON "DeliveryChangeSet"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Issue_deliveryRootId_deliveryUnitKey_deliveryGrantRevision_key" ON "Issue"("deliveryRootId", "deliveryUnitKey", "deliveryGrantRevision");

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "Issue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryPackage" ADD CONSTRAINT "DeliveryPackage_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryPackage" ADD CONSTRAINT "DeliveryPackage_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryChangeSet" ADD CONSTRAINT "DeliveryChangeSet_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryChangeSet" ADD CONSTRAINT "DeliveryChangeSet_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryChangeSet" ADD CONSTRAINT "DeliveryChangeSet_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


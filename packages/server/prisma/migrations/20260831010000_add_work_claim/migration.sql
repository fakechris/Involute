-- CreateTable
CREATE TABLE "WorkClaim" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkIdempotency" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "workId" UUID NOT NULL,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkIdempotency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkClaim_workId_key" ON "WorkClaim"("workId");

-- CreateIndex
CREATE INDEX "WorkClaim_actorId_idx" ON "WorkClaim"("actorId");

-- CreateIndex
CREATE INDEX "WorkClaim_leaseUntil_idx" ON "WorkClaim"("leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "WorkIdempotency_operation_key_key" ON "WorkIdempotency"("operation", "key");

-- CreateIndex
CREATE INDEX "WorkIdempotency_workId_idx" ON "WorkIdempotency"("workId");

-- AddForeignKey
ALTER TABLE "WorkClaim" ADD CONSTRAINT "WorkClaim_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkClaim" ADD CONSTRAINT "WorkClaim_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkIdempotency" ADD CONSTRAINT "WorkIdempotency_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

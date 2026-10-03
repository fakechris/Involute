-- CreateTable
CREATE TABLE "ExecutorDispatch" (
    "id" UUID NOT NULL,
    "workId" UUID NOT NULL,
    "rootId" UUID NOT NULL,
    "grantRevision" INTEGER NOT NULL,
    "executorActorId" UUID NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "runId" UUID,
    "leaseUntil" TIMESTAMP(3),
    "checkpoint" TEXT,
    "feedback" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutorDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutorEffect" (
    "id" UUID NOT NULL,
    "dispatchId" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "environment" TEXT,
    "commitSha" TEXT NOT NULL,
    "paths" TEXT[],
    "state" TEXT NOT NULL DEFAULT 'PREPARED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),

    CONSTRAINT "ExecutorEffect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutorDeliveryReceipt" (
    "id" UUID NOT NULL,
    "dispatchId" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "runId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutorDeliveryReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExecutorDispatch_executorActorId_state_idx" ON "ExecutorDispatch"("executorActorId", "state");

-- CreateIndex
CREATE INDEX "ExecutorDispatch_rootId_idx" ON "ExecutorDispatch"("rootId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutorDispatch_workId_grantRevision_key" ON "ExecutorDispatch"("workId", "grantRevision");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutorEffect_dispatchId_generation_key_key" ON "ExecutorEffect"("dispatchId", "generation", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutorDeliveryReceipt_dispatchId_generation_idempotencyKe_key" ON "ExecutorDeliveryReceipt"("dispatchId", "generation", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "ExecutorEffect" ADD CONSTRAINT "ExecutorEffect_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "ExecutorDispatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutorDeliveryReceipt" ADD CONSTRAINT "ExecutorDeliveryReceipt_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "ExecutorDispatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

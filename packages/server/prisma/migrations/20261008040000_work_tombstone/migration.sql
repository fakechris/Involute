-- INV-840: a deleted work item leaves a snapshot so its deletion can be undone by id.
CREATE TABLE "WorkTombstone" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "deletedById" UUID,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkTombstone_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkTombstone_teamId_deletedAt_idx" ON "WorkTombstone"("teamId", "deletedAt");

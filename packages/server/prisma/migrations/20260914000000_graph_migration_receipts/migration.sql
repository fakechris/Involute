CREATE TABLE "WorkGraphMigration" (
  "id" UUID NOT NULL,
  "planHash" TEXT NOT NULL,
  "teamId" UUID NOT NULL,
  "actorId" UUID,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'APPLIED',
  "plan" JSONB NOT NULL,
  "before" JSONB NOT NULL,
  "after" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rolledBackAt" TIMESTAMP(3),
  CONSTRAINT "WorkGraphMigration_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkGraphMigration_planHash_key" ON "WorkGraphMigration"("planHash");
CREATE INDEX "WorkGraphMigration_teamId_createdAt_idx" ON "WorkGraphMigration"("teamId", "createdAt");

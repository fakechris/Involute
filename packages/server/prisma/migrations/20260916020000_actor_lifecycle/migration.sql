-- INV-586: actor lifecycle — owners, deactivation, and history that cannot be orphaned.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "ownerId" UUID;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "User_ownerId_idx" ON "User"("ownerId");

ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_ownerId_fkey";
ALTER TABLE "User" ADD CONSTRAINT "User_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Deleting an actor that has written history is now refused at the database.
ALTER TABLE "WorkAudit" DROP CONSTRAINT IF EXISTS "WorkAudit_actorId_fkey";
ALTER TABLE "WorkAudit" ADD CONSTRAINT "WorkAudit_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ActorAudit" (
    "id" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "byActorId" UUID,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActorAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ActorAudit_subjectId_createdAt_idx" ON "ActorAudit"("subjectId", "createdAt");
ALTER TABLE "ActorAudit" DROP CONSTRAINT IF EXISTS "ActorAudit_subjectId_fkey";
ALTER TABLE "ActorAudit" ADD CONSTRAINT "ActorAudit_subjectId_fkey"
    FOREIGN KEY ("subjectId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActorAudit" DROP CONSTRAINT IF EXISTS "ActorAudit_byActorId_fkey";
ALTER TABLE "ActorAudit" ADD CONSTRAINT "ActorAudit_byActorId_fkey"
    FOREIGN KEY ("byActorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

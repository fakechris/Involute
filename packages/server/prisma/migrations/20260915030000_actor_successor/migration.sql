-- INV-562 (B5): "who should I ask instead" when a request goes unanswered.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "successorActorId" UUID;

CREATE INDEX IF NOT EXISTS "User_successorActorId_idx" ON "User"("successorActorId");

ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_successorActorId_fkey";
ALTER TABLE "User" ADD CONSTRAINT "User_successorActorId_fkey"
    FOREIGN KEY ("successorActorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

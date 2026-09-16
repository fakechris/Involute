-- INV-573: agent actors carry a readable profile, so a person seeing "Mia" in a
-- thread can tell what Mia is.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "runtime" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "agentCardUrl" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3);

-- Directory listing orders by recency of activity.
CREATE INDEX IF NOT EXISTS "User_actorKind_lastSeenAt_idx" ON "User"("actorKind", "lastSeenAt");

-- INV-573 P1: a claim belongs to an execution, not merely to an actor.
ALTER TABLE "AgentRequest" ADD COLUMN IF NOT EXISTS "claimGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentRequest" ADD COLUMN IF NOT EXISTS "claimTokenHash" TEXT;

-- INV-589: successor hand-off chains.
ALTER TABLE "AgentRequest" ADD COLUMN IF NOT EXISTS "rootRequestId" UUID;
ALTER TABLE "AgentRequest" ADD COLUMN IF NOT EXISTS "handedOffFromId" UUID;
ALTER TABLE "AgentRequest" ADD COLUMN IF NOT EXISTS "hopCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentRequest" ADD COLUMN IF NOT EXISTS "chainDeadlineAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "AgentRequest_rootRequestId_idx" ON "AgentRequest"("rootRequestId");

-- The hand-off card a delegation carries (INV-1583).
ALTER TABLE "AgentRequest" ADD COLUMN "handoff" JSONB;

-- INV-1119: a needinfo is an AgentRequest raised explicitly to a named person
-- (human or agent). It is cleared by any comment of its target on the work, and
-- while it waits on a bug's reporter the bug SLA clock is paused.
ALTER TABLE "AgentRequest" ADD COLUMN "needInfo" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "AgentRequest_workId_needInfo_state_idx" ON "AgentRequest"("workId", "needInfo", "state");

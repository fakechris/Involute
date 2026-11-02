-- INV-1493: explicit, budgeted agent-to-agent delegation and the L3 completion reply template.
ALTER TABLE "AgentRequest" ADD COLUMN "budgetUnits" INTEGER;
ALTER TABLE "WorkflowPolicy" ADD COLUMN "completionReply" TEXT;

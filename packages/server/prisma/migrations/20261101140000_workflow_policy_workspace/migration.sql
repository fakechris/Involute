-- INV-1489: workspace-only policy fields — pause switch, default level for new teams, named templates.
ALTER TABLE "WorkflowPolicy" ADD COLUMN "paused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WorkflowPolicy" ADD COLUMN "defaultLevel" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WorkflowPolicy" ADD COLUMN "templates" JSONB NOT NULL DEFAULT '[]';

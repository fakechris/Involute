-- CreateEnum
CREATE TYPE "WorkflowStateType" AS ENUM ('BACKLOG', 'UNSTARTED', 'STARTED', 'COMPLETED', 'CANCELED');

-- AlterTable: Add priority to Issue
ALTER TABLE "Issue" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: Add type and position to WorkflowState
ALTER TABLE "WorkflowState" ADD COLUMN "type" "WorkflowStateType" NOT NULL DEFAULT 'UNSTARTED';
ALTER TABLE "WorkflowState" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

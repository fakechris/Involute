-- INV-1120: regression links and reopen events.
ALTER TYPE "WorkLinkType" ADD VALUE 'REGRESSED_BY';

ALTER TABLE "Issue" ADD COLUMN "reopenCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "WorkReopen" (
    "id" UUID NOT NULL,
    "workId" UUID NOT NULL,
    "auditId" UUID NOT NULL,
    "fromStateType" "WorkflowStateType" NOT NULL,
    "toStateType" "WorkflowStateType" NOT NULL,
    "afterAutoAccept" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkReopen_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkReopen_auditId_key" ON "WorkReopen"("auditId");
CREATE INDEX "WorkReopen_workId_createdAt_idx" ON "WorkReopen"("workId", "createdAt");

ALTER TABLE "WorkReopen" ADD CONSTRAINT "WorkReopen_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkReopen" ADD CONSTRAINT "WorkReopen_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "WorkAudit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

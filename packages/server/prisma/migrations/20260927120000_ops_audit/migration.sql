-- Who did what on the ops page (INV-796).
CREATE TABLE "OpsAudit" (
    "id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "byActorId" UUID,
    "reason" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpsAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OpsAudit_createdAt_idx" ON "OpsAudit"("createdAt");

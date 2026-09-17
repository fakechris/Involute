-- INV-588: decision receipts, 1:1 with the audit row they explain.
CREATE TABLE IF NOT EXISTS "DecisionReceipt" (
    "id" UUID NOT NULL,
    "auditId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "sessionId" TEXT,
    "runtime" TEXT,
    "contractRevision" INTEGER NOT NULL,
    "reasoning" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "inputs" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DecisionReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionReceipt_auditId_key" ON "DecisionReceipt"("auditId");
CREATE INDEX IF NOT EXISTS "DecisionReceipt_actorId_createdAt_idx" ON "DecisionReceipt"("actorId", "createdAt");
ALTER TABLE "DecisionReceipt" DROP CONSTRAINT IF EXISTS "DecisionReceipt_auditId_fkey";
ALTER TABLE "DecisionReceipt" ADD CONSTRAINT "DecisionReceipt_auditId_fkey"
    FOREIGN KEY ("auditId") REFERENCES "WorkAudit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DecisionReceipt" DROP CONSTRAINT IF EXISTS "DecisionReceipt_actorId_fkey";
ALTER TABLE "DecisionReceipt" ADD CONSTRAINT "DecisionReceipt_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

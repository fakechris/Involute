-- INV-598: evidence is retracted, never deleted.
ALTER TABLE "WorkEvidence"
  ADD COLUMN "retractedAt" TIMESTAMP(3),
  ADD COLUMN "retractedById" UUID,
  ADD COLUMN "retractReason" TEXT,
  ADD COLUMN "supersededByWorkId" UUID;
ALTER TABLE "WorkEvidence" ADD CONSTRAINT "WorkEvidence_retractedById_fkey"
  FOREIGN KEY ("retractedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkEvidence" ADD CONSTRAINT "WorkEvidence_supersededByWorkId_fkey"
  FOREIGN KEY ("supersededByWorkId") REFERENCES "Issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "WorkEvidence_retractedAt_idx" ON "WorkEvidence"("retractedAt");

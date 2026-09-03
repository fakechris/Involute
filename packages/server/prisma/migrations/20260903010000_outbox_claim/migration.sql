ALTER TABLE "EventOutbox" ADD COLUMN "claimedAt" TIMESTAMP(3);
CREATE INDEX "EventOutbox_claimedAt_idx" ON "EventOutbox"("claimedAt");

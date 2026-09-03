ALTER TABLE "WorkIdempotency" ADD COLUMN "resultId" UUID;
CREATE INDEX "WorkIdempotency_resultId_idx" ON "WorkIdempotency"("resultId");

-- INV-587: audit rows for request events carry the claim generation.
ALTER TABLE "WorkAudit" ADD COLUMN IF NOT EXISTS "claimGeneration" INTEGER;

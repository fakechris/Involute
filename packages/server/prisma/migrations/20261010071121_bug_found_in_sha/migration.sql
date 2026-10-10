-- INV-1121: the deploy (build SHA) a bug was found in; nullable, no backfill.
-- The fix SHA is not stored: it is derived from GitHub-observed merge evidence.
ALTER TABLE "Issue" ADD COLUMN "foundInSha" VARCHAR(40);

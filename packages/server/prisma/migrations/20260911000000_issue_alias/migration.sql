-- INV-459: project alias routing — per-project reference alias on Issue nodes
ALTER TABLE "Issue" ADD COLUMN IF NOT EXISTS "alias" TEXT;

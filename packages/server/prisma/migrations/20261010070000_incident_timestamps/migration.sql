-- INV-1125: incident impact timestamps, set only on Type: Incident; nullable, no backfill.
ALTER TABLE "Issue" ADD COLUMN "impactStartedAt" TIMESTAMP(3),
ADD COLUMN "detectedAt" TIMESTAMP(3),
ADD COLUMN "mitigatedAt" TIMESTAMP(3),
ADD COLUMN "resolvedAt" TIMESTAMP(3);

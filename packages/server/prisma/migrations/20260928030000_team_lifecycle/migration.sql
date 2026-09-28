-- INV-848: teams are archived, never deleted: identifiers carry the key.
ALTER TABLE "Team" ADD COLUMN "archivedAt" TIMESTAMP(3);

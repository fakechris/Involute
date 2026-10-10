-- INV-1122: how often a bug reproduces; nullable, no backfill.
CREATE TYPE "BugReproducibility" AS ENUM ('ALWAYS', 'SOMETIMES', 'ONCE');
ALTER TABLE "Issue" ADD COLUMN "reproducibility" "BugReproducibility";

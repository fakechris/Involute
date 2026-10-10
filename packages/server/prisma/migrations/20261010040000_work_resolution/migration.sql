-- INV-1118: structured close reason for rejected candidates and canceled work.
CREATE TYPE "WorkResolution" AS ENUM ('COMPLETED', 'WONT_DO', 'INVALID', 'DUPLICATE', 'CANNOT_REPRODUCE', 'OBSOLETE');
ALTER TABLE "Issue" ADD COLUMN "resolution" "WorkResolution";

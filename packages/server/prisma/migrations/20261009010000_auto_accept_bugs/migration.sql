-- INV-1075: a PROJECT may let verified bug fixes close themselves.
ALTER TABLE "Issue" ADD COLUMN "autoAcceptBugs" BOOLEAN NOT NULL DEFAULT false;

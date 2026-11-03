-- What a completed run leaves behind (INV-1231).
ALTER TABLE "WorkRun" ADD COLUMN "followups" JSONB;

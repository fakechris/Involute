-- INV-1093: a notification that asked for a decision records that it was made.
ALTER TABLE "Notification" ADD COLUMN "resolvedAt" TIMESTAMP(3);
ALTER TABLE "Notification" ADD COLUMN "resolvedById" UUID;
ALTER TABLE "Notification" ADD COLUMN "resolution" TEXT;
CREATE INDEX "Notification_workId_type_idx" ON "Notification"("workId", "type");

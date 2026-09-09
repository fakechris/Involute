-- Phase 2: GitHub webhook dual-track CAS state machine support
-- AlterTable Issue: add PR provenance tracking
ALTER TABLE "Issue" ADD COLUMN IF NOT EXISTS "stateSourcePrId" TEXT;
ALTER TABLE "Issue" ADD COLUMN IF NOT EXISTS "lastAppliedEventTime" TIMESTAMP(3);

-- CreateTable WebhookEventLog: idempotent event deduplication
CREATE TABLE IF NOT EXISTS "WebhookEventLog" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "issueId" UUID NOT NULL,
    "eventSourceKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookEventLog_pkey" PRIMARY KEY ("id")
);

-- Phase 3: Persistent watermark cursor for reconciliation sync
CREATE TABLE IF NOT EXISTS "SyncWatermark" (
    "key" TEXT NOT NULL,
    "watermark" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncWatermark_pkey" PRIMARY KEY ("key")
);

-- Phase 3: Dead-letter quarantine for poisoned PR events
CREATE TABLE IF NOT EXISTS "SyncDeadLetter" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "repository" TEXT NOT NULL,
    "itemRef" TEXT NOT NULL,
    "error" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastFailedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncDeadLetter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idx_webhook_event_source" ON "WebhookEventLog"("issueId", "eventSourceKey");
CREATE INDEX IF NOT EXISTS "WebhookEventLog_issueId_idx" ON "WebhookEventLog"("issueId");
CREATE INDEX IF NOT EXISTS "WebhookEventLog_eventSourceKey_idx" ON "WebhookEventLog"("eventSourceKey");

CREATE UNIQUE INDEX IF NOT EXISTS "SyncDeadLetter_repository_itemRef_key" ON "SyncDeadLetter"("repository", "itemRef");
CREATE INDEX IF NOT EXISTS "SyncDeadLetter_repository_idx" ON "SyncDeadLetter"("repository");

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'WebhookEventLog_issueId_fkey'
    ) THEN
        ALTER TABLE "WebhookEventLog"
          ADD CONSTRAINT "WebhookEventLog_issueId_fkey"
          FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE TABLE "WebhookSubscription" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "label" TEXT,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "teamId" UUID,
    "eventTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "WebhookSubscription_teamId_idx" ON "WebhookSubscription"("teamId");
CREATE INDEX "WebhookSubscription_enabled_idx" ON "WebhookSubscription"("enabled");

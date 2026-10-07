-- INV-992: a webhook subscription bound to one agent delivers only what that
-- agent's inbox receives (and its executor dispatches), so a decision wakes it.

-- AlterTable
ALTER TABLE "WebhookSubscription" ADD COLUMN "actorId" UUID;

-- CreateIndex
CREATE INDEX "WebhookSubscription_actorId_idx" ON "WebhookSubscription"("actorId");

-- AddForeignKey
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

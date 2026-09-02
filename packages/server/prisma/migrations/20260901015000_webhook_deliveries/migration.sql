ALTER TABLE "EventOutbox" ADD COLUMN "deadLetteredAt" TIMESTAMP(3);

CREATE TABLE "EventOutboxDelivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "eventId" UUID NOT NULL,
    "targetHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "deliveredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventOutboxDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EventOutboxDelivery_eventId_targetHash_key"
  ON "EventOutboxDelivery"("eventId", "targetHash");
CREATE INDEX "EventOutboxDelivery_deliveredAt_attempts_idx"
  ON "EventOutboxDelivery"("deliveredAt", "attempts");

ALTER TABLE "EventOutboxDelivery"
  ADD CONSTRAINT "EventOutboxDelivery_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "EventOutbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

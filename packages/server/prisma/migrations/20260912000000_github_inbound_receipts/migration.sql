CREATE TYPE "InboundGitHubStatus" AS ENUM ('PENDING', 'PROCESSING', 'RETRY', 'PROCESSED', 'DEAD');
CREATE TABLE "InboundGitHubDelivery" (
  "id" UUID NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'github',
  "deliveryId" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "repository" TEXT NOT NULL,
  "payload" JSONB,
  "status" "InboundGitHubStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "InboundGitHubDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InboundGitHubDelivery_provider_deliveryId_key" ON "InboundGitHubDelivery"("provider", "deliveryId");
CREATE INDEX "InboundGitHubDelivery_status_availableAt_receivedAt_idx" ON "InboundGitHubDelivery"("status", "availableAt", "receivedAt");
CREATE INDEX "InboundGitHubDelivery_status_leaseUntil_idx" ON "InboundGitHubDelivery"("status", "leaseUntil");
CREATE TABLE "InboundGitHubAttempt" (
  "id" UUID NOT NULL,
  "deliveryId" UUID NOT NULL,
  "number" INTEGER NOT NULL,
  "leaseOwner" TEXT NOT NULL,
  "outcome" TEXT NOT NULL DEFAULT 'PROCESSING',
  "errorCode" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),
  CONSTRAINT "InboundGitHubAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InboundGitHubAttempt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "InboundGitHubDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "InboundGitHubAttempt_deliveryId_number_key" ON "InboundGitHubAttempt"("deliveryId", "number");
CREATE TABLE "InboundGitHubReplay" (
  "id" UUID NOT NULL,
  "deliveryId" UUID NOT NULL,
  "reason" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'operator-cli',
  "previousAttempts" INTEGER NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InboundGitHubReplay_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InboundGitHubReplay_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "InboundGitHubDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

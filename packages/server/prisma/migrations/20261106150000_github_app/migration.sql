-- The deployment's GitHub App (INV-1677).
CREATE TABLE "GitHubApp" (
  "id" UUID NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'github',
  "appId" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "htmlUrl" TEXT NOT NULL,
  "ownerLogin" TEXT NOT NULL,
  "clientId" TEXT,
  "clientSecretEncrypted" TEXT,
  "privateKeyEncrypted" TEXT NOT NULL,
  "webhookSecretEncrypted" TEXT NOT NULL,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GitHubApp_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GitHubApp_provider_key" ON "GitHubApp"("provider");

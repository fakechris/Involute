-- A team's GitHub connections (INV-1677).
CREATE TABLE "GitHubConnection" (
  "id" UUID NOT NULL,
  "teamId" UUID NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'github',
  "kind" TEXT NOT NULL,
  "installationId" TEXT,
  "accountLogin" TEXT NOT NULL,
  "accountType" TEXT,
  "repositorySelection" TEXT,
  "tokenEncrypted" TEXT,
  "tokenExpiresAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "lastError" TEXT,
  "lastCheckedAt" TIMESTAMP(3),
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GitHubConnection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GitHubConnection_installationId_key" ON "GitHubConnection"("installationId");
CREATE UNIQUE INDEX "GitHubConnection_teamId_provider_accountLogin_key" ON "GitHubConnection"("teamId", "provider", "accountLogin");
CREATE INDEX "GitHubConnection_accountLogin_idx" ON "GitHubConnection"("accountLogin");
ALTER TABLE "GitHubConnection" ADD CONSTRAINT "GitHubConnection_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

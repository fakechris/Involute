-- Agent credentials are hashed at rest and resolve to an AGENT User principal.
CREATE TABLE "AgentCredential" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AgentCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentCredential_tokenHash_key" ON "AgentCredential"("tokenHash");
CREATE INDEX "AgentCredential_userId_idx" ON "AgentCredential"("userId");
CREATE INDEX "AgentCredential_revokedAt_expiresAt_idx" ON "AgentCredential"("revokedAt", "expiresAt");

ALTER TABLE "AgentCredential"
  ADD CONSTRAINT "AgentCredential_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Scope idempotency by team and principal, retain a request fingerprint, and
-- allow a transaction to reserve a key before the resulting work row exists.
ALTER TABLE "WorkIdempotency" ADD COLUMN "teamId" UUID;
ALTER TABLE "WorkIdempotency" ADD COLUMN "actorKey" TEXT;
ALTER TABLE "WorkIdempotency" ADD COLUMN "requestHash" TEXT;
ALTER TABLE "WorkIdempotency" ALTER COLUMN "workId" DROP NOT NULL;

UPDATE "WorkIdempotency" AS idem
SET
  "teamId" = issue."teamId",
  "actorKey" = COALESCE(idem."actorId"::text, 'service'),
  "requestHash" = 'legacy'
FROM "Issue" AS issue
WHERE issue."id" = idem."workId";

ALTER TABLE "WorkIdempotency" ALTER COLUMN "teamId" SET NOT NULL;
ALTER TABLE "WorkIdempotency" ALTER COLUMN "actorKey" SET NOT NULL;
ALTER TABLE "WorkIdempotency" ALTER COLUMN "requestHash" SET NOT NULL;

DROP INDEX "WorkIdempotency_operation_key_key";
ALTER TABLE "WorkIdempotency" DROP CONSTRAINT "WorkIdempotency_workId_fkey";
CREATE UNIQUE INDEX "WorkIdempotency_teamId_actorKey_operation_key_key"
  ON "WorkIdempotency"("teamId", "actorKey", "operation", "key");
CREATE INDEX "WorkIdempotency_teamId_idx" ON "WorkIdempotency"("teamId");

ALTER TABLE "WorkIdempotency"
  ADD CONSTRAINT "WorkIdempotency_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkIdempotency"
  ADD CONSTRAINT "WorkIdempotency_workId_fkey"
  FOREIGN KEY ("workId") REFERENCES "Issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

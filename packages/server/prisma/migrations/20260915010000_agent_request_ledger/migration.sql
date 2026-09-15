-- INV-560 (B3): the agent request ledger. A2A task states, server-side claim
-- and answer.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AgentRequestState') THEN
        CREATE TYPE "AgentRequestState" AS ENUM (
            'SUBMITTED', 'WORKING', 'INPUT_REQUIRED', 'COMPLETED', 'FAILED', 'CANCELED'
        );
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "AgentRequest" (
    "id" UUID NOT NULL,
    "workId" UUID NOT NULL,
    "rootCommentId" UUID NOT NULL,
    "targetActorId" UUID NOT NULL,
    "requestedByActorId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "state" "AgentRequestState" NOT NULL DEFAULT 'SUBMITTED',
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "canceledAt" TIMESTAMP(3),
    "claimedBy" UUID,
    "claimedAt" TIMESTAMP(3),
    "claimExpiresAt" TIMESTAMP(3),
    "answeredCommentId" UUID,
    "failureReason" TEXT,
    "payingPrincipal" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgentRequest_answeredCommentId_key"
    ON "AgentRequest"("answeredCommentId");
CREATE UNIQUE INDEX IF NOT EXISTS "AgentRequest_idempotencyKey_key"
    ON "AgentRequest"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "AgentRequest_targetActorId_state_createdAt_idx"
    ON "AgentRequest"("targetActorId", "state", "createdAt");
CREATE INDEX IF NOT EXISTS "AgentRequest_workId_createdAt_idx"
    ON "AgentRequest"("workId", "createdAt");
CREATE INDEX IF NOT EXISTS "AgentRequest_state_deadlineAt_idx"
    ON "AgentRequest"("state", "deadlineAt");
CREATE INDEX IF NOT EXISTS "AgentRequest_rootCommentId_idx"
    ON "AgentRequest"("rootCommentId");

ALTER TABLE "AgentRequest" DROP CONSTRAINT IF EXISTS "AgentRequest_workId_fkey";
ALTER TABLE "AgentRequest" ADD CONSTRAINT "AgentRequest_workId_fkey"
    FOREIGN KEY ("workId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentRequest" DROP CONSTRAINT IF EXISTS "AgentRequest_rootCommentId_fkey";
ALTER TABLE "AgentRequest" ADD CONSTRAINT "AgentRequest_rootCommentId_fkey"
    FOREIGN KEY ("rootCommentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentRequest" DROP CONSTRAINT IF EXISTS "AgentRequest_targetActorId_fkey";
ALTER TABLE "AgentRequest" ADD CONSTRAINT "AgentRequest_targetActorId_fkey"
    FOREIGN KEY ("targetActorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentRequest" DROP CONSTRAINT IF EXISTS "AgentRequest_requestedByActorId_fkey";
ALTER TABLE "AgentRequest" ADD CONSTRAINT "AgentRequest_requestedByActorId_fkey"
    FOREIGN KEY ("requestedByActorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentRequest" DROP CONSTRAINT IF EXISTS "AgentRequest_claimedBy_fkey";
ALTER TABLE "AgentRequest" ADD CONSTRAINT "AgentRequest_claimedBy_fkey"
    FOREIGN KEY ("claimedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AgentRequest" DROP CONSTRAINT IF EXISTS "AgentRequest_answeredCommentId_fkey";
ALTER TABLE "AgentRequest" ADD CONSTRAINT "AgentRequest_answeredCommentId_fkey"
    FOREIGN KEY ("answeredCommentId") REFERENCES "Comment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- New credentials get the `answer` scope by default; existing credentials keep
-- whatever was granted at issuance and must be re-issued to gain it.
ALTER TABLE "AgentCredential"
    ALTER COLUMN "scopes"
    SET DEFAULT ARRAY['read', 'propose', 'claim', 'report', 'update', 'link', 'answer']::TEXT[];

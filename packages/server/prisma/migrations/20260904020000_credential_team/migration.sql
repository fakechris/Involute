ALTER TABLE "AgentCredential" ADD COLUMN "teamId" UUID;

-- Backfill the issuing team from the agent user's earliest membership.
UPDATE "AgentCredential" c
SET "teamId" = sub."teamId"
FROM (
  SELECT DISTINCT ON (m."userId") m."userId", m."teamId"
  FROM "TeamMembership" m
  ORDER BY m."userId", m."createdAt" ASC
) sub
WHERE sub."userId" = c."userId";

ALTER TABLE "AgentCredential" ADD CONSTRAINT "AgentCredential_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "AgentCredential_teamId_idx" ON "AgentCredential"("teamId");

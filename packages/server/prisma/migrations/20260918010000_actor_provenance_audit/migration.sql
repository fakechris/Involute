-- INV-604: who brought an actor into existence, and when.
-- User.createdAt is nullable on purpose: rows that predate this migration get
-- the earliest trace we have of them (an audit row, a credential, a write), and
-- NULL when there is none. A fabricated timestamp would read as a fact.
ALTER TABLE "User" ADD COLUMN "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
UPDATE "User" u SET "createdAt" = least(
  (SELECT min(a."createdAt") FROM "ActorAudit" a WHERE a."subjectId" = u.id),
  (SELECT min(c."createdAt") FROM "AgentCredential" c WHERE c."userId" = u.id),
  (SELECT min(w."createdAt") FROM "WorkAudit" w WHERE w."actorId" = u.id)
);

ALTER TABLE "AgentCredential" ADD COLUMN "issuedById" UUID;
ALTER TABLE "AgentCredential" ADD CONSTRAINT "AgentCredential_issuedById_fkey"
  FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

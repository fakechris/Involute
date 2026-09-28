-- INV-832: a PROJECT node can be shared with a person or an agent outside its
-- team. The share is the permission carrier; issues, identifiers and teams
-- stay where they are.
CREATE TYPE "WorkShareRole" AS ENUM ('VIEWER', 'EDITOR');

CREATE TABLE "WorkShare" (
  "id" UUID NOT NULL,
  "workId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "role" "WorkShareRole" NOT NULL DEFAULT 'VIEWER',
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkShare_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkShare_workId_userId_key" ON "WorkShare"("workId", "userId");
CREATE INDEX "WorkShare_userId_idx" ON "WorkShare"("userId");

ALTER TABLE "WorkShare" ADD CONSTRAINT "WorkShare_workId_fkey"
  FOREIGN KEY ("workId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkShare" ADD CONSTRAINT "WorkShare_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkShare" ADD CONSTRAINT "WorkShare_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

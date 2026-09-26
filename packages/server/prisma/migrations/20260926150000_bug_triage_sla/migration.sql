-- Bug route v1 (INV-750): weekly triage rotation per team, one SLA reminder per bug and kind.
ALTER TABLE "Team" ADD COLUMN "triageRotation" JSONB;

CREATE TABLE "BugSlaAlert" (
    "id" UUID NOT NULL,
    "workId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BugSlaAlert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BugSlaAlert_workId_kind_key" ON "BugSlaAlert"("workId", "kind");

ALTER TABLE "BugSlaAlert" ADD CONSTRAINT "BugSlaAlert_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

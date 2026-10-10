-- INV-1120: regression links and reopen events.
ALTER TYPE "WorkLinkType" ADD VALUE 'REGRESSED_BY';

ALTER TABLE "Issue" ADD COLUMN "reopenCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "WorkReopen" (
    "id" UUID NOT NULL,
    "workId" UUID NOT NULL,
    "auditId" UUID NOT NULL,
    "fromStateType" "WorkflowStateType" NOT NULL,
    "toStateType" "WorkflowStateType" NOT NULL,
    "afterAutoAccept" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkReopen_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkReopen_auditId_key" ON "WorkReopen"("auditId");
CREATE INDEX "WorkReopen_workId_createdAt_idx" ON "WorkReopen"("workId", "createdAt");

ALTER TABLE "WorkReopen" ADD CONSTRAINT "WorkReopen_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkReopen" ADD CONSTRAINT "WorkReopen_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "WorkAudit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill from the audit trail, which records every state change: each audit
-- that moved work from Done / Canceled to an open state is a reopen. The closed
-- spell it left was entered by the latest earlier audit that moved the work
-- from an open state (or from nothing) into Done / Canceled; Done <-> Canceled
-- moves stay inside the spell. Same rule as recordReopenIfAny.
INSERT INTO "WorkReopen" ("id", "workId", "auditId", "fromStateType", "toStateType", "afterAutoAccept", "createdAt")
SELECT gen_random_uuid(), a."workId", a."id", before_state."type", after_state."type",
       COALESCE(entry."email" = 'auto-accept@involute.internal', false), a."createdAt"
FROM "WorkAudit" a
JOIN "WorkflowState" before_state ON before_state."id"::text = a."before"->>'stateId'
JOIN "WorkflowState" after_state ON after_state."id"::text = a."after"->>'stateId'
LEFT JOIN LATERAL (
  SELECT u."email"
  FROM "WorkAudit" e
  JOIN "WorkflowState" e_after ON e_after."id"::text = e."after"->>'stateId'
  LEFT JOIN "WorkflowState" e_before ON e_before."id"::text = e."before"->>'stateId'
  LEFT JOIN "User" u ON u."id" = e."actorId"
  WHERE e."workId" = a."workId"
    AND (e."createdAt", e."revision") < (a."createdAt", a."revision")
    AND e_after."type" IN ('COMPLETED', 'CANCELED')
    AND (e_before."type" IS NULL OR e_before."type" NOT IN ('COMPLETED', 'CANCELED'))
  ORDER BY e."createdAt" DESC, e."revision" DESC
  LIMIT 1
) entry ON true
WHERE before_state."type" IN ('COMPLETED', 'CANCELED')
  AND after_state."type" NOT IN ('COMPLETED', 'CANCELED');

UPDATE "Issue" i
SET "reopenCount" = r."count"
FROM (SELECT "workId", COUNT(*)::int AS "count" FROM "WorkReopen" GROUP BY "workId") r
WHERE r."workId" = i."id";

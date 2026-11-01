-- INV-1488: autonomy policy (docs/autonomy-policy.md). Data only; no gate
-- opens until later steps read these rows.
CREATE TYPE "AutonomyScope" AS ENUM ('WORKSPACE', 'TEAM', 'PROJECT');
CREATE TYPE "AgentTrustLevel" AS ENUM ('OBSERVE', 'L1', 'L2', 'L3');

CREATE TABLE "WorkflowPolicy" (
    "id" UUID NOT NULL,
    "scope" "AutonomyScope" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "gates" JSONB NOT NULL DEFAULT '{}',
    "intake" JSONB,
    "locked" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT,
    "observeUntil" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowPolicy_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkflowPolicy_scope_scopeId_active_idx" ON "WorkflowPolicy"("scope", "scopeId", "active");

CREATE TABLE "AgentTrust" (
    "actorId" UUID NOT NULL,
    "level" "AgentTrustLevel" NOT NULL DEFAULT 'OBSERVE',
    "setById" UUID,
    "reason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTrust_pkey" PRIMARY KEY ("actorId")
);
ALTER TABLE "AgentTrust" ADD CONSTRAINT "AgentTrust_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A project that already auto-accepts verified bug fixes (INV-1075) becomes an
-- L2 override whose review_accept gate is limited to Type Bug. The column stays
-- and is still what the bug gate reads; both are written together from now on.
INSERT INTO "WorkflowPolicy" ("id", "scope", "scopeId", "level", "gates", "version", "reason", "active")
SELECT gen_random_uuid(), 'PROJECT', "id", 2,
       '{"review_accept":{"decider":"auto","condition":{"all":[{"field":"type","in":["bug"]},{"field":"auto_accept_grade","eq":"CLEAR"},{"field":"pr_merged","eq":true},{"field":"checks","eq":"green"},{"field":"reproducibility","not_in":["SOMETIMES","ONCE"]},{"field":"severity","not_in":["SEV1","SEV2"]}]}}}'::jsonb,
       1, 'Migrated from autoAcceptBugs (INV-1488)', true
FROM "Issue"
WHERE "kind" = 'PROJECT' AND "autoAcceptBugs" = true;

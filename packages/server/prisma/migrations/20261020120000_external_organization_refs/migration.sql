-- INV-1288: a team may come from an outside organisation (a DingTalk
-- department). The organisation owns the node; the workspace owns the team.
CREATE TABLE "ExternalOrganizationRef" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "teamId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalOrganizationRef_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalOrganizationRef_provider_externalId_key" ON "ExternalOrganizationRef"("provider", "externalId");
CREATE INDEX "ExternalOrganizationRef_teamId_idx" ON "ExternalOrganizationRef"("teamId");

ALTER TABLE "ExternalOrganizationRef" ADD CONSTRAINT "ExternalOrganizationRef_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

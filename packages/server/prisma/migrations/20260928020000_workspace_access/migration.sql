-- INV-847: workspace access. Guests, invites as pending users, and the
-- workspace-wide switches that decide who may sign in and who may invite.
ALTER TYPE "GlobalRole" ADD VALUE 'GUEST';

ALTER TABLE "User" ADD COLUMN "invitedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "invitedById" UUID;
ALTER TABLE "User" ADD CONSTRAINT "User_invitedById_fkey"
  FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One row, id 'workspace'. Absent means the defaults: invite-only sign-in,
-- no approved domains, only admins invite and create teams.
CREATE TABLE "WorkspaceSettings" (
  "id" TEXT NOT NULL,
  "approvedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "defaultTeamIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "membersCanInvite" BOOLEAN NOT NULL DEFAULT false,
  "membersCanCreateTeams" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedById" UUID,
  CONSTRAINT "WorkspaceSettings_pkey" PRIMARY KEY ("id")
);

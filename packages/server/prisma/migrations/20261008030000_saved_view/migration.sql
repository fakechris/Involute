-- INV-1005: saved views live on the server, private or shared with the team.
CREATE TABLE "SavedView" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'PRIVATE',
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SavedView_teamId_visibility_idx" ON "SavedView"("teamId", "visibility");
CREATE INDEX "SavedView_ownerId_idx" ON "SavedView"("ownerId");
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

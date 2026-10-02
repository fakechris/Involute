CREATE TABLE "WorkSearchCursor" (
  "id" UUID NOT NULL,
  "actorKey" TEXT NOT NULL,
  "queryHash" TEXT NOT NULL,
  "seenIds" TEXT[] NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkSearchCursor_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkSearchCursor_expiresAt_idx" ON "WorkSearchCursor"("expiresAt");

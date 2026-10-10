-- INV-1116: key events on the issue timeline. The entry is a reference into the
-- projected timeline (audit / run / evidence / comment); unstarring keeps the row.
CREATE TABLE "WorkTimelineStar" (
    "id" UUID NOT NULL,
    "workId" UUID NOT NULL,
    "entryKey" TEXT NOT NULL,
    "starredById" UUID NOT NULL,
    "starredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unstarredAt" TIMESTAMP(3),
    "unstarredById" UUID,
    CONSTRAINT "WorkTimelineStar_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkTimelineStar_workId_entryKey_idx" ON "WorkTimelineStar"("workId", "entryKey");
-- At most one active star per entry; history rows (unstarred) may repeat.
CREATE UNIQUE INDEX "WorkTimelineStar_active_entry_key" ON "WorkTimelineStar"("workId", "entryKey") WHERE "unstarredAt" IS NULL;
ALTER TABLE "WorkTimelineStar" ADD CONSTRAINT "WorkTimelineStar_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkTimelineStar" ADD CONSTRAINT "WorkTimelineStar_starredById_fkey" FOREIGN KEY ("starredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkTimelineStar" ADD CONSTRAINT "WorkTimelineStar_unstarredById_fkey" FOREIGN KEY ("unstarredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- INV-561 (B4): one work item, several independent comment threads.

ALTER TABLE "Comment" ADD COLUMN IF NOT EXISTS "parentCommentId" UUID;

CREATE INDEX IF NOT EXISTS "Comment_parentCommentId_createdAt_idx"
    ON "Comment"("parentCommentId", "createdAt");

-- Listing thread roots for one work item is the common read.
CREATE INDEX IF NOT EXISTS "Comment_issueId_parentCommentId_createdAt_idx"
    ON "Comment"("issueId", "parentCommentId", "createdAt");

ALTER TABLE "Comment" DROP CONSTRAINT IF EXISTS "Comment_parentCommentId_fkey";
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_parentCommentId_fkey"
    FOREIGN KEY ("parentCommentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- INV-558 (B1): server-side `@handle` -> actorId resolution for comments.

-- Addressable alias for mentions. Nullable: humans and legacy agents keep
-- working without one; only actors with a handle can be mentioned.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "handle" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "User_handle_key" ON "User"("handle");

CREATE TABLE IF NOT EXISTS "CommentMention" (
    "id" UUID NOT NULL,
    "commentId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentMention_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CommentMention_commentId_actorId_key"
    ON "CommentMention"("commentId", "actorId");

CREATE INDEX IF NOT EXISTS "CommentMention_actorId_createdAt_idx"
    ON "CommentMention"("actorId", "createdAt");

ALTER TABLE "CommentMention"
    DROP CONSTRAINT IF EXISTS "CommentMention_commentId_fkey";
ALTER TABLE "CommentMention"
    ADD CONSTRAINT "CommentMention_commentId_fkey"
    FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommentMention"
    DROP CONSTRAINT IF EXISTS "CommentMention_actorId_fkey";
ALTER TABLE "CommentMention"
    ADD CONSTRAINT "CommentMention_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

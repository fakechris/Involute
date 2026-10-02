-- INV-927: semantic search vectors, one per work item and embedding model.
-- Filled in the background by the server (src/embeddings); rebuilt when the
-- embedded text's hash or the model changes.

-- CreateTable
CREATE TABLE "IssueEmbedding" (
    "issueId" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "vector" REAL[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssueEmbedding_pkey" PRIMARY KEY ("issueId","model")
);

-- CreateIndex
CREATE INDEX "IssueEmbedding_model_idx" ON "IssueEmbedding"("model");

-- AddForeignKey
ALTER TABLE "IssueEmbedding" ADD CONSTRAINT "IssueEmbedding_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

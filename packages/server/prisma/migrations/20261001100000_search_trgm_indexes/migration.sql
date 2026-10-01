-- INV-925: free-text search scans title, description and comment bodies with ILIKE;
-- trigram GIN indexes make those scans cheap. Words under three characters still
-- match (by scan), so nothing is dropped.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "Issue_title_trgm_idx" ON "Issue" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Issue_description_trgm_idx" ON "Issue" USING GIN ("description" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Comment_body_trgm_idx" ON "Comment" USING GIN ("body" gin_trgm_ops);

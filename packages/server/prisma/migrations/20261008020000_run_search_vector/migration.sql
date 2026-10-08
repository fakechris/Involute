-- INV-935: run summaries are searchable. Same tokenizer and trigger pattern as
-- INV-926; weight D so a run-only hit ranks below title, contract, description
-- and comment hits.
CREATE OR REPLACE FUNCTION involute_run_search_vector(summary text) RETURNS tsvector
LANGUAGE sql IMMUTABLE AS $$
  SELECT setweight(to_tsvector('simple', involute_search_tokens(summary)), 'D');
$$;

ALTER TABLE "WorkRun" ADD COLUMN "searchVector" tsvector;

CREATE OR REPLACE FUNCTION involute_run_search_vector_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := involute_run_search_vector(NEW.summary);
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WorkRun_searchVector_refresh"
  BEFORE INSERT OR UPDATE OF summary ON "WorkRun"
  FOR EACH ROW EXECUTE FUNCTION involute_run_search_vector_refresh();

-- Backfill (the same statement as `pnpm search:reindex`).
UPDATE "WorkRun" SET "searchVector" = involute_run_search_vector(summary);

CREATE INDEX "WorkRun_searchVector_idx" ON "WorkRun" USING GIN ("searchVector");

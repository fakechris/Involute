-- INV-1117: text attachments (research reports, postmortems, logs) are
-- searchable. storeUpload keeps the extracted, length-capped text in
-- "textContent" (NULL for binaries); the vector follows it through the same
-- tokenizer and trigger pattern as INV-926/935. Weight D: an attachment-only
-- hit ranks with run summaries, below title, contract, description and
-- comments. The row is the index entry, so deleting the attachment removes it.
CREATE OR REPLACE FUNCTION involute_attachment_search_vector(body text) RETURNS tsvector
LANGUAGE sql IMMUTABLE AS $$
  SELECT setweight(to_tsvector('simple', involute_search_tokens(body)), 'D');
$$;

ALTER TABLE "Attachment" ADD COLUMN "textContent" TEXT;
ALTER TABLE "Attachment" ADD COLUMN "searchVector" tsvector;

CREATE OR REPLACE FUNCTION involute_attachment_search_vector_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := involute_attachment_search_vector(NEW."textContent");
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Attachment_searchVector_refresh"
  BEFORE INSERT OR UPDATE OF "textContent" ON "Attachment"
  FOR EACH ROW EXECUTE FUNCTION involute_attachment_search_vector_refresh();

-- Existing uploads have no text yet: their files live on disk, out of reach
-- of SQL. `pnpm search:reindex` reads them and fills "textContent".

CREATE INDEX "Attachment_searchVector_idx" ON "Attachment" USING GIN ("searchVector");

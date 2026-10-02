-- INV-926: ranked full-text search that works for Chinese without a dictionary.
--
-- Postgres' `simple` parser keeps a run of CJK characters as one word, so
-- 「候选队列的审批」 would only match itself. involute_search_tokens() is the
-- one place documents are tokenized: other text is left for the `simple`
-- parser (hyphens read as spaces), and every CJK run is spelled out as its
-- characters and adjacent pairs, in order. The query side (src/search-tokens.ts) compiles a CJK word
-- into those pairs, each two positions apart: 候选队列 → 候选 <2> 选队 <2> 队列.
-- CJK here means kana and CJK ideographs (U+3040–30FF, U+3400–9FFF, U+F900–FAFF).
-- To move to a dictionary segmenter later, replace this function and that
-- compiler together, then run `pnpm search:reindex`.
CREATE OR REPLACE FUNCTION involute_search_tokens(input text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  run text;
  pieces text := '';
  position integer;
BEGIN
  IF input IS NULL THEN
    RETURN '';
  END IF;
  FOR run IN
    SELECT match[1] FROM regexp_matches(input, '([\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+)', 'g') AS match
  LOOP
    FOR position IN 1..char_length(run) LOOP
      pieces := pieces || ' ' || substr(run, position, 1);
      IF position < char_length(run) THEN
        pieces := pieces || ' ' || substr(run, position, 2);
      END IF;
    END LOOP;
  END LOOP;
  -- Hyphens become spaces: the parser would read INV-859 as `inv` and the
  -- number `-859`, while a query splits it into `inv` and `859`.
  RETURN regexp_replace(
    regexp_replace(input, '[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+', ' ', 'g'),
    '-', ' ', 'g'
  ) || pieces;
END;
$$;

-- Title A, contract fields B, description C (comments are C on their own row).
CREATE OR REPLACE FUNCTION involute_issue_search_vector(
  title text, outcome text, scope text, constraints text, acceptance text, verification text, description text
) RETURNS tsvector
LANGUAGE sql IMMUTABLE AS $$
  SELECT setweight(to_tsvector('simple', involute_search_tokens(title)), 'A')
    || setweight(to_tsvector('simple', involute_search_tokens(concat_ws(' ', outcome, scope, constraints, acceptance, verification))), 'B')
    || setweight(to_tsvector('simple', involute_search_tokens(description)), 'C');
$$;

CREATE OR REPLACE FUNCTION involute_comment_search_vector(body text) RETURNS tsvector
LANGUAGE sql IMMUTABLE AS $$
  SELECT setweight(to_tsvector('simple', involute_search_tokens(body)), 'C');
$$;

-- AlterTable
ALTER TABLE "Issue" ADD COLUMN "searchVector" tsvector;
ALTER TABLE "Comment" ADD COLUMN "searchVector" tsvector;

-- The database keeps the vectors current, whatever path writes the text.
CREATE OR REPLACE FUNCTION involute_issue_search_vector_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := involute_issue_search_vector(
    NEW.title, NEW.outcome, NEW.scope, NEW.constraints, NEW.acceptance, NEW.verification, NEW.description
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION involute_comment_search_vector_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := involute_comment_search_vector(NEW.body);
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Issue_searchVector_refresh"
  BEFORE INSERT OR UPDATE OF title, outcome, scope, constraints, acceptance, verification, description ON "Issue"
  FOR EACH ROW EXECUTE FUNCTION involute_issue_search_vector_refresh();

CREATE TRIGGER "Comment_searchVector_refresh"
  BEFORE INSERT OR UPDATE OF body ON "Comment"
  FOR EACH ROW EXECUTE FUNCTION involute_comment_search_vector_refresh();

-- Backfill (the same statements as `pnpm search:reindex`).
UPDATE "Issue" SET "searchVector" = involute_issue_search_vector(
  title, outcome, scope, constraints, acceptance, verification, description
);
UPDATE "Comment" SET "searchVector" = involute_comment_search_vector(body);

-- CreateIndex
CREATE INDEX "Issue_searchVector_idx" ON "Issue" USING GIN ("searchVector");

-- CreateIndex
CREATE INDEX "Comment_searchVector_idx" ON "Comment" USING GIN ("searchVector");

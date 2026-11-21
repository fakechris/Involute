-- INV-2005: a task merged into a delivery package gets its own marker.
--
-- Lists used to hide any item that had `supersededById` and an outgoing
-- DUPLICATE_OF link (INV-1526). People and agents write DUPLICATE_OF too
-- (work_relate, proposals with related_work_type DUPLICATE_OF), so an ordinary
-- duplicate that was also marked superseded vanished from the board, Backlog
-- and search, and nobody could select it to close it. From now on only the
-- approved delivery change that merges a task sets `deliveryMergedAt`, and
-- lists hide by that column alone.
--
-- Additive and idempotent: the column is nullable, and the backfill only fills
-- rows that are still NULL.
ALTER TABLE "Issue" ADD COLUMN IF NOT EXISTS "deliveryMergedAt" TIMESTAMP(3);

-- Backfill from the record of the merge itself: every APPLIED delivery change
-- set lists its merge sources (resolved to UUIDs when it was proposed). A source
-- still superseded by that change's root is a merge source and stays hidden; one
-- a person has since pointed elsewhere or cleared is not.
UPDATE "Issue" AS i
SET "deliveryMergedAt" = COALESCE(dcs."decidedAt", dcs."createdAt")
FROM "DeliveryChangeSet" AS dcs
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(dcs."changes"->'mergeSourceIds') = 'array' THEN dcs."changes"->'mergeSourceIds' ELSE '[]'::jsonb END
) AS src(id)
WHERE dcs."status" = 'APPLIED'
  AND i."id"::text = src.id
  AND i."supersededById" = dcs."workId"
  AND i."deliveryMergedAt" IS NULL;

-- Step 1: Move issue associations from duplicate labels to the keeper (earliest id per name)
INSERT INTO "_IssueToIssueLabel" ("A", "B")
SELECT DISTINCT dup_assoc."A", keepers.keeper_id
FROM "_IssueToIssueLabel" dup_assoc
JOIN "IssueLabel" dup ON dup.id = dup_assoc."B"
JOIN (
  SELECT name, (MIN(id::text))::uuid AS keeper_id
  FROM "IssueLabel"
  GROUP BY name
  HAVING COUNT(*) > 1
) keepers ON keepers.name = dup.name AND dup.id != keepers.keeper_id
WHERE NOT EXISTS (
  SELECT 1 FROM "_IssueToIssueLabel" existing
  WHERE existing."A" = dup_assoc."A" AND existing."B" = keepers.keeper_id
);

-- Step 2: Remove associations pointing to duplicate (non-keeper) labels
DELETE FROM "_IssueToIssueLabel"
WHERE "B" IN (
  SELECT dup.id
  FROM "IssueLabel" dup
  JOIN (
    SELECT name, (MIN(id::text))::uuid AS keeper_id
    FROM "IssueLabel"
    GROUP BY name
    HAVING COUNT(*) > 1
  ) keepers ON keepers.name = dup.name AND dup.id != keepers.keeper_id
);

-- Step 3: Delete duplicate labels (keep the earliest id per name)
DELETE FROM "IssueLabel"
WHERE id IN (
  SELECT dup.id
  FROM "IssueLabel" dup
  JOIN (
    SELECT name, (MIN(id::text))::uuid AS keeper_id
    FROM "IssueLabel"
    GROUP BY name
    HAVING COUNT(*) > 1
  ) keepers ON keepers.name = dup.name AND dup.id != keepers.keeper_id
);

-- Step 4: Add unique constraint on name
ALTER TABLE "IssueLabel" ADD CONSTRAINT "IssueLabel_name_key" UNIQUE ("name");

-- Step 5: Drop the now-redundant index (unique constraint already creates one)
DROP INDEX IF EXISTS "IssueLabel_name_idx";

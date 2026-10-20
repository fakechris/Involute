-- INV-1288: make the identity table the single source of truth.
--
-- Every account that signed in through Google before the identity table
-- existed has a `googleSubject` and no identity row. Copy those rows across
-- so the workspace can answer "has this person ever signed in?" from one
-- place, whichever sign-in line they used.
--
-- The legacy column stays: code outside the provider layer still reads it, and
-- the Google provider still writes it. This migration only makes the two
-- agree.
--
-- `ON CONFLICT DO NOTHING` because the column is unique, so a row may already
-- exist for a subject that signed in again since the table was created.
INSERT INTO "UserIdentity" ("id", "provider", "subject", "userId", "createdAt")
SELECT gen_random_uuid(), 'google', "googleSubject", "id", CURRENT_TIMESTAMP
FROM "User"
WHERE "googleSubject" IS NOT NULL
ON CONFLICT ("provider", "subject") DO NOTHING;

-- INV-1929: keep the scope history of deleted work after its undo tombstone expires.
CREATE TABLE "WorkDeletion" (
    "id" UUID NOT NULL,
    "workId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "repository" TEXT,
    "parentIds" UUID[],
    "audits" JSONB NOT NULL,
    "final" JSONB NOT NULL,
    "revision" INTEGER NOT NULL,
    "actorKind" "ActorKind" NOT NULL,
    "actorId" UUID,
    "surface" TEXT,
    "reason" TEXT,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoredAt" TIMESTAMP(3),

    CONSTRAINT "WorkDeletion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkDeletion_workId_idx" ON "WorkDeletion"("workId");
CREATE INDEX "WorkDeletion_teamId_deletedAt_idx" ON "WorkDeletion"("teamId", "deletedAt");
CREATE INDEX "WorkDeletion_parentIds_idx" ON "WorkDeletion" USING GIN ("parentIds");

ALTER TABLE "WorkDeletion" ADD CONSTRAINT "WorkDeletion_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deletions still inside the undo window (INV-840) carry their full audit
-- trail; keep its scope fields. Older deletions left nothing to recover and
-- burndown reports them as gaps where a surviving child still names them.
INSERT INTO "WorkDeletion" ("id", "workId", "teamId", "identifier", "repository", "parentIds", "audits", "final", "revision", "actorKind", "actorId", "surface", "reason", "deletedAt")
SELECT
    gen_random_uuid(),
    t."id",
    t."teamId",
    t."identifier",
    t."snapshot"->'issue'->>'repository',
    COALESCE((
        SELECT array_agg(DISTINCT p.value::uuid)
        FROM jsonb_array_elements(t."snapshot"->'audits') a
        CROSS JOIN LATERAL (VALUES (a->'before'->>'parentId'), (a->'after'->>'parentId'), (t."snapshot"->'issue'->>'parentId')) p(value)
        WHERE p.value IS NOT NULL
    ), CASE WHEN t."snapshot"->'issue'->>'parentId' IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[(t."snapshot"->'issue'->>'parentId')::uuid] END),
    COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'id', a->'id',
            'revision', a->'revision',
            'createdAt', a->'createdAt',
            'before', CASE WHEN jsonb_typeof(a->'before') = 'object' THEN jsonb_build_object(
                'parentId', a->'before'->'parentId', 'commitmentStatus', a->'before'->'commitmentStatus',
                'stateId', a->'before'->'stateId', 'kind', a->'before'->'kind') ELSE 'null'::jsonb END,
            'after', jsonb_build_object(
                'parentId', a->'after'->'parentId', 'commitmentStatus', a->'after'->'commitmentStatus',
                'stateId', a->'after'->'stateId', 'kind', a->'after'->'kind'),
            'surface', a->'surface',
            'actorKind', a->'actorKind',
            'actorId', a->'actorId',
            'reason', a->'reason'
        ) ORDER BY (a->>'revision')::int, a->>'createdAt')
        FROM jsonb_array_elements(t."snapshot"->'audits') a
    ), '[]'::jsonb),
    jsonb_build_object(
        'parentId', t."snapshot"->'issue'->'parentId', 'commitmentStatus', t."snapshot"->'issue'->'commitmentStatus',
        'stateId', t."snapshot"->'issue'->'stateId', 'kind', t."snapshot"->'issue'->'kind'),
    COALESCE((t."snapshot"->'issue'->>'revision')::int, 0),
    CASE WHEN EXISTS (SELECT 1 FROM "User" u WHERE u."id" = t."deletedById" AND u."actorKind" = 'AGENT') THEN 'AGENT'::"ActorKind"
         WHEN t."deletedById" IS NULL THEN 'SERVICE'::"ActorKind"
         ELSE 'HUMAN'::"ActorKind" END,
    t."deletedById",
    NULL,
    NULL,
    t."deletedAt"
FROM "WorkTombstone" t
WHERE NOT EXISTS (SELECT 1 FROM "Issue" i WHERE i."id" = t."id")
  AND EXISTS (SELECT 1 FROM "Team" tm WHERE tm."id" = t."teamId");

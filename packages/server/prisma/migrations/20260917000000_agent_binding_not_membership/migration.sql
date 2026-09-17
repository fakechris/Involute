-- INV-592: an agent's team access is its credential's binding, not a membership.
--
-- 1. Any live agent credential without a team binding inherits the team the
--    agent was (wrongly) enrolled in. Nothing loses access here.
UPDATE "AgentCredential" c
SET "teamId" = m."teamId"
FROM "TeamMembership" m
JOIN "User" u ON u.id = m."userId"
WHERE c."userId" = u.id
  AND c."teamId" IS NULL
  AND c."revokedAt" IS NULL
  AND u."actorKind" IN ('AGENT', 'SERVICE');

-- 2. Agents and services come off the human roster. Their identity, history,
--    credentials and owner are untouched; only the fake EDITOR role goes.
DELETE FROM "TeamMembership" m
USING "User" u
WHERE m."userId" = u.id
  AND u."actorKind" IN ('AGENT', 'SERVICE');

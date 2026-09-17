-- INV-594: fail closed before agent_binding_not_membership.
--
-- That migration binds an unbound live credential to "the" team the agent was
-- enrolled in, then removes the agent from every roster. When one unbound
-- credential faces more than one membership there is no "the": a token cannot
-- be split across teams (tokenHash is unique and the plaintext is with the
-- consumer), and guessing one team silently drops access to the others.
-- So: refuse, list the cases, and let an operator issue one credential per
-- team and move the consumers first.
--
-- On an installation that already ran the binding migration this finds
-- nothing (the rosters are empty) and is a no-op.
DO $$
DECLARE
  ambiguous text;
BEGIN
  SELECT string_agg(
    format('actor=%s credential=%s teams=%s', u.id, c.id, t.keys), E'\n')
  INTO ambiguous
  FROM "AgentCredential" c
  JOIN "User" u ON u.id = c."userId"
  JOIN LATERAL (
    SELECT string_agg(tm.key, ',') AS keys, count(*) AS n
    FROM "TeamMembership" m JOIN "Team" tm ON tm.id = m."teamId"
    WHERE m."userId" = u.id
  ) t ON true
  WHERE c."teamId" IS NULL
    AND c."revokedAt" IS NULL
    AND u."actorKind" IN ('AGENT', 'SERVICE')
    AND t.n > 1;

  IF ambiguous IS NOT NULL THEN
    RAISE EXCEPTION E'agent_binding_precheck: an unbound live credential belongs to an agent on more than one team. Issue one credential per team and migrate the consumers, then rerun.\n%', ambiguous;
  END IF;
END $$;

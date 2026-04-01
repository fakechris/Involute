import type { PrismaClient } from '@prisma/client';

const CREATE_IDENTIFIER_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION assign_issue_identifier()
RETURNS TRIGGER
AS $$
DECLARE
  team_key TEXT;
  next_issue_number INTEGER;
  provided_issue_number INTEGER;
BEGIN
  SELECT key INTO team_key
  FROM "Team"
  WHERE id = NEW."teamId";

  IF team_key IS NULL THEN
    RAISE EXCEPTION 'Team % not found for issue identifier generation', NEW."teamId";
  END IF;

  IF NEW.identifier IS NULL OR NEW.identifier = '' THEN
    UPDATE "Team"
    SET "nextIssueNumber" = "nextIssueNumber" + 1
    WHERE id = NEW."teamId"
    RETURNING "nextIssueNumber" - 1 INTO next_issue_number;

    NEW.identifier := UPPER(team_key) || '-' || next_issue_number;
  ELSIF NEW.identifier ~ '^[A-Z]+-[0-9]+$' AND split_part(NEW.identifier, '-', 1) = UPPER(team_key) THEN
    provided_issue_number := split_part(NEW.identifier, '-', 2)::INTEGER + 1;

    UPDATE "Team"
    SET "nextIssueNumber" = GREATEST("nextIssueNumber", provided_issue_number)
    WHERE id = NEW."teamId";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`;

const DROP_IDENTIFIER_TRIGGER_SQL = `
DROP TRIGGER IF EXISTS assign_issue_identifier_before_insert ON "Issue";
`;

const CREATE_IDENTIFIER_TRIGGER_SQL = `
CREATE TRIGGER assign_issue_identifier_before_insert
BEFORE INSERT ON "Issue"
FOR EACH ROW
EXECUTE FUNCTION assign_issue_identifier();
`;

export async function ensureIssueIdentifierAutomation(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(CREATE_IDENTIFIER_FUNCTION_SQL);
  await prisma.$executeRawUnsafe(DROP_IDENTIFIER_TRIGGER_SQL);
  await prisma.$executeRawUnsafe(CREATE_IDENTIFIER_TRIGGER_SQL);
}

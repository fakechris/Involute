import { Prisma, type PrismaClient, type WorkflowStateType } from '@prisma/client';

import { AUTO_ACCEPT_ACTOR_EMAIL } from './auto-accept-gate.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

const TERMINAL: ReadonlySet<WorkflowStateType> = new Set(['COMPLETED', 'CANCELED']);

/** A move out of Done / Canceled into an open state is a reopen (INV-1120). */
export function isReopen(from: WorkflowStateType, to: WorkflowStateType): boolean {
  return TERMINAL.has(from) && !TERMINAL.has(to);
}

/**
 * Records a reopen for the audit row `auditId` when it moved the work from a
 * terminal state to an open one (INV-1120): a WorkReopen row and one more on
 * the work's `reopenCount`. Called by the audit writer, so every surface that
 * reopens work — the issue page, MCP, undo, revoking an auto-acceptance — is
 * counted the same way. Returns whether it was a reopen.
 */
export async function recordReopenIfAny(
  db: DatabaseClient,
  input: { workId: string; auditId: string; fromStateId: string; toStateId: string },
): Promise<boolean> {
  const states = await db.workflowState.findMany({
    where: { id: { in: [input.fromStateId, input.toStateId] } },
    select: { id: true, type: true },
  });
  const from = states.find((state) => state.id === input.fromStateId)?.type;
  const to = states.find((state) => state.id === input.toStateId)?.type;
  if (!from || !to || !isReopen(from, to)) return false;

  await db.workReopen.create({
    data: {
      workId: input.workId,
      auditId: input.auditId,
      fromStateType: from,
      toStateType: to,
      afterAutoAccept: await enteredByAutoAcceptGate(db, input),
    },
  });
  await db.issue.update({ where: { id: input.workId }, data: { reopenCount: { increment: 1 } } });
  return true;
}

/**
 * Whether the closed spell the work is leaving was entered by the Auto-Accept
 * Gate. The spell starts at the latest audit that moved the work from an open
 * state (or from nothing, at creation) into Done / Canceled; later Done ↔
 * Canceled moves stay inside the spell and do not change who entered it. The
 * migration backfills historical reopens with the same rule.
 */
async function enteredByAutoAcceptGate(
  db: DatabaseClient,
  input: { workId: string; auditId: string },
): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ email: string | null }>>(Prisma.sql`
    SELECT u."email"
    FROM "WorkAudit" a
    JOIN "WorkflowState" after_state ON after_state."id"::text = a."after"->>'stateId'
    LEFT JOIN "WorkflowState" before_state ON before_state."id"::text = a."before"->>'stateId'
    LEFT JOIN "User" u ON u."id" = a."actorId"
    WHERE a."workId" = ${input.workId}::uuid
      AND a."id" <> ${input.auditId}::uuid
      AND after_state."type" IN ('COMPLETED', 'CANCELED')
      AND (before_state."type" IS NULL OR before_state."type" NOT IN ('COMPLETED', 'CANCELED'))
    ORDER BY a."createdAt" DESC, a."revision" DESC
    LIMIT 1`);
  return rows[0]?.email === AUTO_ACCEPT_ACTOR_EMAIL;
}

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

/** Whether the audit that moved the work into the state it is leaving was the Auto-Accept Gate's. */
async function enteredByAutoAcceptGate(
  db: DatabaseClient,
  input: { workId: string; auditId: string; fromStateId: string },
): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ email: string | null }>>(Prisma.sql`
    SELECT u."email"
    FROM "WorkAudit" a
    LEFT JOIN "User" u ON u."id" = a."actorId"
    WHERE a."workId" = ${input.workId}::uuid
      AND a."id" <> ${input.auditId}::uuid
      AND a."after"->>'stateId' = ${input.fromStateId}
      AND (a."before" IS NULL OR a."before"->>'stateId' IS DISTINCT FROM ${input.fromStateId})
    ORDER BY a."createdAt" DESC, a."revision" DESC
    LIMIT 1`);
  return rows[0]?.email === AUTO_ACCEPT_ACTOR_EMAIL;
}

import type { Prisma, PrismaClient, WorkRun } from '@prisma/client';

import { buildReadableIssueWhere } from './access-control.js';
import type { GraphQLContext } from './auth.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { resolveShareScope } from './project-sharing.js';

/**
 * Whether an execution still looks alive (INV-996). The same question INV-562
 * answers for a request — 'will it reply' — asked of a run: a run is `live`
 * while its executor keeps writing (run_report phases, evidence on the run,
 * comments by its actor), `stale` once nothing has been written for
 * RUN_STALE_AFTER_MS (default 30 minutes, like Linear's agent sessions),
 * `waiting` while queued or blocked, and `settled` once it ended. Derived from
 * lastActivityAt, never stored.
 */
export type RunPresence = 'waiting' | 'live' | 'stale' | 'settled';

const OPEN_NOT_RUNNING = new Set(['QUEUED', 'BLOCKED']);

export const DEFAULT_RUN_STALE_AFTER_MS = 30 * 60_000;

export function runStaleAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.RUN_STALE_AFTER_MS);
  return Number.isFinite(configured) && configured >= 60_000 ? configured : DEFAULT_RUN_STALE_AFTER_MS;
}

export function runPresence(run: Pick<WorkRun, 'status' | 'lastActivityAt'>, now = new Date(), staleAfterMs = runStaleAfterMs()): RunPresence {
  // Queued or blocked runs are open but not expected to write: waiting, not settled.
  if (OPEN_NOT_RUNNING.has(run.status)) return 'waiting';
  if (run.status !== 'RUNNING') return 'settled';
  return now.getTime() - run.lastActivityAt.getTime() >= staleAfterMs ? 'stale' : 'live';
}

/**
 * Tells the work's owner and the executor's owner once per quiet spell that a
 * run went silent: `run.stale` to the outbox and their inboxes. Activity on
 * the run clears staleNotifiedAt, so a second silence is reported again.
 */
export async function sweepStaleRuns(prisma: PrismaClient, now = new Date(), staleAfterMs = runStaleAfterMs()): Promise<number> {
  const quiet = await prisma.workRun.findMany({
    where: { status: 'RUNNING', staleNotifiedAt: null, lastActivityAt: { lte: new Date(now.getTime() - staleAfterMs) }, work: { commitmentStatus: 'COMMITTED' } },
    select: { id: true },
    orderBy: { lastActivityAt: 'asc' },
    take: 100,
  });
  let notified = 0;
  for (const { id } of quiet) {
    notified += await prisma.$transaction(async (tx) => {
      const run = await tx.workRun.findUnique({ where: { id }, include: { work: true } });
      // Written to, ended or already reported since the sweep looked: not ours.
      if (!run || run.status !== 'RUNNING' || run.staleNotifiedAt || now.getTime() - run.lastActivityAt.getTime() < staleAfterMs) return 0;
      const silentMinutes = Math.round((now.getTime() - run.lastActivityAt.getTime()) / 60_000);
      await tx.workRun.update({ where: { id: run.id }, data: { staleNotifiedAt: now } });
      const payload = { runId: run.id, publicId: run.publicId, actorId: run.actorId, lastActivityAt: run.lastActivityAt.toISOString(), silentMinutes, phase: run.phase, identifier: run.work.identifier, title: run.work.title };
      const event = await enqueueWorkEvent(tx, { payload, type: 'run.stale', workId: run.work.id, workIdentifier: run.work.identifier });
      const executor = run.actorId ? await tx.user.findUnique({ where: { id: run.actorId }, select: { ownerId: true } }) : null;
      const candidates = [...new Set([run.work.assigneeId, executor?.ownerId].filter((userId): userId is string => Boolean(userId)))];
      const recipients = await readersOf(tx, run.work.id, candidates);
      if (recipients.length) {
        await tx.notification.createMany({
          data: recipients.map((userId) => ({ payload, sourceEventId: event.id, teamId: run.work.teamId, type: 'run.stale', userId, workId: run.work.id })),
          skipDuplicates: true,
        });
      }
      return 1;
    });
  }
  return notified;
}

/**
 * The note names the work, its title and the run's phase, so only people who
 * may read the work get it (INV-1195): the same rules as the board — admin,
 * team membership or PUBLIC team, or a project shared with them; deactivated
 * accounts get nothing. Being the assignee or the executor's owner grants
 * nothing by itself.
 */
async function readersOf(tx: Prisma.TransactionClient, workId: string, userIds: string[]): Promise<string[]> {
  const readers: string[] = [];
  for (const userId of userIds) {
    const viewer = await tx.user.findUnique({ where: { id: userId } });
    // A deactivated account is told nothing, like every other notification path.
    if (!viewer || viewer.deactivatedAt) continue;
    const context: GraphQLContext = {
      authMode: 'session',
      isTrustedSystem: false,
      prisma: tx as PrismaClient,
      shareScope: await resolveShareScope(tx, viewer.id),
      viewer,
    };
    const readable = await tx.issue.findFirst({ where: { AND: [{ id: workId }, buildReadableIssueWhere(context) ?? {}] }, select: { id: true } });
    if (readable) readers.push(userId);
  }
  return readers;
}

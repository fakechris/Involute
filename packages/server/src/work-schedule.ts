import type { Prisma, PrismaClient, WorkSchedule } from '@prisma/client';

import { enqueueWorkEvent } from './inv11-hooks.js';
import { createNotFoundError, createValidationError } from './errors.js';
import { resolveActorRef } from './need-info-service.js';
import type { DatabaseClient } from './run-service-shared.js';
import { CRON_FORMAT_MESSAGE, CRON_TIMEZONE_MESSAGE, isValidTimeZone, nextMatch, parseCron } from './work-schedule-cron.js';

/**
 * Scheduled rounds of work (INV-1582).
 *
 * A check that repeats — a daily patrol, a weekly refresh — used to be a new
 * item every time, or a cron on the agent's own machine with no record here.
 * A schedule sits on one committed item: five cron fields in a time zone and
 * the agent that runs it. When a round is due, Involute tells that agent (an
 * inbox notification, which its push channel delivers) and emits
 * `work.scheduled_run`; the agent claims the item, does the round and reports
 * it as a run with `schedule_round`, which never moves the work's state.
 *
 * Involute keeps time and the record; it does not run the agent (INV-478).
 * A person sets, pauses and removes the schedule. Rounds that fire without a
 * run before the next one count as missed; after SCHEDULE_MISSED_THRESHOLD in
 * a row the item waits in Needs you until a round runs or the schedule is
 * paused.
 */

export const SCHEDULE_MISSED_THRESHOLD = 3;
export const SCHEDULE_WORK_NOT_COMMITTED_MESSAGE = 'A schedule sits on committed work.';
export const SCHEDULE_AGENT_MESSAGE = 'The executor is an agent with a credential on this team: give its handle (@name) or actor id.';
export const SCHEDULE_ROUND_MESSAGE = 'schedule_round names a round this item has fired: 1 to the current round.';
export const SCHEDULE_ROUND_NO_SCHEDULE_MESSAGE = 'This item has no schedule, so a report cannot be a scheduled round.';

export interface SetWorkScheduleInput {
  workId: string;
  cron: string;
  timezone: string;
  /** Agent handle (@name) or actor id. */
  agent: string;
  active?: boolean | null | undefined;
}

/** Creates or replaces the schedule on an item; the next round is computed from now. */
export async function setWorkSchedule(prisma: DatabaseClient, input: SetWorkScheduleInput, byId: string | null, now = new Date()): Promise<WorkSchedule> {
  const work = await prisma.issue.findUnique({ where: { id: input.workId }, select: { id: true, teamId: true, commitmentStatus: true } });
  if (!work) throw createNotFoundError('Work not found.');
  if (work.commitmentStatus !== 'COMMITTED') throw createValidationError(SCHEDULE_WORK_NOT_COMMITTED_MESSAGE);
  const cron = input.cron.trim();
  try {
    parseCron(cron);
  } catch {
    throw createValidationError(CRON_FORMAT_MESSAGE);
  }
  const timezone = input.timezone.trim();
  if (!timezone || !isValidTimeZone(timezone)) throw createValidationError(CRON_TIMEZONE_MESSAGE);
  const agent = await resolveActorRef(prisma, input.agent.trim());
  if (!agent || agent.actorKind !== 'AGENT') throw createValidationError(SCHEDULE_AGENT_MESSAGE);
  const credential = await prisma.agentCredential.findFirst({ where: { userId: agent.id, teamId: work.teamId, revokedAt: null }, select: { id: true } });
  if (!credential) throw createValidationError(SCHEDULE_AGENT_MESSAGE);
  const active = input.active ?? true;
  const nextRunAt = active ? nextMatch(cron, timezone, now) : null;
  return prisma.workSchedule.upsert({
    where: { workId: work.id },
    create: { workId: work.id, cron, timezone, agentId: agent.id, active, nextRunAt, createdById: byId },
    update: { cron, timezone, agentId: agent.id, active, nextRunAt },
  });
}

export async function clearWorkSchedule(prisma: DatabaseClient, workId: string): Promise<boolean> {
  const removed = await prisma.workSchedule.deleteMany({ where: { workId } });
  return removed.count > 0;
}

/** Pausing keeps the schedule and its history; nothing fires until it is resumed. */
export async function setWorkScheduleActive(prisma: DatabaseClient, workId: string, active: boolean, now = new Date()): Promise<WorkSchedule> {
  const schedule = await prisma.workSchedule.findUnique({ where: { workId } });
  if (!schedule) throw createNotFoundError('This item has no schedule.');
  return prisma.workSchedule.update({
    where: { id: schedule.id },
    data: { active, nextRunAt: active ? nextMatch(schedule.cron, schedule.timezone, now) : null, ...(active ? {} : {}) },
  });
}

/**
 * Fires every due round, once: the round counter and nextRunAt advance in the
 * same transaction as the notification, so a tick that runs twice (two server
 * processes, a retry) cannot tell the agent twice.
 */
export async function fireDueSchedules(prisma: PrismaClient, now = new Date()): Promise<number> {
  const due = await prisma.workSchedule.findMany({ where: { active: true, nextRunAt: { lte: now } }, select: { id: true } });
  let fired = 0;
  for (const { id } of due) {
    const didFire = await prisma.$transaction(async (tx) => {
      const schedule = await tx.workSchedule.findUnique({ where: { id }, include: { work: { select: { id: true, identifier: true, teamId: true, title: true } } } });
      if (!schedule || !schedule.active || !schedule.nextRunAt || schedule.nextRunAt > now) return false;
      // Did the last round get a run before this one came due?
      const lastRan = schedule.round === 0 ? true : (await tx.workRun.count({ where: { workId: schedule.workId, scheduleRound: schedule.round } })) > 0;
      const round = schedule.round + 1;
      const missedRounds = lastRan ? 0 : schedule.missedRounds + 1;
      const advanced = await tx.workSchedule.updateMany({
        where: { id, round: schedule.round },
        data: { round, missedRounds, lastFiredAt: now, nextRunAt: nextMatch(schedule.cron, schedule.timezone, now) },
      });
      if (advanced.count !== 1) return false;
      const payload: Prisma.InputJsonValue = { round, cron: schedule.cron, timezone: schedule.timezone, missedRounds, agentId: schedule.agentId };
      const event = await enqueueWorkEvent(tx, { payload, type: 'work.scheduled_run', workId: schedule.workId, workIdentifier: schedule.work.identifier });
      // The agent hears it in agent_inbox; its push channel delivers what reaches the inbox (INV-992).
      await tx.notification.createMany({
        data: [{ payload, sourceEventId: event.id, teamId: schedule.work.teamId, type: 'work.scheduled_run', userId: schedule.agentId, workId: schedule.workId }],
        skipDuplicates: true,
      });
      return true;
    });
    if (didFire) fired += 1;
  }
  return fired;
}

/** Checks a run report's schedule_round against the item's schedule. */
export async function assertScheduleRound(prisma: DatabaseClient, workId: string, round: number): Promise<void> {
  const schedule = await prisma.workSchedule.findUnique({ where: { workId }, select: { round: true } });
  if (!schedule) throw createValidationError(SCHEDULE_ROUND_NO_SCHEDULE_MESSAGE);
  if (!Number.isInteger(round) || round < 1 || round > schedule.round) throw createValidationError(SCHEDULE_ROUND_MESSAGE);
}

/** Schedules whose rounds keep firing with nobody running them (Needs you). */
export async function missedSchedules(prisma: DatabaseClient, where: Prisma.IssueWhereInput): Promise<Array<WorkSchedule & { work: { id: string; identifier: string; title: string } }>> {
  return prisma.workSchedule.findMany({
    where: { active: true, missedRounds: { gte: SCHEDULE_MISSED_THRESHOLD }, work: where },
    include: { work: { select: { id: true, identifier: true, title: true } } },
    orderBy: { lastFiredAt: 'asc' },
  });
}

import type { Issue, PrismaClient, Team, User } from '@prisma/client';
import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { issueAgentCredential } from './agent-credentials.ts';
import { loadAttention } from './attention-service.ts';
import { claimWork } from './claim-service.ts';
import { createIssue } from './issue-service.ts';
import { reportRun } from './run-service-report.ts';
import { testParentId } from './test-placement.ts';
import { writeActorFromViewer } from './work-service.ts';
import { CRON_FORMAT_MESSAGE, CRON_TIMEZONE_MESSAGE, nextMatch, parseCron } from './work-schedule-cron.ts';
import { SCHEDULE_AGENT_MESSAGE, SCHEDULE_ROUND_MESSAGE, SCHEDULE_ROUND_NO_SCHEDULE_MESSAGE, clearWorkSchedule, fireDueSchedules, setWorkSchedule, setWorkScheduleActive } from './work-schedule.ts';

// INV-1582: rounds of work on a clock.
loadProjectEnvironment();
const prisma: PrismaClient = new PrismaClientConstructor();

describe('the cron clock', () => {
  it('finds the next matching minute in the schedule\'s zone', () => {
    // 09:00 Shanghai on weekdays, asked on a Friday evening Shanghai time → Monday 09:00 = Monday 01:00 UTC.
    const next = nextMatch('0 9 * * 1-5', 'Asia/Shanghai', new Date('2026-11-06T13:00:00Z'));
    expect(next?.toISOString()).toBe('2026-11-09T01:00:00.000Z');
    // Every 15 minutes, UTC.
    expect(nextMatch('*/15 * * * *', 'UTC', new Date('2026-11-06T13:07:00Z'))?.toISOString()).toBe('2026-11-06T13:15:00.000Z');
    // The 1st of a month at 00:30 New York.
    expect(nextMatch('30 0 1 * *', 'America/New_York', new Date('2026-11-06T13:07:00Z'))?.toISOString()).toBe('2026-12-01T05:30:00.000Z');
    // Sunday as 7.
    expect(parseCron('0 0 * * 7').dayOfWeek).toEqual(new Set([0]));
    expect(() => parseCron('0 9 * *')).toThrow(CRON_FORMAT_MESSAGE);
    expect(() => parseCron('60 9 * * *')).toThrow(CRON_FORMAT_MESSAGE);
  });
});

describe('work schedules (INV-1582)', () => {
  let team: Team;
  let human: User;
  let agent: User;
  let work: Issue;

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    await prisma.teamMembership.upsert({ where: { teamId_userId: { teamId: team.id, userId: human.id } }, update: {}, create: { role: 'OWNER', teamId: team.id, userId: human.id } });
    const issued = await issueAgentCredential(prisma, { email: 'patrol@agents.involute.local', name: 'Patrol', handle: 'patrol', ownerId: human.id, teamKey: team.key, scopes: ['read', 'propose', 'claim', 'report'], issuedById: human.id });
    agent = await prisma.user.findUniqueOrThrow({ where: { id: issued.credential.userId } });
    const progress = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'STARTED' } });
    work = await createIssue(prisma, { teamId: team.id, title: 'Daily patrol', parentId: await testParentId(prisma, team.id, 'fakechris/Involute'), repository: 'fakechris/Involute', acceptance: 'Each round reports what it checked.', commitmentStatus: 'COMMITTED', stateId: progress.id, assigneeId: human.id }, writeActorFromViewer(human, 'test'));
  });

  it('sets a schedule on committed work for an agent on the team, and refuses bad clocks, zones and executors', async () => {
    const now = new Date('2026-11-06T13:07:00Z');
    const schedule = await setWorkSchedule(prisma, { workId: work.id, cron: '0 9 * * *', timezone: 'Asia/Shanghai', agent: '@patrol' }, human.id, now);
    expect(schedule).toMatchObject({ workId: work.id, agentId: agent.id, active: true, round: 0, missedRounds: 0 });
    expect(schedule.nextRunAt?.toISOString()).toBe('2026-11-07T01:00:00.000Z');
    await expect(setWorkSchedule(prisma, { workId: work.id, cron: 'nope', timezone: 'UTC', agent: '@patrol' }, human.id)).rejects.toThrow(CRON_FORMAT_MESSAGE);
    await expect(setWorkSchedule(prisma, { workId: work.id, cron: '0 9 * * *', timezone: 'Mars/Olympus', agent: '@patrol' }, human.id)).rejects.toThrow(CRON_TIMEZONE_MESSAGE);
    await expect(setWorkSchedule(prisma, { workId: work.id, cron: '0 9 * * *', timezone: 'UTC', agent: human.id }, human.id)).rejects.toThrow(SCHEDULE_AGENT_MESSAGE);
    expect(await clearWorkSchedule(prisma, work.id)).toBe(true);
    expect(await clearWorkSchedule(prisma, work.id)).toBe(false);
  });

  it('fires a due round once, tells the agent, records the round as a run that leaves the state alone, and counts misses', async () => {
    await setWorkSchedule(prisma, { workId: work.id, cron: '0 * * * *', timezone: 'UTC', agent: '@patrol' }, human.id, new Date('2026-11-06T13:07:00Z'));
    // Not due yet.
    expect(await fireDueSchedules(prisma, new Date('2026-11-06T13:30:00Z'))).toBe(0);
    // Due: fired once, however many ticks see it.
    expect(await fireDueSchedules(prisma, new Date('2026-11-06T14:00:30Z'))).toBe(1);
    expect(await fireDueSchedules(prisma, new Date('2026-11-06T14:00:40Z'))).toBe(0);
    const fired = await prisma.workSchedule.findUniqueOrThrow({ where: { workId: work.id } });
    expect(fired).toMatchObject({ round: 1, missedRounds: 0 });
    expect(fired.nextRunAt?.toISOString()).toBe('2026-11-06T15:00:00.000Z');
    const told = await prisma.notification.findMany({ where: { userId: agent.id, type: 'work.scheduled_run' } });
    expect(told).toHaveLength(1);
    expect(told[0]!.payload).toMatchObject({ round: 1, cron: '0 * * * *' });
    expect(await prisma.eventOutbox.count({ where: { type: 'work.scheduled_run', payload: { path: ['work', 'id'], equals: work.id } } })).toBe(1);

    // The agent runs the round: claim, report with schedule_round; the work stays In Progress.
    const actor = writeActorFromViewer(agent, 'mcp');
    const claim = await claimWork(prisma, work.id, {}, actor);
    await expect(reportRun(prisma, { workId: work.id, claimToken: claim.claimToken!, status: 'completed', summary: 'Checked.', scheduleRound: 2 }, actor)).rejects.toThrow(SCHEDULE_ROUND_MESSAGE);
    const { run, work: after } = await reportRun(prisma, { workId: work.id, claimToken: claim.claimToken!, status: 'completed', summary: 'Checked 12 pages, nothing stale.', scheduleRound: 1, followups: { noneReason: 'Nothing stale.' } }, actor);
    expect(run).toMatchObject({ status: 'COMPLETED', scheduleRound: 1 });
    expect(after.stateId).toBe(work.stateId);

    // Round 2 fires with round 1 run: no miss. Rounds 3–5 fire with nobody running: misses climb to 3 → Needs you.
    expect(await fireDueSchedules(prisma, new Date('2026-11-06T15:00:05Z'))).toBe(1);
    expect((await prisma.workSchedule.findUniqueOrThrow({ where: { workId: work.id } })).missedRounds).toBe(0);
    for (const hour of ['16', '17', '18']) await fireDueSchedules(prisma, new Date(`2026-11-06T${hour}:00:05Z`));
    const missed = await prisma.workSchedule.findUniqueOrThrow({ where: { workId: work.id } });
    expect(missed).toMatchObject({ round: 5, missedRounds: 3 });
    const attention = await loadAttention(prisma, human, undefined);
    expect(attention.map((entry) => entry.kind)).toContain('SCHEDULE_MISSED');
    // Pausing clears it; nothing fires while paused.
    await setWorkScheduleActive(prisma, work.id, false);
    expect((await loadAttention(prisma, human, undefined)).map((entry) => entry.kind)).not.toContain('SCHEDULE_MISSED');
    expect(await fireDueSchedules(prisma, new Date('2026-11-06T19:00:05Z'))).toBe(0);
  });

  it('refuses a scheduled round on work without a schedule', async () => {
    const actor = writeActorFromViewer(agent, 'mcp');
    const claim = await claimWork(prisma, work.id, {}, actor);
    await expect(reportRun(prisma, { workId: work.id, claimToken: claim.claimToken!, status: 'completed', summary: 'x', scheduleRound: 1 }, actor)).rejects.toThrow(SCHEDULE_ROUND_NO_SCHEDULE_MESSAGE);
  });
});

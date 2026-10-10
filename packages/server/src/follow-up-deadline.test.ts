import type { Team, User } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { computeBugSla, computeSlaClock, loadBugSlas } from './bug-sla.ts';
import {
  computeFollowUpDeadline,
  followUpBudgetMs,
  followUpDeadlineDays,
  loadFollowUpDeadlines,
  loadIncidentFollowUpStats,
  sweepFollowUpDeadlines,
} from './follow-up-deadline.ts';
import { startServer } from './index.ts';
import { createIssue, updateIssue } from './issue-service.ts';
import { createSession } from './session.js';
import { createWorkLink } from './link-service.ts';
import { loadWorkHygiene } from './work-hygiene.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (hours: number) => new Date(Date.UTC(2026, 9, 1) + hours * HOUR);
const spell = (hours: number, stateType: 'UNSTARTED' | 'STARTED' | 'REVIEW' | 'COMPLETED' | 'CANCELED') => ({
  at: at(hours),
  stateId: stateType,
  stateName: stateType,
  stateType,
});

describe('follow-up deadline policy (INV-1127)', () => {
  it('budgets Urgent 7 days, High 14, everything else 30, and reads FOLLOW_UP_DEADLINE_DAYS', () => {
    expect([1, 2, 3, 4, 0].map((priority) => followUpBudgetMs(priority) / DAY)).toEqual([7, 14, 30, 30, 30]);
    expect(followUpDeadlineDays({ FOLLOW_UP_DEADLINE_DAYS: '3, 10,21' })).toEqual({ urgent: 3, high: 10, other: 21 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(followUpDeadlineDays({ FOLLOW_UP_DEADLINE_DAYS: '3,x' })).toEqual({ urgent: 7, high: 14, other: 30 });
    expect(followUpDeadlineDays({ FOLLOW_UP_DEADLINE_DAYS: '0,1,2' })).toEqual({ urgent: 7, high: 14, other: 30 });
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('runs the bug SLA clock with the follow-up budget: same pause in Review, same at-risk share', () => {
    const transitions = [spell(0, 'UNSTARTED'), spell(24, 'REVIEW'), spell(24 * 10, 'STARTED')];
    const budgetMs = followUpBudgetMs(1);
    const clock = (now: number, stateType: 'REVIEW' | 'STARTED', slice = transitions.length) =>
      computeSlaClock({ committedAt: at(0), transitions: transitions.slice(0, slice) }, { budgetMs, stateType, createdAt: at(0) }, at(now));
    expect(clock(24 * 9, 'REVIEW', 2)).toMatchObject({ status: 'PAUSED', elapsedMs: DAY, dueAt: null });
    // 1 day before review + 5 after reopening = 6 of 7 days: under 20% left.
    expect(clock(24 * 15, 'STARTED')).toMatchObject({ status: 'AT_RISK', elapsedMs: 6 * DAY });
    expect(clock(24 * 17, 'STARTED')).toMatchObject({ status: 'BREACHED' });
    // The bug SLA is the same clock with its own budget.
    const bug = computeBugSla({ committedAt: at(0), transitions: [spell(0, 'STARTED')] }, { priority: 1, stateType: 'STARTED', createdAt: at(0) }, at(10));
    expect(bug).toEqual(computeSlaClock({ committedAt: at(0), transitions: [spell(0, 'STARTED')] }, { budgetMs: 24 * HOUR, stateType: 'STARTED', createdAt: at(0) }, at(10)));
  });

  it('never counts a declined follow-up as overdue', () => {
    const breached = computeSlaClock({ committedAt: at(0), transitions: [spell(0, 'STARTED'), spell(24 * 40, 'CANCELED')] }, { budgetMs: followUpBudgetMs(3), stateType: 'CANCELED', createdAt: at(0) }, at(24 * 41));
    expect(breached.status).toBe('BREACHED');
    expect(computeFollowUpDeadline(breached, { stateType: 'CANCELED', resolution: 'WONT_DO' })).toBe('DECLINED');
    expect(computeFollowUpDeadline(breached, { stateType: 'CANCELED', resolution: 'COMPLETED' })).toBe('BREACHED');
    expect(computeFollowUpDeadline(breached, { stateType: 'COMPLETED', resolution: null })).toBe('BREACHED');
  });
});

describe('incident follow-ups (INV-1127)', () => {
  let team: Team;
  let admin: User;
  let lead: User;
  let projectId: string;
  const repo = 'acme/incidents';
  const human = () => ({ actorId: admin.id, actorKind: 'HUMAN' as const, surface: 'graphql' as const });

  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    lead = await prisma.user.create({ data: { email: 'lead@example.com', name: 'Lead', actorKind: 'HUMAN' } });
    await prisma.teamMembership.create({ data: { teamId: team.id, userId: lead.id, role: 'EDITOR' } });
    projectId = (await createIssue(prisma, { teamId: team.id, kind: 'PROJECT', title: repo, repository: repo })).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function incident(title = 'Board down') {
    const label = await prisma.issueLabel.upsert({ where: { name: 'Incident' }, update: {}, create: { name: 'Incident' } });
    const issue = await createIssue(prisma, { teamId: team.id, title, repository: repo, parentId: projectId, severity: 'SEV1', assigneeId: lead.id });
    await prisma.issue.update({ where: { id: issue.id }, data: { labels: { connect: { id: label.id } } } });
    return issue;
  }

  async function followUp(incidentId: string, priority: number, title = 'Add a guard') {
    const issue = await createIssue(prisma, { teamId: team.id, title, repository: repo, parentId: projectId, priority, assigneeId: admin.id });
    await createWorkLink(prisma, { fromId: issue.id, toId: incidentId, type: 'DERIVED_FROM' });
    return issue;
  }

  const stateOf = (type: 'REVIEW' | 'CANCELED' | 'COMPLETED') => prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type } });

  it('gives only committed ISSUEs derived from an incident a deadline, and leaves bug SLAs alone', async () => {
    const down = await incident();
    const urgent = await followUp(down.id, 1);
    const research = await createIssue(prisma, { teamId: team.id, title: 'Research', repository: repo, parentId: projectId });
    const notFromIncident = await createIssue(prisma, { teamId: team.id, title: 'Derived from research', repository: repo, parentId: projectId });
    await createWorkLink(prisma, { fromId: notFromIncident.id, toId: research.id, type: 'DERIVED_FROM' });

    const now = new Date();
    const deadlines = await loadFollowUpDeadlines(prisma, [urgent.id, notFromIncident.id, down.id], now);
    expect([...deadlines.keys()]).toEqual([urgent.id]);
    expect(deadlines.get(urgent.id)).toMatchObject({ status: 'ON_TRACK', budgetMs: 7 * DAY, incidentIds: [down.id], closed: false });
    expect((await loadBugSlas(prisma, [urgent.id], now)).size).toBe(0);
  });

  it('pauses in Review, reminds the owner and the Incident Lead once each, and lists overdue ones in /hygiene', async () => {
    const down = await incident();
    const urgent = await followUp(down.id, 1, 'Urgent guard');
    const reviewed = await followUp(down.id, 2, 'Reviewed guard');
    await updateIssue(prisma, reviewed.id, { stateId: (await stateOf('REVIEW')).id }, human());
    const now = Date.now();

    expect(await sweepFollowUpDeadlines(prisma, new Date(now + 6 * DAY))).toBe(1); // 1 of 7 days left
    expect(await sweepFollowUpDeadlines(prisma, new Date(now + 6 * DAY + HOUR))).toBe(0);
    expect(await sweepFollowUpDeadlines(prisma, new Date(now + 8 * DAY))).toBe(1); // overdue
    expect(await sweepFollowUpDeadlines(prisma, new Date(now + 30 * DAY))).toBe(0); // reviewed one is paused

    const notes = await prisma.notification.findMany({ where: { workId: urgent.id, type: { startsWith: 'incident.follow_up' } } });
    expect(notes.map((note) => `${note.type}:${note.userId === lead.id ? 'lead' : 'owner'}`).sort()).toEqual([
      'incident.follow_up_at_risk:lead',
      'incident.follow_up_at_risk:owner',
      'incident.follow_up_overdue:lead',
      'incident.follow_up_overdue:owner',
    ]);
    const events = await prisma.eventOutbox.findMany({ where: { type: { startsWith: 'incident.follow_up' } } });
    expect(events).toHaveLength(2);
    expect(await prisma.notification.count({ where: { workId: reviewed.id } })).toBe(0);
    expect((await loadFollowUpDeadlines(prisma, [reviewed.id], new Date(now + 30 * DAY))).get(reviewed.id)?.status).toBe('PAUSED');

    const hygiene = await loadWorkHygiene(prisma, { teamId: team.id, teamKey: team.key }, new Date(now + 8 * DAY));
    expect(hygiene.overdueFollowUpCount).toBe(1);
    expect(hygiene.overdueFollowUps.map((issue) => issue.id)).toEqual([urgent.id]);
  });

  it('declined follow-ups are not overdue, and counts per incident feed the incident metrics', async () => {
    const down = await incident('Board down');
    const quiet = await incident('Nothing derived');
    const done = await followUp(down.id, 3, 'Done in time');
    const declined = await followUp(down.id, 1, 'Declined');
    const late = await followUp(down.id, 1, 'Late and open');
    await updateIssue(prisma, done.id, { stateId: (await stateOf('COMPLETED')).id }, human());
    await updateIssue(prisma, declined.id, { stateId: (await stateOf('CANCELED')).id, resolution: 'WONT_DO', reason: 'Covered by the new backup job' }, human());

    const later = new Date(Date.now() + 10 * DAY);
    const deadlines = await loadFollowUpDeadlines(prisma, [done.id, declined.id, late.id], later);
    expect(deadlines.get(declined.id)).toMatchObject({ status: 'DECLINED', dueAt: null });
    expect(deadlines.get(late.id)?.status).toBe('BREACHED');
    expect(deadlines.get(done.id)?.status).toBe('MET');
    expect(await sweepFollowUpDeadlines(prisma, later)).toBe(1); // only the open late one

    const stats = await loadIncidentFollowUpStats(prisma, [down.id, quiet.id], later);
    expect(stats.get(down.id)).toEqual({ total: 3, completed: 1, declined: 1, overdue: 1, overdueOpen: 1 });
    expect(stats.get(quiet.id)).toEqual({ total: 0, completed: 0, declined: 0, overdue: 0, overdueOpen: 0 });
    const hygiene = await loadWorkHygiene(prisma, { teamId: team.id, teamKey: team.key }, later);
    expect(hygiene.overdueFollowUps.map((issue) => issue.id)).toEqual([late.id]);
  });

  it('shows the deadline on cards and the issue page, and the overdue list in workHygiene, over GraphQL', async () => {
    const down = await incident();
    const urgent = await followUp(down.id, 1);
    const plain = await createIssue(prisma, { teamId: team.id, title: 'Plain', repository: repo, parentId: projectId });
    const session = await createSession(prisma, admin.id, 3600);
    const server = await startServer({ allowAdminFallback: true, prisma, authToken: 'unused-static-token', port: 0 });
    try {
      const gql = async (query: string, variables?: Record<string, unknown>) => {
        const response = await fetch(`${server.url}/graphql`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: `involute_session=${session.token}` },
          body: JSON.stringify({ query, variables }),
        });
        return (await response.json()) as any;
      };
      const list = await gql(`{ issues(first: 50) { nodes { id followUpDeadline { status budgetHours dueAt incidents { identifier } } } } }`);
      expect(list.errors).toBeUndefined();
      const byId = new Map(list.data.issues.nodes.map((node: any) => [node.id, node.followUpDeadline]));
      expect(byId.get(urgent.id)).toMatchObject({ status: 'ON_TRACK', budgetHours: 7 * 24, incidents: [{ identifier: down.identifier }] });
      expect(byId.get(plain.id)).toBeNull();
      expect(byId.get(down.id)).toBeNull();
      const single = await gql(`query ($id: String!) { issue(id: $id) { followUpDeadline { status } } }`, { id: urgent.identifier });
      expect(single.data.issue.followUpDeadline.status).toBe('ON_TRACK');
      const hygiene = await gql(`query ($key: String!) { workHygiene(teamKey: $key) { overdueFollowUpCount overdueFollowUps { id } } }`, { key: team.key });
      expect(hygiene.data.workHygiene).toEqual({ overdueFollowUpCount: 0, overdueFollowUps: [] });
    } finally {
      await server.stop();
    }
  });
});

import type { Team, User, WorkflowState } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { loadBugMetrics } from './bug-metrics.ts';
import { reportBug } from './bug-report.ts';
import { proposeWork, rejectWork } from './claim-service.ts';
import { createIssue, updateIssue } from './issue-service.ts';
import { closeWorkAsDuplicate } from './work-close.ts';
import { restoreWork } from './work-restore.ts';
import { parseWorkResolution } from './work-resolution.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();
const DESCRIPTION = '### 1. 目标与架构定位\nx\n### 2. 核心功能与交付范围\ny\n### 3. 验收标准与验证方案\nz';

describe('structured close reasons (INV-1118)', () => {
  let team: Team;
  let admin: User;
  let agent: User;
  let projectId: string;
  let canceled: WorkflowState;
  let ready: WorkflowState;
  const asHuman = () => ({ actorId: admin.id, actorKind: 'HUMAN' as const, surface: 'graphql' as const });
  const asAgent = () => ({ actorId: agent.id, actorKind: 'AGENT' as const, surface: 'mcp' as const });

  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    agent = await prisma.user.create({ data: { email: 'bot@agents.local', name: 'Bot', actorKind: 'AGENT', ownerId: admin.id } });
    projectId = (await createIssue(prisma, { teamId: team.id, kind: 'PROJECT', title: 'acme/app', repository: 'acme/app' })).id;
    canceled = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'CANCELED' } });
    ready = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'UNSTARTED' } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const agentBug = (title = 'Crash on save') =>
    proposeWork(prisma, { teamId: team.id, title, description: DESCRIPTION, labels: ['bug'], acceptance: 'No crash.', parentId: projectId, priority: 2, stepsToReproduce: 'Save' }, asAgent());
  const latestAudit = (workId: string) => prisma.workAudit.findFirstOrThrow({ where: { workId }, orderBy: [{ createdAt: 'desc' }, { revision: 'desc' }] });
  const eventData = async (workId: string, type: string) => {
    const event = await prisma.eventOutbox.findFirstOrThrow({ where: { type, payload: { path: ['work', 'id'], equals: workId } }, orderBy: { createdAt: 'desc' } });
    return (event.payload as { data: Record<string, unknown> }).data;
  };

  it('reads resolutions from any surface spelling and refuses unknown ones', () => {
    expect(parseWorkResolution('wont_do')).toBe('WONT_DO');
    expect(parseWorkResolution('cannot-reproduce')).toBe('CANNOT_REPRODUCE');
    expect(parseWorkResolution('INVALID')).toBe('INVALID');
    expect(parseWorkResolution('  ')).toBeNull();
    expect(() => parseWorkResolution('fixed')).toThrow(/Unknown resolution/);
  });

  it('rejects a candidate only with a resolution, and keeps it on the item, audit and event', async () => {
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'Idea', parentId: projectId, repository: 'acme/app' });
    await expect(rejectWork(prisma, candidate.id, { expectedRevision: candidate.revision, reason: 'Not now' }, asHuman())).rejects.toThrow(/needs a resolution/);

    const rejected = await rejectWork(prisma, candidate.id, { expectedRevision: candidate.revision, resolution: 'obsolete', reason: 'Not now' }, asHuman());
    expect(rejected).toMatchObject({ commitmentStatus: 'REJECTED', resolution: 'OBSOLETE' });
    const audit = await latestAudit(candidate.id);
    expect(audit.reason).toBe('Not now');
    expect(audit.after).toMatchObject({ resolution: 'OBSOLETE', commitmentStatus: 'REJECTED' });
    expect(await eventData(candidate.id, 'work.rejected')).toMatchObject({ resolution: 'OBSOLETE', reason: 'Not now' });

    // Restoring undoes the decision, so the resolution goes with it.
    const restored = await restoreWork(prisma, { id: candidate.id, reason: 'Wrong call' }, asHuman());
    expect(restored.resolution).toBeNull();
  });

  it('still needs a reason to decline a bug (zero-bug)', async () => {
    const bug = await reportBug(prisma, { teamId: team.id, title: 'Triaged crash', priority: 3, stepsToReproduce: 'x' }, asHuman());
    await expect(rejectWork(prisma, bug.id, { expectedRevision: bug.revision, resolution: 'INVALID' }, asHuman())).rejects.toThrow(/needs a reason/);
    await expect(rejectWork(prisma, bug.id, { expectedRevision: bug.revision, resolution: 'INVALID', reason: 'Works as designed' }, asHuman()))
      .resolves.toMatchObject({ resolution: 'INVALID' });
  });

  it('cancels committed work only with a resolution, and a bug only with a reason too', async () => {
    const bug = await agentBug();
    await expect(updateIssue(prisma, bug.id, { stateId: canceled.id }, asHuman())).rejects.toThrow(/Canceling work needs a resolution/);
    await expect(updateIssue(prisma, bug.id, { stateId: canceled.id, resolution: 'CANNOT_REPRODUCE' }, asHuman())).rejects.toThrow(/Canceling a bug needs a reason/);

    const closed = await updateIssue(prisma, bug.id, { stateId: canceled.id, resolution: 'cannot_reproduce', reason: 'No crash on 3 machines' }, asHuman());
    expect(closed).toMatchObject({ stateId: canceled.id, resolution: 'CANNOT_REPRODUCE' });
    const audit = await latestAudit(bug.id);
    expect(audit.reason).toBe('No crash on 3 machines');
    expect(audit.after).toMatchObject({ resolution: 'CANNOT_REPRODUCE' });
    expect(await eventData(bug.id, 'work.state_changed')).toMatchObject({ stateType: 'CANCELED', resolution: 'CANNOT_REPRODUCE', reason: 'No crash on 3 machines', actorId: admin.id });

    // Reopening clears it; a plain item needs a resolution but no reason.
    const reopened = await updateIssue(prisma, bug.id, { stateId: ready.id }, asHuman());
    expect(reopened.resolution).toBeNull();
    const chore = await createIssue(prisma, { teamId: team.id, title: 'Chore', parentId: projectId, repository: 'acme/app' });
    await expect(updateIssue(prisma, chore.id, { stateId: canceled.id, resolution: 'WONT_DO' }, asHuman())).resolves.toMatchObject({ resolution: 'WONT_DO' });
  });

  it('refuses a resolution on work that is not being closed', async () => {
    const chore = await createIssue(prisma, { teamId: team.id, title: 'Chore', parentId: projectId, repository: 'acme/app' });
    await expect(updateIssue(prisma, chore.id, { resolution: 'WONT_DO' }, asHuman())).rejects.toThrow(/A resolution says why work was closed/);
    await expect(updateIssue(prisma, chore.id, { stateId: ready.id, resolution: 'WONT_DO' }, asHuman())).rejects.toThrow(/A resolution says why work was closed/);
  });

  it('closes a duplicate: rejects a candidate, cancels committed work, leaves closed work alone', async () => {
    const original = await createIssue(prisma, { teamId: team.id, title: 'Original', parentId: projectId, repository: 'acme/app' });
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'Same idea', parentId: projectId, repository: 'acme/app' });
    const committed = await createIssue(prisma, { teamId: team.id, title: 'Same bug', parentId: projectId, repository: 'acme/app' });

    const fromCandidate = await prisma.$transaction((tx) => closeWorkAsDuplicate(tx, { workId: candidate.id, duplicateOfId: original.id, actor: asHuman() }));
    expect(fromCandidate.closed).toBe(true);
    expect(fromCandidate.work).toMatchObject({ commitmentStatus: 'REJECTED', resolution: 'DUPLICATE' });
    expect(await eventData(candidate.id, 'work.rejected')).toMatchObject({ resolution: 'DUPLICATE', duplicateOfId: original.id, reason: `Duplicate of ${original.identifier}` });

    const fromCommitted = await prisma.$transaction((tx) => closeWorkAsDuplicate(tx, { workId: committed.id, duplicateOfId: original.id, actor: asAgent() }));
    expect(fromCommitted.work).toMatchObject({ stateId: canceled.id, resolution: 'DUPLICATE' });
    expect(await eventData(committed.id, 'work.state_changed')).toMatchObject({ source: 'duplicate', resolution: 'DUPLICATE', duplicateOfId: original.id });

    const again = await prisma.$transaction((tx) => closeWorkAsDuplicate(tx, { workId: committed.id, duplicateOfId: original.id, actor: asHuman() }));
    expect(again).toMatchObject({ closed: false, work: { revision: fromCommitted.work.revision } });
  });

  it('counts closed bugs by resolution and by who reported them', async () => {
    const noisy1 = await agentBug('Agent noise 1');
    const noisy2 = await agentBug('Agent noise 2');
    const human = await reportBug(prisma, { teamId: team.id, title: 'Human report', priority: 3, stepsToReproduce: 'x' }, asHuman());
    await updateIssue(prisma, noisy1.id, { stateId: canceled.id, resolution: 'INVALID', reason: 'Not a bug' }, asHuman());
    await updateIssue(prisma, noisy2.id, { stateId: canceled.id, resolution: 'INVALID', reason: 'Not a bug either' }, asHuman());
    await rejectWork(prisma, human.id, { expectedRevision: human.revision, resolution: 'DUPLICATE', reason: 'Seen before' }, asHuman());
    await agentBug('Still open');

    const metrics = await loadBugMetrics(prisma, { teamId: team.id });
    expect(metrics.byResolution).toEqual([
      { resolution: 'INVALID', source: 'AGENT', count: 2 },
      { resolution: 'DUPLICATE', source: 'HUMAN_REPORT', count: 1 },
    ]);
  });
});

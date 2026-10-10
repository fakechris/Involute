import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Issue, PrismaClient, Team, User, WorkflowState } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import type { GraphQLContext } from './auth.ts';
import { commitWork, proposeWork } from './claim-service.ts';
import { INCIDENT_CLOSE_NO_DOWNSTREAM_MESSAGE, INCIDENT_CLOSE_NO_POSTMORTEM_MESSAGE } from './errors.ts';
import { createIssue, updateIssue } from './issue-service.ts';
import { findOrCreateLabelIds } from './labels.ts';
import { callMcpTool } from './mcp-tools.ts';
import { readUnreadNotifications } from './notification-service.ts';
import { incidentTimestamps, POSTMORTEM_SECTIONS, renderPostmortemDraft } from './postmortem.ts';
import { reviewWork } from './run-service-review.ts';
import { testParentId } from './test-placement.ts';
import { loadWorkTimeline, starTimelineEntry } from './work-activity-timeline.ts';
import { missingCloseRequirements } from './work-closure.ts';
import { loadWorkHygiene } from './work-hygiene.ts';
import type { WriteActor } from './work-service.ts';

loadProjectEnvironment();

const prisma: PrismaClient = new PrismaClientConstructor();
const IMPACT = '### 1. 目标与架构定位\n看板白屏\n\n### 2. 核心功能与交付范围\n所有用户无法打开看板\n\n### 3. 验收标准与验证方案\n看板恢复';
const FOLLOW_UP = '### 1. 目标与架构定位\n加监控\n### 2. 核心功能与交付范围\n告警\n### 3. 验收标准与验证方案\n告警可触发';

// INV-1126: an incident closes once it led somewhere — follow-ups DERIVED_FROM
// it or "无可执行点" — and a SEV1/SEV2 incident only with its postmortem attached.
describe('incident closing and postmortem (INV-1126)', () => {
  let team: Team;
  let human: User;
  let agent: User;
  let done: WorkflowState;
  let review: WorkflowState;
  let humanActor: WriteActor;
  let agentActor: WriteActor;
  let parentId: string;

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    agent = await prisma.user.create({ data: { name: 'Responder', email: 'responder@agents.local', actorKind: 'AGENT', ownerId: human.id } });
    await prisma.teamMembership.createMany({ data: [
      { teamId: team.id, userId: human.id, role: 'OWNER' },
      { teamId: team.id, userId: agent.id, role: 'EDITOR' },
    ], skipDuplicates: true });
    done = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'COMPLETED' } });
    review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'REVIEW' } });
    humanActor = { actorId: human.id, actorKind: 'HUMAN', surface: 'graphql' };
    agentActor = { actorId: agent.id, actorKind: 'AGENT', surface: 'mcp' };
    parentId = await testParentId(prisma, team.id);
  });

  const declare = (severity: 'SEV1' | 'SEV2' | 'SEV3', description = IMPACT) =>
    proposeWork(prisma, { description, labels: ['incident'], parentId, severity, teamId: team.id, title: `Board blank ${severity}` }, agentActor);
  const followUp = (incidentId: string, title = 'Alert on blank board') =>
    proposeWork(prisma, { description: FOLLOW_UP, relatedWorkId: incidentId, relatedWorkType: 'DERIVED_FROM', teamId: team.id, title }, agentActor);
  const commit = (candidate: Issue) =>
    commitWork(prisma, candidate.id, { acceptance: 'Alert fires.', assigneeId: human.id, expectedRevision: candidate.revision }, humanActor);
  const attach = (workId: string) =>
    prisma.attachment.create({ data: { filename: 'postmortem.md', mimeType: 'text/markdown', size: 10, url: '/uploads/x', issueId: workId, uploaderId: human.id } });
  const close = (workId: string, extra: Record<string, unknown> = {}) => updateIssue(prisma, workId, { stateId: done.id, ...extra }, humanActor);

  it('refuses a person closing an incident nothing derives from, until a follow-up exists', async () => {
    const incident = await declare('SEV3');
    await expect(close(incident.id)).rejects.toThrow(INCIDENT_CLOSE_NO_DOWNSTREAM_MESSAGE);
    await followUp(incident.id);
    await expect(close(incident.id)).resolves.toMatchObject({ stateId: done.id });
  });

  it('accepts "无可执行点" in the description, including one sent with the close', async () => {
    const incident = await declare('SEV3');
    await expect(close(incident.id, { description: `${IMPACT}\n无可执行点。` })).resolves.toMatchObject({ stateId: done.id });
  });

  it('refuses a SEV1 or SEV2 incident without an attachment, even with follow-ups', async () => {
    for (const severity of ['SEV1', 'SEV2'] as const) {
      const incident = await declare(severity);
      await followUp(incident.id);
      await expect(close(incident.id)).rejects.toThrow(INCIDENT_CLOSE_NO_POSTMORTEM_MESSAGE);
      await attach(incident.id);
      await expect(close(incident.id)).resolves.toMatchObject({ stateId: done.id });
    }
  });

  it('checks the severity saved with the close', async () => {
    const incident = await declare('SEV3', `${IMPACT}\n无可执行点`);
    await expect(close(incident.id, { severity: 'SEV1' })).rejects.toThrow(INCIDENT_CLOSE_NO_POSTMORTEM_MESSAGE);
  });

  it('applies on review acceptance too', async () => {
    const incident = await declare('SEV2');
    const inReview = await updateIssue(prisma, incident.id, { stateId: review.id, resolvedAt: new Date() }, humanActor);
    await expect(reviewWork(prisma, incident.id, { decision: 'ACCEPTED', expectedRevision: inReview.revision }, humanActor)).rejects.toThrow(INCIDENT_CLOSE_NO_DOWNSTREAM_MESSAGE);
    await followUp(incident.id);
    await attach(incident.id);
    await expect(reviewWork(prisma, incident.id, { decision: 'ACCEPTED', expectedRevision: inReview.revision }, humanActor)).resolves.toMatchObject({ work: { stateId: done.id } });
  });

  it('refuses creating an incident straight into Done', async () => {
    const labelIds = await findOrCreateLabelIds(prisma, ['incident']);
    await expect(
      createIssue(prisma, { labelIds, parentId, severity: 'SEV3', stateId: done.id, teamId: team.id, title: 'Already over', repository: 'test/placement' }, humanActor),
    ).rejects.toThrow(INCIDENT_CLOSE_NO_DOWNSTREAM_MESSAGE);
  });

  it('leaves other work alone', async () => {
    const plain = await createIssue(prisma, { parentId, teamId: team.id, title: 'Plain', repository: 'test/placement' }, humanActor);
    await expect(close(plain.id)).resolves.toMatchObject({ stateId: done.id });
  });

  it('reports the missing requirements through the shared check', async () => {
    const incident = await declare('SEV1');
    const work = await prisma.issue.findUniqueOrThrow({ where: { id: incident.id } });
    expect(await missingCloseRequirements(prisma, work, ['downstream', 'attachment'])).toEqual(['downstream', 'attachment']);
    expect(await missingCloseRequirements(prisma, work, ['attachment'], '无可执行点')).toEqual(['attachment']);
    expect(await missingCloseRequirements(prisma, work, ['downstream'], 'no actionable points')).toEqual([]);
    await attach(incident.id);
    expect(await missingCloseRequirements(prisma, work, ['attachment'])).toEqual([]);
  });

  it('tells the declarer and the Incident Lead once, when every follow-up is committed', async () => {
    const incident = await declare('SEV1');
    const first = await followUp(incident.id, 'First');
    const second = await followUp(incident.id, 'Second');
    const unread = (userId: string) => readUnreadNotifications(prisma, { first: 50, since: null, teamId: null, userId });
    const closable = async (userId: string) => (await unread(userId)).filter((row) => row.type === 'incident.closable');
    await commit(first);
    expect(await closable(agent.id)).toHaveLength(0);
    await commit(second);
    const notices = await closable(agent.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.workId).toBe(incident.id);
    expect(notices[0]!.payload).toMatchObject({ postmortemRequired: true, lastFollowUpIdentifier: second.identifier });
    // The Incident Lead (the agent's human) committed the last one and is still told: they close it.
    expect(await closable(human.id)).toHaveLength(1);
    await commit(await followUp(incident.id, 'Third'));
    expect(await closable(agent.id)).toHaveLength(1);
  });

  it('notices a follow-up bug committed on filing', async () => {
    const incident = await declare('SEV3');
    await proposeWork(prisma, {
      acceptance: 'No blank board.', description: FOLLOW_UP, labels: ['bug'], priority: 2, relatedWorkId: incident.id,
      relatedWorkType: 'DERIVED_FROM', parentId, stepsToReproduce: 'Open board', teamId: team.id, title: 'Board crash',
    }, agentActor);
    const notices = (await readUnreadNotifications(prisma, { first: 50, since: null, teamId: null, userId: agent.id })).filter((row) => row.type === 'incident.closable');
    expect(notices).toHaveLength(1);
  });

  it('lists incidents missing follow-ups or a postmortem on /hygiene', async () => {
    const severe = await declare('SEV1');
    const minor = await declare('SEV3');
    await updateIssue(prisma, severe.id, { stateId: review.id, resolvedAt: new Date() }, humanActor);
    await updateIssue(prisma, minor.id, { stateId: review.id, resolvedAt: new Date() }, humanActor);
    const hygiene = await loadWorkHygiene(prisma, { teamId: team.id, teamKey: DEFAULT_TEAM_KEY });
    expect(hygiene.incidentsWithoutDownstream.map((issue) => issue.id).sort()).toEqual([severe.id, minor.id].sort());
    expect(hygiene.incidentsWithoutPostmortem.map((issue) => issue.id)).toEqual([severe.id]);
    expect(hygiene.incidentsWithoutPostmortemCount).toBe(1);

    await followUp(severe.id);
    await attach(severe.id);
    const after = await loadWorkHygiene(prisma, { teamId: team.id, teamKey: DEFAULT_TEAM_KEY });
    expect(after.incidentsWithoutDownstream.map((issue) => issue.id)).toEqual([minor.id]);
    expect(after.incidentsWithoutPostmortemCount).toBe(0);
  });

  describe('postmortem draft', () => {
    const asAgent = (): GraphQLContext => ({ prisma, viewer: agent, authMode: 'agent-token', agentScopes: ['read', 'propose'], agentTeamId: team.id, isTrustedSystem: false });

    it('drafts the six sections with starred entries and follow-ups through work_timeline', async () => {
      const incident = await proposeWork(prisma, {
        description: IMPACT, labels: ['incident'], parentId, severity: 'SEV1', teamId: team.id, title: 'Board blank SEV1',
        impactStartedAt: '2026-10-09T07:50:00Z', detectedAt: '2026-10-09T08:02:00Z',
      }, agentActor);
      await followUp(incident.id, 'Alert on blank board');
      await updateIssue(prisma, incident.id, { stateId: review.id, resolvedAt: '2026-10-09T09:15:00Z' }, humanActor);
      const entries = (await loadWorkTimeline(prisma, incident.id)).entries;
      const moved = entries.find((entry) => entry.kind === 'STATE')!;
      await starTimelineEntry({ prisma, viewer: human, authMode: 'session', isTrustedSystem: false }, incident.identifier, moved.key);

      const draft = (await callMcpTool(asAgent(), 'work_timeline', { action: 'postmortem_draft', work_id: incident.identifier }, true)) as Record<string, unknown> & { markdown: string };
      expect(draft).toMatchObject({ identifier: incident.identifier, is_incident: true, severity: 'SEV1', postmortem_required: true, starred_count: 1, filename: `postmortem-${incident.identifier}.md` });
      POSTMORTEM_SECTIONS.forEach((section, index) => expect(draft.markdown).toContain(`## ${index + 1}. ${section}`));
      expect(draft.markdown).toContain(moved.summary);
      expect(draft.markdown).toContain('Alert on blank board — 待承诺（Candidates）');
      expect(draft.markdown).toContain('所有用户无法打开看板');
      // The incident's own timestamps (INV-1125), not placeholders.
      expect(draft.markdown).toContain('- 影响开始：2026-10-09 07:50 UTC');
      expect(draft.markdown).toContain('- 发现：2026-10-09 08:02 UTC');
      expect(draft.markdown).toContain('- 缓解：未记录');
      expect(draft.markdown).toContain('- 解决：2026-10-09 09:15 UTC');
      expect(draft.timestamps).toEqual([
        { field: 'impactStartedAt', label: '影响开始', at: '2026-10-09T07:50:00.000Z' },
        { field: 'detectedAt', label: '发现', at: '2026-10-09T08:02:00.000Z' },
        { field: 'mitigatedAt', label: '缓解', at: null },
        { field: 'resolvedAt', label: '解决', at: '2026-10-09T09:15:00.000Z' },
      ]);
    });

    it('renders recorded and unrecorded impact timestamps (INV-1125)', () => {
      const started = new Date(Date.UTC(2026, 9, 9, 8, 5));
      const timestamps = incidentTimestamps({ impactStartedAt: started, detectedAt: null, mitigatedAt: null, resolvedAt: null });
      expect(timestamps.map((stamp) => [stamp.field, stamp.at])).toEqual([['impactStartedAt', started], ['detectedAt', null], ['mitigatedAt', null], ['resolvedAt', null]]);
      const markdown = renderPostmortemDraft({
        identifier: 'INV-1', title: 'Outage', severity: 'SEV2', description: null, stateName: 'In Review', declaredAt: started,
        isIncident: true, timestamps, starred: [], followUps: [],
      });
      expect(markdown).toContain('- 影响开始：2026-10-09 08:05 UTC');
      expect(markdown).toContain('尚无标星条目');
      expect(markdown).toContain('尚无 follow-up');
    });

    it('needs read access to the work', async () => {
      const incident = await declare('SEV3');
      const outsider = await prisma.user.create({ data: { name: 'Out', email: 'out@pm.test', actorKind: 'HUMAN' } });
      await prisma.team.update({ where: { id: team.id }, data: { visibility: 'PRIVATE' } });
      await expect(
        callMcpTool({ prisma, viewer: outsider, authMode: 'session', isTrustedSystem: false }, 'work_timeline', { action: 'postmortem_draft', work_id: incident.identifier }, true),
      ).rejects.toThrow();
    });
  });
});

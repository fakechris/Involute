import type { Team, User } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { hashAgentToken } from './agent-credentials.ts';
import { loadIncidentSummary } from './incident-metrics.ts';
import { startServer } from './index.ts';
import { createIssue, updateIssue } from './issue-service.ts';
import { createWorkLink } from './link-service.ts';
import { createSession } from './session.js';

loadProjectEnvironment();
const prisma = new PrismaClient();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const AGENT_TOKEN = 'inv_agent_incident_metrics_token';

// INV-1129: /incidents numbers, hand-computed against a fixed fixture.
describe('incident summary (INV-1129)', () => {
  let team: Team;
  let admin: User;
  let projectId: string;
  let otherProjectId: string;
  const repo = 'acme/incidents';
  const human = () => ({ actorId: admin.id, actorKind: 'HUMAN' as const, surface: 'graphql' as const });
  const base = Date.UTC(2026, 9, 1);
  const at = (hours: number) => new Date(base + hours * HOUR);

  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    projectId = (await createIssue(prisma, { teamId: team.id, kind: 'PROJECT', title: repo, repository: repo })).id;
    otherProjectId = (await createIssue(prisma, { teamId: team.id, kind: 'PROJECT', title: 'acme/other', repository: 'acme/other' })).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function incident(
    title: string,
    severity: 'SEV1' | 'SEV2' | 'SEV3',
    times: { impactStartedAt: Date; detectedAt?: Date; mitigatedAt?: Date | null; resolvedAt?: Date | null },
    repository = repo,
  ) {
    const label = await prisma.issueLabel.upsert({ where: { name: 'Incident' }, update: {}, create: { name: 'Incident' } });
    const issue = await createIssue(prisma, { teamId: team.id, title, repository, parentId: repository === repo ? projectId : otherProjectId, severity });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { labels: { connect: { id: label.id } }, detectedAt: times.detectedAt ?? times.impactStartedAt, ...times },
    });
    return issue;
  }

  async function followUp(incidentId: string, priority: number, title: string) {
    const issue = await createIssue(prisma, { teamId: team.id, title, repository: repo, parentId: projectId, priority, assigneeId: admin.id });
    await createWorkLink(prisma, { fromId: issue.id, toId: incidentId, type: 'DERIVED_FROM' });
    return issue;
  }

  const stateOf = (type: 'REVIEW' | 'CANCELED' | 'COMPLETED') => prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type } });

  /**
   * A: SEV1, impact 0h, mitigated 1h, resolved 4h, postmortem attached; follow-ups: one done, one declined, one open and late.
   * B: SEV2, impact 10h, no mitigation recorded, resolved 12h (MTTM falls back to 2h).
   * C: SEV3 in another project, ongoing since 20h.
   * Declined (REJECTED) and duplicate incidents carry long durations that must not count.
   * MTTR = (4 + 2) / 2 = 3h; MTTM = (1 + 2) / 2 = 1.5h; completion = 1 / (3 − 1) = 0.5.
   */
  async function seedFixture() {
    const a = await incident('A: board down', 'SEV1', { impactStartedAt: at(0), mitigatedAt: at(1), resolvedAt: at(4) });
    const b = await incident('B: search slow', 'SEV2', { impactStartedAt: at(10), resolvedAt: at(12) });
    const c = await incident('C: sync stalled', 'SEV3', { impactStartedAt: at(20) }, 'acme/other');
    const declined = await incident('Declined: false alarm', 'SEV1', { impactStartedAt: at(0), resolvedAt: at(100) });
    await prisma.issue.update({ where: { id: declined.id }, data: { commitmentStatus: 'REJECTED' } });
    const duplicate = await incident('Duplicate of A', 'SEV1', { impactStartedAt: at(0), resolvedAt: at(200) });
    await createWorkLink(prisma, { fromId: duplicate.id, toId: a.id, type: 'DUPLICATE_OF' });
    await prisma.attachment.create({
      data: { issueId: a.id, filename: 'postmortem.md', mimeType: 'text/markdown', size: 10, url: '/uploads/pm-a', uploaderId: admin.id },
    });

    const done = await followUp(a.id, 3, 'Done guard');
    const declinedFollowUp = await followUp(a.id, 1, 'Declined guard');
    await followUp(a.id, 1, 'Late guard');
    await updateIssue(prisma, done.id, { stateId: (await stateOf('COMPLETED')).id }, human());
    await updateIssue(prisma, declinedFollowUp.id, { stateId: (await stateOf('CANCELED')).id, resolution: 'WONT_DO', reason: 'Covered elsewhere' }, human());
    return { a, b, c };
  }

  it('counts, averages and follow-up rates match the hand-computed fixture; declined and duplicate incidents are left out', async () => {
    const { a, b, c } = await seedFixture();
    const now = new Date(Date.now() + 10 * DAY); // the urgent open follow-up is past its 7 days
    const summary = await loadIncidentSummary(prisma, { teamId: team.id }, now);

    expect(summary).toMatchObject({
      openCount: 1,
      resolvedCount: 2,
      excludedCount: 2,
      mttrHours: 3,
      mttrSampleCount: 2,
      mttmHours: 1.5,
      mttmSampleCount: 2,
      followUps: { total: 3, completed: 1, declined: 1, overdue: 1, overdueOpen: 1, completionRate: 0.5 },
    });
    expect(summary.bySeverity).toEqual([
      { severity: 'SEV1', openCount: 0, resolvedCount: 1 },
      { severity: 'SEV2', openCount: 0, resolvedCount: 1 },
      { severity: 'SEV3', openCount: 1, resolvedCount: 0 },
    ]);
    expect(summary.byRepository).toEqual([
      { repository: repo, openCount: 0, resolvedCount: 2 },
      { repository: 'acme/other', openCount: 1, resolvedCount: 0 },
    ]);
    expect(summary.incidents.map((item) => item.identifier)).toEqual([c.identifier, b.identifier, a.identifier]);
    const byId = new Map(summary.incidents.map((item) => [item.id, item]));
    expect(byId.get(a.id)).toMatchObject({ impactHours: 4, ongoing: false, postmortemRequired: true, postmortemAttached: true, followUpTotal: 3, followUpCompleted: 1, followUpDeclined: 1, followUpOverdueOpen: 1 });
    expect(byId.get(b.id)).toMatchObject({ impactHours: 2, ongoing: false, postmortemRequired: true, postmortemAttached: false, followUpTotal: 0 });
    expect(byId.get(c.id)).toMatchObject({ ongoing: true, postmortemRequired: false, resolvedAt: null });
    expect(byId.get(c.id)!.impactHours).toBeCloseTo((now.getTime() - at(20).getTime()) / HOUR, 1);
  });

  it('is empty with no incidents: zero counts and null averages', async () => {
    expect(await loadIncidentSummary(prisma, {})).toEqual({
      openCount: 0,
      resolvedCount: 0,
      excludedCount: 0,
      bySeverity: [],
      byRepository: [],
      mttrHours: null,
      mttrSampleCount: 0,
      mttmHours: null,
      mttmSampleCount: 0,
      followUps: { total: 0, completed: 0, declined: 0, overdue: 0, overdueOpen: 0, completionRate: null },
      incidents: [],
    });
  });

  it('serves the same numbers over GraphQL and MCP, counting only incidents the caller can read', async () => {
    await seedFixture();
    // An incident in a private team neither the member nor the agent belongs to.
    const secret = await prisma.team.create({ data: { key: 'SEC', name: 'Secret', visibility: 'PRIVATE' } });
    const secretState = await prisma.workflowState.create({ data: { teamId: secret.id, name: 'In Progress', type: 'STARTED' } });
    const label = await prisma.issueLabel.findUniqueOrThrow({ where: { name: 'Incident' } });
    await prisma.issue.create({
      data: { identifier: 'SEC-1', title: 'Hidden outage', teamId: secret.id, stateId: secretState.id, severity: 'SEV1', impactStartedAt: at(0), labels: { connect: { id: label.id } } },
    });

    const member = await prisma.user.create({ data: { email: 'member@example.com', name: 'Member', actorKind: 'HUMAN' } });
    await prisma.teamMembership.create({ data: { teamId: team.id, userId: member.id, role: 'EDITOR' } });
    const agent = await prisma.user.create({ data: { name: 'Metrics agent', email: 'metrics@agents.local', actorKind: 'AGENT', ownerId: admin.id } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: agent.id } });
    await prisma.agentCredential.create({ data: { name: 'metrics', scopes: ['read'], tokenHash: hashAgentToken(AGENT_TOKEN), teamId: team.id, userId: agent.id } });
    const session = await createSession(prisma, member.id, 3600);
    const server = await startServer({ allowAdminFallback: true, prisma, authToken: 'unused-static-token', port: 0 });
    try {
      const response = await fetch(`${server.url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `involute_session=${session.token}` },
        body: JSON.stringify({
          query: `{ incidentSummary { openCount resolvedCount excludedCount mttrHours mttrSampleCount mttmHours mttmSampleCount
            bySeverity { severity openCount resolvedCount } byRepository { repository openCount resolvedCount }
            followUps { total completed declined overdue overdueOpen completionRate }
            incidents { identifier severity ongoing impactHours postmortemRequired postmortemAttached followUpTotal followUpCompleted impactStartedAt resolvedAt } } }`,
        }),
      });
      const body = (await response.json()) as any;
      expect(body.errors).toBeUndefined();
      const summary = body.data.incidentSummary;
      expect(summary).toMatchObject({ openCount: 1, resolvedCount: 2, excludedCount: 2, mttrHours: 3, mttmHours: 1.5 });
      expect(summary.incidents.map((item: any) => item.identifier)).not.toContain('SEC-1');
      expect(summary.incidents.find((item: any) => item.postmortemAttached)).toMatchObject({ severity: 'SEV1', resolvedAt: at(4).toISOString() });

      const mcp = await fetch(`${server.url}/mcp`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'work_catalog', arguments: { kind: 'incident_summary' } } }),
      });
      const result = ((await mcp.json()) as any).result;
      expect(result.isError).toBeFalsy();
      const viaMcp = JSON.parse(result.content[0].text);
      expect(viaMcp).toMatchObject({ openCount: 1, resolvedCount: 2, excludedCount: 2, mttrHours: 3, mttrSampleCount: 2, mttmHours: 1.5, mttmSampleCount: 2 });
      expect(viaMcp.incidents.map((item: any) => item.identifier)).not.toContain('SEC-1');
    } finally {
      await server.stop();
    }
  });
});

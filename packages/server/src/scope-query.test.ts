import { PrismaClient } from '@prisma/client';
import { afterAll, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, resetAndSeed } from '../prisma/seed-helpers.js';
import { startServer } from './index.js';
import { createIssue, updateIssue } from './issue-service.js';
import { callMcpTool } from './mcp-tools.js';
import { createSession } from './session.js';

const prisma = new PrismaClient();
const at = (day: number) => new Date(Date.UTC(2026, 0, day, 12));
afterAll(() => prisma.$disconnect());

it('replays real service audits through GraphQL and MCP, including a moved-out historical member and permissions', async () => {
  await resetAndSeed(prisma);
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  const outsider = await prisma.user.create({ data: { name: 'Outsider', email: 'scope-outsider@example.com', globalRole: 'GUEST' } });
  const team = await prisma.team.create({ data: { key: 'SCP', name: 'Private scope fixture', visibility: 'PRIVATE' } });
  const todo = await prisma.workflowState.create({ data: { teamId: team.id, name: 'Todo', type: 'UNSTARTED', position: 0 } });
  const done = await prisma.workflowState.create({ data: { teamId: team.id, name: 'Done', type: 'COMPLETED', position: 1 } });
  const actor = { actorId: admin.id, actorKind: 'HUMAN' as const, surface: 'graphql' };
  const project = await createIssue(prisma, { teamId: team.id, title: 'Project', kind: 'PROJECT', repository: 'scope/fixture' }, actor);
  const milestone = await createIssue(prisma, { teamId: team.id, title: 'Milestone', kind: 'MILESTONE', parentId: project.id, repository: project.repository }, actor);
  const epic = await createIssue(prisma, { teamId: team.id, title: 'Epic', kind: 'EPIC', parentId: milestone.id, repository: project.repository }, actor);
  const issue = await createIssue(prisma, { teamId: team.id, title: 'Issue', parentId: epic.id, repository: project.repository, stateId: todo.id }, actor);
  await updateIssue(prisma, issue.id, { stateId: done.id }, actor);
  await updateIssue(prisma, epic.id, { parentId: project.id }, actor);
  await prisma.workAudit.updateMany({ where: { workId: epic.id, revision: 1 }, data: { createdAt: at(1) } });
  await prisma.workAudit.updateMany({ where: { workId: epic.id, revision: 2 }, data: { createdAt: at(4) } });
  await prisma.workAudit.updateMany({ where: { workId: issue.id, revision: 1 }, data: { createdAt: at(1) } });
  await prisma.workAudit.updateMany({ where: { workId: issue.id, revision: 2 }, data: { createdAt: at(3) } });

  const session = await createSession(prisma, admin.id, 3600);
  const outsiderSession = await createSession(prisma, outsider.id, 3600);
  const server = await startServer({ allowAdminFallback: false, prisma, port: 0, authToken: 'unused-static-token' });
  try {
    const query = `query ($id: String!, $from: String!) { milestoneBurndown(milestoneId: $id, from: $from, to: "2026-01-04") {
      definitionVersion milestone { id identifier } window { from to timeZone start end }
      coverage { status baseline memberCount unknownWorkCount backfilledEventCount gaps { start end workId reason } }
      emptyReason ideal { kind start end } points { date at scope remaining ideal }
      events { sequence milestoneId workId identifier type effectiveAt recordedAt backfilled source { auditId surface actorKind actorId reason } }
    } }`;
    const request = async (id = milestone.identifier, token: string | null = session.token, from = '2026-01-01') => {
      const response = await fetch(`${server.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { cookie: `involute_session=${token}` } : {}) },
        body: JSON.stringify({ query, variables: { id, from } }) });
      return await response.json();
    };
    const result = await request();
    expect(result.errors).toBeUndefined();
    expect(result.data.milestoneBurndown.points.map((p: { scope: number; remaining: number }) => [p.scope, p.remaining])).toEqual([[1, 1], [1, 1], [1, 0], [0, 0]]);
    expect(result.data.milestoneBurndown.coverage).toMatchObject({ status: 'PARTIAL', memberCount: 2, unknownWorkCount: 0 });
    const mcp = await callMcpTool({ prisma, viewer: admin, authMode: 'session', isTrustedSystem: false }, 'work_burndown', { milestone_id: milestone.id, from: '2026-01-01', to: '2026-01-04' }, true);
    expect(JSON.parse(JSON.stringify(mcp))).toEqual(result.data.milestoneBurndown);
    expect((await request(milestone.id, outsiderSession.token)).errors[0].message).toBe('Readable milestone not found.');
    expect((await request(milestone.id, null)).errors).toBeDefined();
    expect((await request(project.id)).errors[0].message).toBe('Burndown requires a MILESTONE.');
    expect((await request(milestone.id, session.token, 'invalid')).errors[0].message).toContain('YYYY-MM-DD');
    await expect(callMcpTool({ prisma, viewer: outsider, authMode: 'session', isTrustedSystem: false }, 'work_burndown', { milestone_id: milestone.id, from: '2026-01-01', to: '2026-01-04' }, true)).rejects.toThrow('Readable milestone not found.');
    await expect(callMcpTool({ prisma, viewer: admin, authMode: 'agent-token', agentScopes: [], isTrustedSystem: false }, 'work_burndown', { milestone_id: milestone.id, from: '2026-01-01', to: '2026-01-04' }, true)).rejects.toThrow();
    const later = await createIssue(prisma, { teamId: team.id, title: 'Created after window', parentId: milestone.id, repository: project.repository }, actor);
    await prisma.workAudit.updateMany({ where: { workId: later.id }, data: { createdAt: at(10) } });
    expect((await request()).data.milestoneBurndown).toEqual(result.data.milestoneBurndown);
    const empty = await createIssue(prisma, { teamId: team.id, title: 'Empty', kind: 'MILESTONE', parentId: project.id, repository: project.repository }, actor);
    expect((await request(empty.id)).data.milestoneBurndown.emptyReason).toBe('NO_MEMBERS');
  } finally { await server.stop(); }
});

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.js';
import { loadProjectEnvironment } from '../prisma/env.js';
import { issueAgentCredential } from './agent-credentials.js';
import { adviseTrust, allowedAt, loadAgentTrustMetrics, setAgentTrust, type AgentTrustMetrics } from './agent-trust.js';
import { loadAutonomyFor, setWorkflowPolicy } from './autonomy-service.js';
import { createIssue } from './issue-service.js';
import { writeActorFromViewer } from './work-service.js';
import { WORKSPACE_SETTINGS_ID } from './workspace-access.js';

// INV-1490: trust is a clamp set by a person with a reason; new agents observe.
loadProjectEnvironment();
const prisma = new PrismaClient();

beforeEach(async () => { await resetAndSeed(prisma); });
afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });

async function fixture() {
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const issued = await issueAgentCredential(prisma, { email: `trusty-${Date.now()}@agents.involute.local`, name: 'Trusty', ownerId: admin.id, teamKey: team.key, scopes: ['read', 'propose'], issuedById: admin.id });
  const agent = await prisma.user.findUniqueOrThrow({ where: { id: issued.credential.userId } });
  const actor = writeActorFromViewer(admin, 'test');
  const project = await createIssue(prisma, { teamId: team.id, title: 'P', kind: 'PROJECT', repository: 'test/trust', commitmentStatus: 'COMMITTED' }, actor);
  const issue = await createIssue(prisma, { teamId: team.id, title: 'I', kind: 'ISSUE', parentId: project.id, repository: 'test/trust', commitmentStatus: 'COMMITTED' }, actor);
  return { admin, team, agent, issue };
}

describe('agent trust (INV-1490)', () => {
  it('a newly issued agent has an OBSERVE row and is clamped to L0 in an L2 project', async () => {
    const { admin, team, agent, issue } = await fixture();
    const row = await prisma.agentTrust.findUnique({ where: { actorId: agent.id } });
    expect(row?.level).toBe('OBSERVE');
    await setWorkflowPolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, level: 2, reason: 'c' }, admin.id);
    await setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 2, reason: 't' }, admin.id);
    expect(await loadAutonomyFor(prisma, issue, { id: agent.id, actorKind: 'AGENT' })).toMatchObject({ level: 0, source: 'agent_trust', agentTrust: 'OBSERVE' });
    expect((await loadAutonomyFor(prisma, issue, { id: admin.id, actorKind: 'HUMAN' })).level).toBe(2);
  });

  it('promotes and demotes with a reason, audited on the actor; refuses no reason, a bad level and a person', async () => {
    const { admin, team, agent, issue } = await fixture();
    await setWorkflowPolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, level: 3, reason: 'c' }, admin.id);
    await setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 3, reason: 't' }, admin.id);
    const promoted = await setAgentTrust(prisma, { actorId: agent.id, level: 'L2', reason: '42 clean deliveries' }, admin.id);
    expect(promoted.level).toBe('L2');
    expect((await loadAutonomyFor(prisma, issue, { id: agent.id, actorKind: 'AGENT' })).level).toBe(2);
    await setAgentTrust(prisma, { actorId: agent.id, level: 'OBSERVE', reason: 'three overrides this week' }, admin.id);
    const audits = await prisma.actorAudit.findMany({ where: { subjectId: agent.id, action: 'policy.changed' }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((audit) => [audit.before, audit.after, audit.reason])).toEqual([
      [{ trust: 'OBSERVE' }, { trust: 'L2' }, '42 clean deliveries'],
      [{ trust: 'L2' }, { trust: 'OBSERVE' }, 'three overrides this week'],
    ]);
    await expect(setAgentTrust(prisma, { actorId: agent.id, level: 'L1', reason: '  ' }, admin.id)).rejects.toThrow(/reason/);
    await expect(setAgentTrust(prisma, { actorId: agent.id, level: 'L9' as never, reason: 'x' }, admin.id)).rejects.toThrow(/OBSERVE, L1, L2 or L3/);
    await expect(setAgentTrust(prisma, { actorId: admin.id, level: 'L1', reason: 'x' }, admin.id)).rejects.toThrow(/Only an AGENT/);
  });

  it('reports 30-day metrics from the agent’s own runs, bugs and reopens', async () => {
    const { admin, team, agent } = await fixture();
    const now = new Date();
    const agentActor = writeActorFromViewer(agent, 'mcp');
    const bugLabel = await prisma.issueLabel.upsert({ where: { name: 'Bug' }, create: { name: 'Bug' }, update: {} });
    // Two bugs filed by the agent: one later closed as INVALID.
    const good = await createIssue(prisma, { teamId: team.id, title: 'real', kind: 'ISSUE', labelIds: [bugLabel.id], priority: 3, repository: 'test/trust', commitmentStatus: 'COMMITTED' }, agentActor);
    const noise = await createIssue(prisma, { teamId: team.id, title: 'noise', kind: 'ISSUE', labelIds: [bugLabel.id], priority: 3, repository: 'test/trust', commitmentStatus: 'COMMITTED' }, agentActor);
    await prisma.issue.update({ where: { id: noise.id }, data: { resolution: 'INVALID' } });
    // Three completed runs, one of them 40 days ago (outside the window).
    for (const [index, daysAgo] of [1, 2, 40].entries()) {
      await prisma.workRun.create({ data: { publicId: `RUN-T${index}-${Date.now()}`, workId: good.id, actorId: agent.id, status: 'COMPLETED', endedAt: new Date(now.getTime() - daysAgo * 86_400_000), createdAt: new Date(now.getTime() - daysAgo * 86_400_000) } });
    }
    // A reopen on the delivered work, and one override audit row on it.
    const audit = await prisma.workAudit.create({ data: { workId: good.id, revision: 9, actorKind: 'HUMAN', actorId: admin.id, after: {}, reason: 'policy.override: returned to Review' } });
    await prisma.workReopen.create({ data: { workId: good.id, auditId: audit.id, fromStateType: 'COMPLETED', toStateType: 'REVIEW' } });
    const metrics = await loadAgentTrustMetrics(prisma, agent.id, now);
    expect(metrics).toMatchObject({ windowDays: 30, deliveries: 2, bugsFiled: 2, falseReports: 1, falseReportRate: 50, reopens: 1, overrides: 1, overridesLastWeek: 1 });
  });

  it('advises a raise only after clean deliveries, warns on three overrides in a week, and never applies either', () => {
    const base: AgentTrustMetrics = { windowDays: 30, deliveries: 12, bugsFiled: 3, falseReports: 0, falseReportRate: 0, reopens: 0, overrides: 0, overridesLastWeek: 0 };
    expect(adviseTrust('OBSERVE', base)).toEqual({ suggestedLevel: 'L1', warning: null });
    expect(adviseTrust('L3', base)).toEqual({ suggestedLevel: null, warning: null });
    expect(adviseTrust('L1', { ...base, deliveries: 2 }).suggestedLevel).toBeNull();
    expect(adviseTrust('L1', { ...base, reopens: 1 }).suggestedLevel).toBeNull();
    expect(adviseTrust('L2', { ...base, overrides: 3, overridesLastWeek: 3 })).toMatchObject({ suggestedLevel: null, warning: expect.stringContaining('3 automatic decisions') });
    expect(allowedAt('OBSERVE')).toEqual({ claimWork: true, fileBugs: true, autoCommit: false, autoAccept: false, delegate: false });
    expect(allowedAt('L3')).toEqual({ claimWork: true, fileBugs: true, autoCommit: true, autoAccept: true, delegate: true });
  });
});

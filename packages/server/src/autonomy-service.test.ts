import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.js';
import { loadProjectEnvironment } from '../prisma/env.js';
import { autonomyToGraphQL, loadAutonomyFor, readActivePolicy, setWorkflowPolicy, syncAutoAcceptBugsPolicy } from './autonomy-service.js';
import { createIssue, updateIssue } from './issue-service.js';
import { writeActorFromViewer } from './work-service.js';
import { WORKSPACE_SETTINGS_ID } from './workspace-access.js';

// INV-1488: policy rows resolve to a level and per-gate deciders; nothing acts on them yet.
loadProjectEnvironment();
const prisma = new PrismaClient();

beforeEach(async () => { await resetAndSeed(prisma); });
afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });

async function fixture() {
  const startedAt = new Date();
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const actor = writeActorFromViewer(admin, 'test');
  const project = await createIssue(prisma, { teamId: team.id, title: 'Project', kind: 'PROJECT', repository: 'test/autonomy', commitmentStatus: 'COMMITTED' }, actor);
  const issue = await createIssue(prisma, { teamId: team.id, title: 'Child', kind: 'ISSUE', parentId: project.id, repository: 'test/autonomy', commitmentStatus: 'COMMITTED' }, actor);
  const agent = await prisma.user.create({ data: { name: 'bot', email: `bot-${Date.now()}@example.com`, actorKind: 'AGENT', handle: `bot${Date.now()}` } });
  return { admin, team, actor, project, issue, agent, startedAt };
}

describe('autonomy service (INV-1488)', () => {
  it('a fresh workspace resolves every item to L0 and the MCP/GraphQL shape names the level in both languages', async () => {
    const { issue } = await fixture();
    const view = await loadAutonomyFor(prisma, issue);
    expect(view.level).toBe(0);
    expect(view.source).toBe('default');
    expect(view.versions).toEqual({ workspace: null, team: null, project: null });
    const shaped = autonomyToGraphQL(view);
    expect(shaped.name).toBe('L0 Review everything');
    expect(shaped.descriptionZh).toContain('Done');
    expect(shaped.gates.map((gate) => gate.gate)).toEqual(['candidate_commit', 'contract_amendment', 'review_accept', 'agent_delegation', 'merge_signal', 'spend_budget']);
    expect(shaped.gates.every((gate) => gate.decider !== 'auto')).toBe(true);
  });

  it('writes versioned rows, clamps team to the workspace ceiling, and a new agent observes', async () => {
    const { admin, team, issue, agent, startedAt } = await fixture();
    await setWorkflowPolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, level: 2, reason: 'ceiling L2' }, admin.id);
    await setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 3, reason: 'try hands-off' }, admin.id);
    const second = await setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 1, reason: 'too much' }, admin.id);
    expect(second.version).toBe(2);
    const rows = await prisma.workflowPolicy.findMany({ where: { scope: 'TEAM', scopeId: team.id }, orderBy: { version: 'asc' } });
    expect(rows.map((row) => [row.level, row.active])).toEqual([[3, false], [1, true]]);

    await setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 3, reason: 'again' }, admin.id);
    const clamped = await loadAutonomyFor(prisma, issue);
    expect(clamped).toMatchObject({ level: 2, source: 'ceiling', requested: 3, requestedBy: 'team' });
    expect(clamped.versions.team).toBe(3);

    const asAgent = await loadAutonomyFor(prisma, issue, { id: agent.id, actorKind: 'AGENT' });
    expect(asAgent).toMatchObject({ level: 0, source: 'agent_trust', agentTrust: 'OBSERVE' });
    await prisma.agentTrust.create({ data: { actorId: agent.id, level: 'L2', setById: admin.id, reason: 'trusted' } });
    expect((await loadAutonomyFor(prisma, issue, { id: agent.id, actorKind: 'AGENT' })).level).toBe(2);

    // OpsAudit is not cleared by resetAndSeed (the test DB is shared): count from this test's start.
    const audits = await prisma.opsAudit.findMany({ where: { action: 'policy.changed', createdAt: { gte: startedAt } }, orderBy: { createdAt: 'asc' } });
    expect(audits).toHaveLength(4);
    expect(audits[0]!.subject).toBe(`workspace:${WORKSPACE_SETTINGS_ID}`);
    expect(audits[0]!.reason).toBe('ceiling L2');
  });

  it('refuses a missing reason, a bad level, an unknown condition field and locks outside the workspace', async () => {
    const { admin, team } = await fixture();
    await expect(setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 1, reason: ' ' }, admin.id)).rejects.toThrow(/reason/);
    await expect(setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 4, reason: 'x' }, admin.id)).rejects.toThrow(/0, 1, 2 or 3/);
    await expect(setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 1, reason: 'x', gates: { review_accept: { decider: 'auto', condition: { field: 'title', eq: 'a' } } } }, admin.id)).rejects.toThrow(/unknown field "title"/);
    await expect(setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 1, reason: 'x', locked: ['sev1_sev2_done'] }, admin.id)).rejects.toThrow(/workspace policy only/);
    await expect(setWorkflowPolicy(prisma, { scope: 'PROJECT', scopeId: team.id, level: 1, reason: 'x' }, admin.id)).rejects.toThrow(/committed PROJECT/);
  });

  it('a project override and an optional observe window are reported with the item', async () => {
    const { admin, team, project, issue } = await fixture();
    await setWorkflowPolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, level: 3, reason: 'ceiling' }, admin.id);
    await setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 2, reason: 'team' }, admin.id);
    await setWorkflowPolicy(prisma, { scope: 'PROJECT', scopeId: project.id, level: 1, reason: 'careful here', observeDays: 7 }, admin.id);
    const view = await loadAutonomyFor(prisma, issue);
    expect(view).toMatchObject({ level: 1, source: 'project', projectId: project.id, observing: true });
    const viewOfProject = await loadAutonomyFor(prisma, project);
    expect(viewOfProject.projectId).toBe(project.id);
  });

  it('autoAcceptBugs keeps writing the column and now also an L2 / Type Bug project override; off removes it', async () => {
    const { actor, project, issue, startedAt } = await fixture();
    const on = await updateIssue(prisma, project.id, { autoAcceptBugs: true, expectedRevision: project.revision }, actor);
    expect(on.autoAcceptBugs).toBe(true);
    const policy = await readActivePolicy(prisma, { scope: 'PROJECT', scopeId: project.id });
    expect(policy?.level).toBe(2);
    expect(JSON.stringify(policy?.gates)).toContain('"bug"');
    // Resolved: L2 for a bug-only review_accept, nothing else loosened; still clamped by the L0 ceiling until an Admin raises it.
    const view = await loadAutonomyFor(prisma, issue);
    expect(view).toMatchObject({ level: 0, source: 'ceiling', requested: 2, requestedBy: 'project' });

    const off = await updateIssue(prisma, project.id, { autoAcceptBugs: false, expectedRevision: on.revision }, actor);
    expect(off.autoAcceptBugs).toBe(false);
    expect(await readActivePolicy(prisma, { scope: 'PROJECT', scopeId: project.id })).toBeNull();
    // Idempotent: syncing the same state again writes nothing.
    await syncAutoAcceptBugsPolicy(prisma, project.id, false, null);
    expect(await prisma.opsAudit.count({ where: { action: 'policy.changed', subject: `project:${project.id}`, createdAt: { gte: startedAt } } })).toBe(2);
  });
});

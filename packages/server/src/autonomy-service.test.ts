import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.js';
import { loadProjectEnvironment } from '../prisma/env.js';
import { autoAcceptBugsGates, autonomyToGraphQL, clearWorkflowPolicy, loadAutonomyFor, observeLabelFor, readActivePolicy, readAutonomySettings, setWorkflowPolicy, syncAutoAcceptBugsPolicy } from './autonomy-service.js';
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

describe('autonomy settings pages (INV-1489)', () => {
  it('pause reads every scope as L0 with source paused, audited, and unpause restores the ceiling', async () => {
    const { admin, team, issue, startedAt } = await fixture();
    await setWorkflowPolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, level: 3, reason: 'open' }, admin.id);
    await setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 2, reason: 'team' }, admin.id);
    expect((await loadAutonomyFor(prisma, issue)).level).toBe(2);
    await setWorkflowPolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, level: 3, paused: true, reason: 'incident in progress' }, admin.id);
    expect(await loadAutonomyFor(prisma, issue)).toMatchObject({ level: 0, source: 'paused', paused: true, ceiling: 0 });
    const settings = await readAutonomySettings(prisma, { scope: 'TEAM', scopeId: team.id });
    expect(settings).toMatchObject({ ceiling: 0, paused: true });
    // Omitted fields keep the previous version's value: level only, still paused.
    await setWorkflowPolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, level: 2, reason: 'lower' }, admin.id);
    expect((await loadAutonomyFor(prisma, issue)).paused).toBe(true);
    await setWorkflowPolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, level: 2, paused: false, reason: 'resume' }, admin.id);
    expect(await loadAutonomyFor(prisma, issue)).toMatchObject({ level: 2, source: 'team', paused: false });
    const audits = await prisma.opsAudit.findMany({ where: { action: 'policy.changed', subject: `workspace:${WORKSPACE_SETTINGS_ID}`, createdAt: { gte: startedAt } }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((audit) => (audit.details as { to: { paused: boolean } }).to.paused)).toEqual([false, true, true, false]);
  });

  it('templates and default level live on the workspace row only; built-in locks cannot be removed', async () => {
    const { admin, team } = await fixture();
    const fresh = await readAutonomySettings(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID });
    expect(fresh.templates.map((template) => [template.name, template.level])).toEqual([['Low-risk pass-through', 1], ['Bugs on autopilot', 2], ['Hands-off', 3]]);
    expect(fresh.builtInLocks.map((lock) => lock.id)).toEqual(['sev1_sev2_done', 'deploy_or_credentials', 'intermittent_bug']);
    expect(fresh.levels.map((level) => level.name)).toEqual(['L0 Review everything', 'L1 Low-risk pass-through', 'L2 Green-light accept', 'L3 Hands-off']);
    await setWorkflowPolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, level: 2, defaultLevel: 1, templates: [{ name: 'Only bugs', level: 2, gates: autoAcceptBugsGates() }], locked: ['contract_amendment'], reason: 'tune' }, admin.id);
    const saved = await readAutonomySettings(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID });
    expect(saved).toMatchObject({ ceiling: 2, defaultLevel: 1 });
    expect(saved.templates).toEqual([{ name: 'Only bugs', level: 2, gates: autoAcceptBugsGates() }]);
    expect(saved.active?.locked).toEqual(['contract_amendment']);
    // Built-in locks are always reported, whatever the admin lists.
    const { issue } = await fixture();
    expect((await loadAutonomyFor(prisma, issue)).locked).toEqual(expect.arrayContaining(['sev1_sev2_done', 'deploy_or_credentials', 'intermittent_bug', 'contract_amendment']));
    await expect(setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 1, paused: true, reason: 'x' }, admin.id)).rejects.toThrow(/workspace policy only/);
    await expect(setWorkflowPolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, level: 1, templates: [{ name: '', level: 1 }], reason: 'x' }, admin.id)).rejects.toThrow(/templates\[0\]\.name/);
    await expect(setWorkflowPolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, level: 1, locked: ['nope'], reason: 'x' }, admin.id)).rejects.toThrow(/locked names a gate/);
  });

  it('clearing a project override makes it inherit again; history stays and the workspace cannot be cleared', async () => {
    const { admin, team, project, issue } = await fixture();
    await setWorkflowPolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, level: 2, reason: 'c' }, admin.id);
    await setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 2, reason: 't' }, admin.id);
    await setWorkflowPolicy(prisma, { scope: 'PROJECT', scopeId: project.id, level: 0, reason: 'careful' }, admin.id);
    expect((await loadAutonomyFor(prisma, issue)).level).toBe(0);
    expect(await clearWorkflowPolicy(prisma, { scope: 'PROJECT', scopeId: project.id }, 'trust it now', admin.id)).toBe(true);
    expect(await loadAutonomyFor(prisma, issue)).toMatchObject({ level: 2, source: 'team' });
    expect(await clearWorkflowPolicy(prisma, { scope: 'PROJECT', scopeId: project.id }, 'again', admin.id)).toBe(false);
    expect((await readAutonomySettings(prisma, { scope: 'PROJECT', scopeId: project.id })).history).toHaveLength(1);
    await expect(clearWorkflowPolicy(prisma, { scope: 'PROJECT', scopeId: project.id }, '', admin.id)).rejects.toThrow(/reason/);
    await expect(clearWorkflowPolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID }, 'x', admin.id)).rejects.toThrow(/edited, not cleared/);
  });

  it('a Needs you row carries "Would be handled under L<n>" only while observing and only when the level would act', async () => {
    const { admin, team, project } = await fixture();
    const actor = writeActorFromViewer(admin, 'test');
    const bugLabel = await prisma.issueLabel.upsert({ where: { name: 'Bug' }, create: { name: 'Bug' }, update: {} });
    const bug = await createIssue(prisma, { teamId: team.id, title: 'A bug', kind: 'ISSUE', parentId: project.id, repository: 'test/autonomy', priority: 2, labelIds: [bugLabel.id], commitmentStatus: 'CANDIDATE', acceptance: 'Fixed and tested.', description: '### 1. 目标与架构定位\nx\n### 2. 核心功能与交付范围\nx\n### 3. 验收标准与验证方案\nx\n\n### Steps to reproduce\n1. open' }, actor);
    const feature = await createIssue(prisma, { teamId: team.id, title: 'A feature', kind: 'ISSUE', parentId: project.id, repository: 'test/autonomy', priority: 2, commitmentStatus: 'CANDIDATE', acceptance: 'Works.' }, actor);
    const row = { kind: 'CANDIDATE_COMMIT', subjectId: bug.id, workId: bug.id };
    // Not observing: no label, whatever the level.
    expect(await observeLabelFor(prisma, row)).toBeNull();
    await setWorkflowPolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, level: 2, reason: 'c' }, admin.id);
    await setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 1, observeDays: 7, reason: 'try L1' }, admin.id);
    expect(await observeLabelFor(prisma, row)).toMatch(/^Would be handled under L1: type bug/);
    expect(await observeLabelFor(prisma, { kind: 'CANDIDATE_COMMIT', subjectId: feature.id, workId: feature.id })).toBeNull();
    expect(await observeLabelFor(prisma, { kind: 'WORK_REVIEW', subjectId: bug.id, workId: bug.id })).toBeNull();
    // Observing ends: the label goes, the decision was never taken by the policy.
    await setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 1, reason: 'turn on' }, admin.id);
    expect(await observeLabelFor(prisma, row)).toBeNull();
    expect(bug.commitmentStatus).toBe('CANDIDATE');
  });
});

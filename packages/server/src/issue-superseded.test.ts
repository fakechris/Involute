import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.js';
import { loadProjectEnvironment } from '../prisma/env.js';
import { createIssue, updateIssue } from './issue-service.js';
import { buildIssueWhere } from './issue-filter.js';
import { writeActorFromViewer } from './work-service.js';

// INV-1498: "replaced by INV-…" is a field an agent may set, not prose a person retypes.
loadProjectEnvironment();
const prisma = new PrismaClient();

beforeEach(async () => { await resetAndSeed(prisma); });
afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });

const DESCRIPTION = ['### 1. 目标与架构定位', 'x', '### 2. 核心功能与交付范围', 'x', '### 3. 验收标准与验证方案', 'x'].join('\n');

async function fixture() {
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const human = writeActorFromViewer(admin, 'test');
  const agentUser = await prisma.user.create({ data: { name: 'bot', email: `bot-${Date.now()}@agents.test`, actorKind: 'AGENT', ownerId: admin.id } });
  const agent = writeActorFromViewer(agentUser, 'mcp');
  const project = await createIssue(prisma, { teamId: team.id, title: 'P', kind: 'PROJECT', repository: 'test/sup', commitmentStatus: 'COMMITTED' }, human);
  const old = await createIssue(prisma, { teamId: team.id, title: '暂缓：X', kind: 'DECISION', parentId: project.id, repository: 'test/sup', commitmentStatus: 'COMMITTED', acceptance: 'a', description: DESCRIPTION }, human);
  const replacement = await createIssue(prisma, { teamId: team.id, title: '决定：取代 X', kind: 'DECISION', parentId: project.id, repository: 'test/sup', commitmentStatus: 'COMMITTED', acceptance: 'a', description: DESCRIPTION }, human);
  return { admin, team, human, agent, project, old, replacement };
}

describe('superseded_by (INV-1498)', () => {
  it('an agent sets who replaced a committed DECISION by identifier; it is audited and readable', async () => {
    const { agent, old, replacement } = await fixture();
    const updated = await updateIssue(prisma, old.id, { supersededById: replacement.identifier, expectedRevision: old.revision }, agent);
    expect(updated.supersededById).toBe(replacement.id);
    const audit = await prisma.workAudit.findFirst({ where: { workId: old.id, revision: updated.revision } });
    expect((audit?.after as { supersededById?: string }).supersededById).toBe(replacement.id);
    // Clearing works too.
    const cleared = await updateIssue(prisma, old.id, { supersededById: null, expectedRevision: updated.revision }, agent);
    expect(cleared.supersededById).toBeNull();
  });

  it('refuses itself, another team, an unknown item and a loop', async () => {
    const { human, agent, old, replacement } = await fixture();
    await expect(updateIssue(prisma, old.id, { supersededById: old.identifier, expectedRevision: old.revision }, agent)).rejects.toThrow(/by itself/);
    await expect(updateIssue(prisma, old.id, { supersededById: 'INV-999999', expectedRevision: old.revision }, agent)).rejects.toThrow(/not found/i);
    const otherTeam = await prisma.team.create({ data: { key: `OT${Date.now() % 1000}`, name: 'Other' } });
    await prisma.workflowState.create({ data: { teamId: otherTeam.id, name: 'Ready', type: 'UNSTARTED', position: 1 } });
    const foreign = await createIssue(prisma, { teamId: otherTeam.id, title: 'F', kind: 'DECISION', commitmentStatus: 'COMMITTED', acceptance: 'a' }, human);
    await expect(updateIssue(prisma, old.id, { supersededById: foreign.id, expectedRevision: old.revision }, agent)).rejects.toThrow(/same team/);
    // old → replacement, then replacement → old would loop.
    const first = await updateIssue(prisma, old.id, { supersededById: replacement.id, expectedRevision: old.revision }, agent);
    expect(first.supersededById).toBe(replacement.id);
    const fresh = await prisma.issue.findUniqueOrThrow({ where: { id: replacement.id } });
    await expect(updateIssue(prisma, replacement.id, { supersededById: old.id, expectedRevision: fresh.revision }, agent)).rejects.toThrow(/cannot loop/);
  });

  it('a superseded item can still be canceled by a person with the resolution, but not reopened', async () => {
    const { team, human, agent, old, replacement } = await fixture();
    const marked = await updateIssue(prisma, old.id, { supersededById: replacement.id, expectedRevision: old.revision }, agent);
    const canceled = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'CANCELED' } });
    const ready = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'UNSTARTED' } });
    const closed = await updateIssue(prisma, old.id, { stateId: canceled.id, resolution: 'OBSOLETE', reason: `Superseded by ${replacement.identifier}: ${replacement.title}`, expectedRevision: marked.revision }, human);
    expect(closed.resolution).toBe('OBSOLETE');
    await expect(updateIssue(prisma, old.id, { stateId: ready.id, expectedRevision: closed.revision }, human)).rejects.toThrow(/instead of reopening/);
  });

  it('lists keep an item replaced by other work until it is closed, but hide tasks merged into a delivery package (INV-1515)', async () => {
    const { admin, team, human, agent, project, old, replacement } = await fixture();
    await updateIssue(prisma, old.id, { supersededById: replacement.id, expectedRevision: old.revision }, agent);
    // A task merged into a delivery package: its replacement is the package root.
    const root = await createIssue(prisma, { teamId: team.id, title: 'Root', parentId: project.id, repository: 'test/sup', commitmentStatus: 'COMMITTED', acceptance: 'a' }, human);
    await prisma.deliveryPackage.create({ data: { workId: root.id, policy: {}, contractDigest: 'x', approvedById: admin.id } });
    const merged = await createIssue(prisma, { teamId: team.id, title: 'Merged', parentId: project.id, repository: 'test/sup', commitmentStatus: 'COMMITTED', acceptance: 'a' }, human);
    await prisma.issue.update({ where: { id: merged.id }, data: { supersededById: root.id } });

    const listed = await prisma.issue.findMany({ where: { AND: [buildIssueWhere({ commitmentStatus: 'COMMITTED' }, null) ?? {}, { teamId: team.id }] }, select: { identifier: true } });
    const identifiers = listed.map((row) => row.identifier);
    expect(identifiers).toContain(old.identifier);
    expect(identifiers).not.toContain(merged.identifier);
    const all = await prisma.issue.findMany({ where: { AND: [buildIssueWhere({ commitmentStatus: 'COMMITTED', includeSuperseded: true }, null) ?? {}, { teamId: team.id }] }, select: { identifier: true } });
    expect(all.map((row) => row.identifier)).toContain(merged.identifier);
  });
});

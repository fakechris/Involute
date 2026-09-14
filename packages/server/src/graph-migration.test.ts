import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDatabase, DEFAULT_TEAM_KEY } from '../prisma/seed-helpers.ts';
import { createIssue, updateIssue } from './issue-service.ts';
import { applyGraphMigration, previewGraphMigration, rollbackGraphMigration } from './graph-migration.ts';

const prisma = new PrismaClient();
let teamId: string;
const repo = 'fakechris/Involute';
beforeEach(async () => {
  await prisma.workGraphMigration.deleteMany();
  await prisma.issue.deleteMany(); await prisma.workflowState.deleteMany(); await prisma.team.deleteMany();
  await prisma.issueLabel.deleteMany(); await prisma.user.deleteMany(); await prisma.legacyLinearMapping.deleteMany();
  await seedDatabase(prisma);
  teamId = (await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } })).id;
});
afterAll(async () => { await prisma.$disconnect(); });
async function fixture() {
  const oldParent = await createIssue(prisma, { teamId, title: 'Old', kind: 'MILESTONE', repository: 'fakechris/lumenbox' });
  const newParent = await createIssue(prisma, { teamId, title: 'New', kind: 'MILESTONE', repository: repo });
  const child = await createIssue(prisma, { teamId, title: 'Child', repository: repo });
  // Historical malformed graph deliberately bypasses the now-strict application boundary.
  await prisma.issue.update({ where: { id: child.id }, data: { parentId: oldParent.id } });
  const edge = await prisma.workLink.create({ data: { fromId: oldParent.id, toId: child.id, type: 'CONTAINS' } });
  const request = { teamId, reason: 'Repair legacy project membership', entries: [{ id: child.id, expectedRevision: child.revision,
    to: { parentId: newParent.id, kind: child.kind, repository: repo } }] };
  return { child, newParent, oldParent, edge, request };
}

describe('operator graph migrations', () => {
  it('previews with zero writes, applies atomically and repeats idempotently after JSON serialization', async () => {
    const { child, newParent, request } = await fixture();
    const before = await prisma.issue.findUniqueOrThrow({ where: { id: child.id } });
    const audits = await prisma.workAudit.count();
    const plan = await previewGraphMigration(prisma, request);
    expect(await prisma.issue.findUniqueOrThrow({ where: { id: child.id } })).toEqual(before);
    expect(await prisma.workAudit.count()).toBe(audits);
    expect(await prisma.workGraphMigration.count()).toBe(0);
    const first = await applyGraphMigration(prisma, JSON.parse(JSON.stringify(plan)));
    const second = await applyGraphMigration(prisma, JSON.parse(JSON.stringify(plan)));
    expect(first.id).toBe(second.id);
    expect(await prisma.issue.findUniqueOrThrow({ where: { id: child.id } })).toMatchObject({ parentId: newParent.id, revision: child.revision + 1 });
    expect(await prisma.workLink.findMany({ where: { toId: child.id, type: 'CONTAINS' } })).toMatchObject([{ fromId: newParent.id }]);
    expect(await prisma.workAudit.count()).toBe(audits + 1);
  });

  it('rejects a stale preview after an ordinary edit or a target-parent edit', async () => {
    const { child, newParent, request } = await fixture();
    const plan = await previewGraphMigration(prisma, request);
    await updateIssue(prisma, newParent.id, { title: 'changed' });
    await expect(applyGraphMigration(prisma, plan)).rejects.toThrow('stale');
    expect(await prisma.workGraphMigration.count()).toBe(0);
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: child.id } })).revision).toBe(child.revision);
  });

  it('restores the exact old mapping and edge identity while keeping state and history', async () => {
    const { child, oldParent, edge, request } = await fixture();
    const receipt = await applyGraphMigration(prisma, await previewGraphMigration(prisma, request));
    const rollback = await rollbackGraphMigration(prisma, receipt.id);
    expect(rollback.status).toBe('ROLLED_BACK');
    const restored = await prisma.issue.findUniqueOrThrow({ where: { id: child.id } });
    expect(restored).toMatchObject({ parentId: oldParent.id, stateId: child.stateId, revision: child.revision + 2 });
    expect(await prisma.workLink.findUnique({ where: { id: edge.id } })).toEqual(edge);
    expect((await rollbackGraphMigration(prisma, receipt.id)).id).toBe(receipt.id);
    expect((await applyGraphMigration(prisma, JSON.parse(JSON.stringify(receipt.plan)))).status).toBe('ROLLED_BACK');
  });

  it('refuses rollback after a newer edit without resetting that change', async () => {
    const { child, request } = await fixture();
    const receipt = await applyGraphMigration(prisma, await previewGraphMigration(prisma, request));
    await updateIssue(prisma, child.id, { title: 'New human work' });
    await expect(rollbackGraphMigration(prisma, receipt.id)).rejects.toThrow('newer work');
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: child.id } })).title).toBe('New human work');
  });

  it('rejects malformed/duplicate/invalid destinations without any writes', async () => {
    const { child, request } = await fixture();
    await expect(previewGraphMigration(prisma, { ...request, entries: [...request.entries, ...request.entries] })).rejects.toThrow('Duplicate');
    await expect(previewGraphMigration(prisma, { ...request, entries: [{ ...request.entries[0]!, to: { parentId: child.id, kind: 'ISSUE', repository: repo } }] })).rejects.toThrow();
    await expect(applyGraphMigration(prisma, { ...request, version: 999 })).rejects.toThrow();
    expect(await prisma.workGraphMigration.count()).toBe(0);
  });

  it('rolls back the whole batch if audit persistence fails', async () => {
    const { child, request } = await fixture();
    const plan = await previewGraphMigration(prisma, request);
    const database = prisma.$extends({ query: { workAudit: { async create() { throw new Error('injected audit failure'); } } } });
    await expect(applyGraphMigration(database as unknown as PrismaClient, plan)).rejects.toThrow('injected');
    expect(await prisma.workGraphMigration.count()).toBe(0);
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: child.id } })).revision).toBe(child.revision);
  });

  it('serializes duplicate applies into one receipt and one mutation', async () => {
    const { child, request } = await fixture();
    const plan = await previewGraphMigration(prisma, request);
    const [a, b] = await Promise.all([applyGraphMigration(prisma, plan), applyGraphMigration(prisma, plan)]);
    expect(a.id).toBe(b.id);
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: child.id } })).revision).toBe(child.revision + 1);
  });
});

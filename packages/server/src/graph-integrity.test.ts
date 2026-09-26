import { PrismaClient, type WorkKind } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDatabase, DEFAULT_TEAM_KEY } from '../prisma/seed-helpers.ts';
import { createIssue, updateIssue, deleteIssue } from './issue-service.ts';
import { createWorkLink, deleteWorkLink } from './link-service.ts';

const prisma = new PrismaClient();
let teamId: string;
const repo = 'fakechris/Involute';
async function node(kind: WorkKind, repository: string | null = repo, parentId?: string) {
  return createIssue(prisma, { teamId, kind, title: kind, repository, ...(parentId ? { parentId } : {}) });
}
beforeEach(async () => {
  await prisma.issue.deleteMany(); await prisma.workflowState.deleteMany(); await prisma.team.deleteMany();
  await prisma.issueLabel.deleteMany(); await prisma.user.deleteMany(); await prisma.legacyLinearMapping.deleteMany();
  await seedDatabase(prisma);
  teamId = (await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } })).id;
});
afterAll(async () => { await prisma.$disconnect(); });

describe('hierarchy write boundary', () => {
  it('creates both hierarchy representations through issue creation', async () => {
    const parent = await node('PROJECT'); const child = await node('MILESTONE', repo, parent.id);
    expect(await prisma.workLink.findFirst({ where: { fromId: parent.id, toId: child.id, type: 'CONTAINS' } })).not.toBeNull();
  });

  it('rejects invalid kinds, missing repositories and same-team cross-repository contains', async () => {
    const parent = await node('PROJECT');
    for (const child of [await node('PROJECT'), await node('MILESTONE', null), await node('MILESTONE', 'fakechris/lumenbox'), await node('MILESTONE', 'fakechris/involute'), await node('MILESTONE', ' fakechris/Involute ')]) {
      await expect(createWorkLink(prisma, { fromId: parent.id, toId: child.id, type: 'CONTAINS' })).rejects.toThrow();
    }
    const paddedParent = await node('PROJECT', ' owner/repo ');
    const paddedChild = await node('MILESTONE', ' owner/repo ');
    await expect(createWorkLink(prisma, { fromId: paddedParent.id, toId: paddedChild.id, type: 'CONTAINS' })).rejects.toThrow('whitespace');
    expect(await prisma.workLink.count()).toBe(0);
  });

  it('allows the norm v1 hierarchy (INV-718) and still rejects everything else', async () => {
    const project = await node('PROJECT');
    const legal: Array<[WorkKind, WorkKind]> = [
      ['PROJECT', 'ISSUE'], ['PROJECT', 'EPIC'], ['PROJECT', 'DECISION'], ['PROJECT', 'MILESTONE'],
      ['MILESTONE', 'EPIC'], ['MILESTONE', 'ISSUE'], ['EPIC', 'ISSUE'], ['ISSUE', 'ISSUE'],
    ];
    for (const [parentKind, childKind] of legal) {
      const parent = parentKind === 'PROJECT' ? project : await node(parentKind);
      const child = await node(childKind);
      await expect(createWorkLink(prisma, { fromId: parent.id, toId: child.id, type: 'CONTAINS' })).resolves.toBeTruthy();
    }
    const illegal: Array<[WorkKind, WorkKind]> = [
      ['MILESTONE', 'MILESTONE'], ['MILESTONE', 'DECISION'], ['EPIC', 'MILESTONE'], ['ISSUE', 'MILESTONE'],
      ['ISSUE', 'EPIC'], ['DECISION', 'ISSUE'], ['ISSUE', 'PROJECT'],
    ];
    for (const [parentKind, childKind] of illegal) {
      const parent = await node(parentKind);
      const child = await node(childKind);
      await expect(createWorkLink(prisma, { fromId: parent.id, toId: child.id, type: 'CONTAINS' })).rejects.toThrow('CONTAINS allows');
    }
  });

  it('rejects a sub-issue cycle', async () => {
    const a = await node('ISSUE'); const b = await node('ISSUE', repo, a.id);
    await expect(createWorkLink(prisma, { fromId: b.id, toId: a.id, type: 'CONTAINS' })).rejects.toThrow();
  });

  it('rejects a second parent instead of silently replacing an existing parent', async () => {
    const a = await node('MILESTONE'); const b = await node('MILESTONE'); const child = await node('ISSUE');
    await createWorkLink(prisma, { fromId: a.id, toId: child.id, type: 'CONTAINS' });
    await expect(createWorkLink(prisma, { fromId: b.id, toId: child.id, type: 'CONTAINS' })).rejects.toThrow();
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: child.id } })).parentId).toBe(a.id);
  });

  it('permits explicit revision-checked reparenting and records one revision', async () => {
    const a = await node('MILESTONE'); const b = await node('MILESTONE'); const child = await node('ISSUE', repo, a.id);
    const changed = await updateIssue(prisma, child.id, { parentId: b.id, expectedRevision: child.revision });
    expect(changed.revision).toBe(child.revision + 1);
    expect(await prisma.workLink.findMany({ where: { toId: child.id, type: 'CONTAINS' } })).toMatchObject([{ fromId: b.id }]);
  });

  it('validates repository/kind updates against both parents and children', async () => {
    const parent = await node('MILESTONE'); const child = await node('ISSUE', repo, parent.id);
    await expect(updateIssue(prisma, parent.id, { repository: 'fakechris/lumenbox' })).rejects.toThrow();
    await expect(updateIssue(prisma, child.id, { repository: null })).rejects.toThrow();
    await expect(updateIssue(prisma, parent.id, { kind: 'DECISION' })).rejects.toThrow();
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: parent.id } })).kind).toBe('MILESTONE');
  });

  it('increments child revision and records audit when a direct link changes its parent', async () => {
    const parent = await node('MILESTONE'); const child = await node('ISSUE');
    const link = await createWorkLink(prisma, { fromId: parent.id, toId: child.id, type: 'CONTAINS' });
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: child.id } })).revision).toBe(child.revision + 1);
    await deleteWorkLink(prisma, link.id);
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: child.id } })).revision).toBe(child.revision + 2);
    expect(await prisma.workAudit.count({ where: { workId: child.id } })).toBe(3);
  });

  it('detaches and audits children when deleting their parent', async () => {
    const parent = await node('MILESTONE'); const child = await node('ISSUE', repo, parent.id);
    await deleteIssue(prisma, parent.id);
    expect(await prisma.issue.findUniqueOrThrow({ where: { id: child.id } })).toMatchObject({ parentId: null, revision: child.revision + 1 });
    expect(await prisma.workLink.count({ where: { toId: child.id, type: 'CONTAINS' } })).toBe(0);
    expect(await prisma.workAudit.count({ where: { workId: child.id } })).toBe(2);
  });

  it('rereads endpoints after waiting for the graph lock', async () => {
    const parent = await node('MILESTONE'); const child = await node('ISSUE');
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writer = prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${teamId}, 0))`;
      enter(); await gate;
      await tx.issue.update({ where: { id: child.id }, data: { repository: 'fakechris/lumenbox' } });
    }, { timeout: 15_000 });
    await entered;
    const pending = createWorkLink(prisma, { fromId: parent.id, toId: child.id, type: 'CONTAINS' });
    const checked = expect(pending).rejects.toThrow();
    try {
      await vi.waitFor(async () => {
        const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON l.pid=a.pid WHERE NOT l.granted AND l.locktype='advisory' AND a.datname=current_database()`;
        expect(Number(rows[0]!.count)).toBeGreaterThan(0);
      });
    } finally { release(); }
    await writer; await checked;
  });

  it('keeps same-team cross-project BLOCKS and PROJECT to DECISION legal', async () => {
    const a = await node('ISSUE'); const b = await node('ISSUE', 'fakechris/lumenbox');
    await createWorkLink(prisma, { fromId: a.id, toId: b.id, type: 'BLOCKS' });
    const project = await node('PROJECT'); const decision = await node('DECISION');
    await createWorkLink(prisma, { fromId: project.id, toId: decision.id, type: 'CONTAINS' });
  });

  it('cascades repository updates across CONTAINS hierarchy when cascadeRepository is true', async () => {
    const project = await node('PROJECT');
    const milestone = await node('MILESTONE', repo, project.id);
    const child = await node('ISSUE', repo, milestone.id);

    // Attach a WorkRun to child
    const run = await prisma.workRun.create({
      data: {
        publicId: 'RUN-TEST-CASCADE',
        workId: child.id,
        repository: repo,
        status: 'RUNNING',
      },
    });

    const newRepo = 'fakechris/lumen-learn';
    const updated = await updateIssue(prisma, project.id, {
      repository: newRepo,
      cascadeRepository: true,
    });

    expect(updated.repository).toBe(newRepo);

    // Both milestone and child should have been cascaded
    const updatedMilestone = await prisma.issue.findUniqueOrThrow({ where: { id: milestone.id } });
    const updatedChild = await prisma.issue.findUniqueOrThrow({ where: { id: child.id } });
    const updatedRun = await prisma.workRun.findUniqueOrThrow({ where: { id: run.id } });

    expect(updatedMilestone.repository).toBe(newRepo);
    expect(updatedChild.repository).toBe(newRepo);
    expect(updatedRun.repository).toBe(newRepo);

    // Verify audits were recorded for cascaded children
    const milestoneAudits = await prisma.workAudit.findMany({ where: { workId: milestone.id } });
    const childAudits = await prisma.workAudit.findMany({ where: { workId: child.id } });
    expect(milestoneAudits.some((a) => (a.after as { repository?: string })?.repository === newRepo)).toBe(true);
    expect(childAudits.some((a) => (a.after as { repository?: string })?.repository === newRepo)).toBe(true);
  });

  it('rejects cascading repository update if parent node belongs to a different repository', async () => {
    const project = await node('PROJECT');
    const milestone = await node('MILESTONE', repo, project.id);
    const child = await node('ISSUE', repo, milestone.id);

    // Changing milestone without changing project should still fail because project is still `repo`
    await expect(
      updateIssue(prisma, milestone.id, {
        repository: 'fakechris/other-repo',
        cascadeRepository: true,
      }),
    ).rejects.toThrow('CONTAINS cannot cross repository boundaries.');
  });
});


import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { claimWork, commitWork, proposeWork } from './claim-service.ts';
import { createComment } from './issue-service.ts';
import { attachEvidence, reportRun } from './run-service.ts';
import { testParentId } from './test-placement.ts';
import { exportWorkGraph, importWorkGraph, workGraphCounts, WORKGRAPH_TABLES } from './workgraph-transfer.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();

// INV-1007: export, wipe, import — the same graph; import again — nothing changes.
describe('work graph export and import (INV-1007)', () => {
  beforeEach(async () => { await resetAndSeed(prisma); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });

  it('round-trips work, relations, comments, runs, evidence and audits, and is idempotent', async () => {
    const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    const human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    const agent = await prisma.user.create({ data: { name: 'Mover', email: 'mover@agents.local', actorKind: 'AGENT', ownerId: human.id } });
    const humanActor = { actorId: human.id, actorKind: 'HUMAN' as const, surface: 'test' };
    const agentActor = { actorId: agent.id, actorKind: 'AGENT' as const, surface: 'test' };
    const parentId = await testParentId(prisma, team.id);
    const candidate = await proposeWork(prisma, { parentId, teamId: team.id, title: '导出回路', labels: ['feature'], description: '### 1. 目标与架构定位\nx\n### 2. 核心功能与交付范围\nx\n### 3. 验收标准与验证方案\nx' }, agentActor);
    const blocker = await proposeWork(prisma, { parentId, teamId: team.id, title: 'Blocker', blocks: [candidate.identifier] }, humanActor);
    const work = await commitWork(prisma, candidate.id, { acceptance: 'Round trip intact.', assigneeId: human.id, expectedRevision: candidate.revision }, humanActor);
    await createComment(prisma, { issueId: work.id, body: 'Root comment' }, human.id);
    const claim = await claimWork(prisma, work.id, {}, agentActor);
    const { run } = await reportRun(prisma, { workId: work.id, claimToken: claim.claimToken!, status: 'completed', summary: 'Exported and back.', commitSha: 'a'.repeat(40), pullRequestNumber: 7 }, agentActor);
    await attachEvidence(prisma, { workId: work.id, runId: run.id, claimToken: claim.claimToken!, kind: 'PR', url: 'https://github.com/example/project/pull/7' }, agentActor);

    const before = await workGraphCounts(prisma);
    const current = await prisma.issue.findUniqueOrThrow({ where: { id: work.id } });
    const audits = await prisma.workAudit.findMany({ where: { workId: work.id }, orderBy: { revision: 'asc' } });
    expect(audits.length).toBeGreaterThan(1);
    const directory = await mkdtemp(join(tmpdir(), 'involute-workgraph-'));
    try {
      const manifest = await exportWorkGraph(prisma, directory);
      expect(manifest.tables.find((table) => table.table === 'Issue')?.rows).toBe(before.Issue);
      expect(manifest.tables.find((table) => table.table === 'WorkRun')?.columns).not.toContain('executionTokenHash');

      // Wipe everything the export covers (reverse order), then import.
      for (const { table } of [...WORKGRAPH_TABLES].reverse()) await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
      expect((await workGraphCounts(prisma)).Issue).toBe(0);
      const imported = await importWorkGraph(prisma, directory);
      expect(imported.tables.find((table) => table.table === 'Issue')?.inserted).toBe(before.Issue);
      expect(await workGraphCounts(prisma)).toEqual(before);

      const restored = await prisma.issue.findUniqueOrThrow({ where: { id: work.id }, include: { labels: true, comments: true, runs: { include: { evidence: true } }, parent: true } });
      expect(restored).toMatchObject({ identifier: work.identifier, title: '导出回路', acceptance: 'Round trip intact.', revision: current.revision, updatedAt: current.updatedAt, parentId });
      expect(restored.labels.map((label) => label.name.toLowerCase())).toEqual(['feature']);
      expect(restored.comments.map((comment) => comment.body)).toEqual(['Root comment']);
      expect(restored.runs[0]).toMatchObject({ publicId: run.publicId, summary: 'Exported and back.', executionTokenHash: null, claimId: null });
      expect(restored.runs[0]!.evidence.map((item) => item.url)).toEqual(['https://github.com/example/project/pull/7']);
      expect(await prisma.workLink.count({ where: { fromId: blocker.id, toId: work.id, type: 'BLOCKS' } })).toBe(1);
      // Audits keep their actor and time.
      const restoredAudits = await prisma.workAudit.findMany({ where: { workId: work.id }, orderBy: { revision: 'asc' } });
      expect(restoredAudits.map((audit) => [audit.id, audit.actorId, audit.actorKind, audit.createdAt.toISOString()])).toEqual(audits.map((audit) => [audit.id, audit.actorId, audit.actorKind, audit.createdAt.toISOString()]));
      // Search vectors came back through the triggers.
      expect(await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "Issue" WHERE "searchVector" IS NULL`).toEqual([{ n: 0n }]);

      const again = await importWorkGraph(prisma, directory);
      expect(again.tables.every((table) => table.inserted === 0)).toBe(true);
      expect(await workGraphCounts(prisma)).toEqual(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

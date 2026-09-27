import type { Team, User } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { proposeWork, rejectWork } from './claim-service.ts';
import { createIssue } from './issue-service.ts';
import { restoreWork } from './work-restore.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();

describe('restoring rejected work to a candidate (INV-792)', () => {
  let team: Team;
  let admin: User;
  const asHuman = () => ({ actorId: admin.id, actorKind: 'HUMAN' as const, surface: 'graphql' as const });

  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('turns rejected work back into a candidate, audited with the reason', async () => {
    const project = await createIssue(prisma, { teamId: team.id, kind: 'PROJECT', title: 'acme/app', repository: 'acme/app' });
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'Idea', parentId: project.id });
    const rejected = await rejectWork(prisma, candidate.id, { expectedRevision: candidate.revision, reason: 'Not now' }, asHuman());
    expect(rejected.commitmentStatus).toBe('REJECTED');

    const audit0 = await prisma.workAudit.findFirstOrThrow({
      where: { workId: candidate.id, after: { path: ['commitmentStatus'], equals: 'REJECTED' } },
    });
    expect(audit0.reason).toBe('Not now'); // what Issue.rejectionReason shows

    const restored = await restoreWork(prisma, { id: candidate.identifier, reason: 'Rejected by mistake' }, asHuman());
    expect(restored).toMatchObject({ commitmentStatus: 'CANDIDATE', revision: rejected.revision + 1 });
    const audit = await prisma.workAudit.findFirstOrThrow({ where: { workId: candidate.id }, orderBy: { createdAt: 'desc' } });
    expect(audit).toMatchObject({ actorId: admin.id, reason: 'Restored to candidate: Rejected by mistake' });
    expect(await prisma.eventOutbox.count({ where: { type: 'work.restored' } })).toBe(1);
  });

  it('is for people only, needs a reason, and only applies to rejected work', async () => {
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'Idea' });
    await expect(restoreWork(prisma, { id: candidate.id, reason: 'x' }, asHuman())).rejects.toThrow(/Only rejected work/);
    await rejectWork(prisma, candidate.id, { expectedRevision: candidate.revision, reason: 'no' }, asHuman());
    await expect(restoreWork(prisma, { id: candidate.id, reason: '  ' }, asHuman())).rejects.toThrow(/needs a reason/);
    await expect(
      restoreWork(prisma, { id: candidate.id, reason: 'x' }, { actorId: admin.id, actorKind: 'AGENT', surface: 'mcp' }),
    ).rejects.toThrow(/Only a person/);
  });
});

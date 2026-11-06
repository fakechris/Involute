import type { Team } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { proposeWork } from './claim-service.ts';
import { deliveryLinksMissingWarning } from './delivery-links.ts';
import { createIssue } from './issue-service.ts';
import { loadWorkHygiene } from './work-hygiene.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();

// INV-1673: code work that reaches Review must leave the reviewer something to open.
describe('delivery links (INV-1673)', () => {
  let team: Team;
  const repo = 'acme/links';

  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const inReview = async (title: string, extra: Record<string, unknown> = {}) => {
    const review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'REVIEW' } });
    const work = await createIssue(prisma, { teamId: team.id, title, repository: repo, ...extra });
    await prisma.issue.update({ where: { id: work.id }, data: { stateId: review.id, commitmentStatus: 'COMMITTED' } });
    return work;
  };

  it('warns and lists code work with no commit, PR, URL or evidence, until one appears', async () => {
    const bare = await inReview('Fix the gate');
    expect(await deliveryLinksMissingWarning(prisma, bare.id)).toContain(repo);
    let hygiene = await loadWorkHygiene(prisma, { teamId: team.id, teamKey: DEFAULT_TEAM_KEY });
    expect(hygiene.reviewWithoutDeliveryLinks.map((issue) => issue.id)).toEqual([bare.id]);
    expect(hygiene.reviewWithoutDeliveryLinksCount).toBe(1);

    await prisma.workRun.create({ data: { publicId: 'RUN-T1', workId: bare.id, status: 'COMPLETED', commitSha: 'a'.repeat(40) } });
    expect(await deliveryLinksMissingWarning(prisma, bare.id)).toBeNull();
    hygiene = await loadWorkHygiene(prisma, { teamId: team.id, teamKey: DEFAULT_TEAM_KEY });
    expect(hygiene.reviewWithoutDeliveryLinksCount).toBe(0);
  });

  it('counts evidence (a Sentry link) but not retracted evidence', async () => {
    const work = await inReview('Stop the crash');
    const evidence = await prisma.workEvidence.create({ data: { workId: work.id, kind: 'ARTIFACT', url: 'https://acme.sentry.io/issues/42/' } });
    expect(await deliveryLinksMissingWarning(prisma, work.id)).toBeNull();
    await prisma.workEvidence.update({ where: { id: evidence.id }, data: { retractedAt: new Date() } });
    expect(await deliveryLinksMissingWarning(prisma, work.id)).not.toBeNull();
  });

  it('leaves research, incidents and work with no repository alone', async () => {
    const research = await proposeWork(prisma, { teamId: team.id, title: 'Vendor study', labels: ['research'], repository: repo });
    const noRepo = await inReview('Tidy the docs', { repository: null });
    expect(await deliveryLinksMissingWarning(prisma, research.id)).toBeNull();
    expect(await deliveryLinksMissingWarning(prisma, noRepo.id)).toBeNull();
    const hygiene = await loadWorkHygiene(prisma, { teamId: team.id, teamKey: DEFAULT_TEAM_KEY });
    expect(hygiene.reviewWithoutDeliveryLinksCount).toBe(0);
  });
});

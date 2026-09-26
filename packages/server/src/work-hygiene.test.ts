import type { Team } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { proposeWork } from './claim-service.ts';
import { createIssue } from './issue-service.ts';
import { createWorkLink } from './link-service.ts';
import { loadWorkHygiene, researchLacksDownstream } from './work-hygiene.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();

describe('work hygiene and research traceability (INV-721)', () => {
  let team: Team;
  const repo = 'acme/hygiene';

  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const make = (title: string, extra: Record<string, unknown> = {}) =>
    createIssue(prisma, { teamId: team.id, title, repository: repo, ...extra });

  it('labels a proposal, creating the label once and matching case-insensitively', async () => {
    const first = await proposeWork(prisma, { teamId: team.id, title: 'Study A', labels: ['Research', 'research', '  '] });
    const second = await proposeWork(prisma, { teamId: team.id, title: 'Study B', labels: ['RESEARCH'] });
    const labels = await prisma.issueLabel.findMany({ where: { name: { equals: 'research', mode: 'insensitive' } } });
    expect(labels).toHaveLength(1);
    for (const work of [first, second]) {
      const withLabels = await prisma.issue.findUniqueOrThrow({ where: { id: work.id }, include: { labels: true } });
      expect(withLabels.labels.map((label) => label.id)).toEqual([labels[0]!.id]);
    }
  });

  it('creates a new label from concurrent proposals without aborting either transaction', async () => {
    const proposals = await Promise.all(
      Array.from({ length: 4 }, (_, index) => proposeWork(prisma, { teamId: team.id, title: `Race ${index}`, labels: ['race-label'] })),
    );
    const labels = await prisma.issueLabel.findMany({ where: { name: 'race-label' } });
    expect(labels).toHaveLength(1);
    for (const work of proposals) {
      const withLabels = await prisma.issue.findUniqueOrThrow({ where: { id: work.id }, include: { labels: true } });
      expect(withLabels.labels.map((label) => label.id)).toEqual([labels[0]!.id]);
    }
  });

  it('finds unplaced work, unlinked mentions and prose dependencies without BLOCKS', async () => {
    const project = await make(repo, { kind: 'PROJECT' });
    const milestone = await make('M1', { kind: 'MILESTONE', parentId: project.id });
    const placed = await make('Placed', { parentId: milestone.id });
    const loose = await make('Loose');
    // Written without auto-linking, as historical data was.
    const mentioning = await prisma.issue.create({
      data: {
        identifier: `${DEFAULT_TEAM_KEY}-9001`, title: 'Mentions', teamId: team.id, stateId: placed.stateId, repository: repo,
        parentId: milestone.id, description: `依赖 ${loose.identifier} 完成。另见 ${placed.identifier}。`,
      },
    });
    await createWorkLink(prisma, { fromId: milestone.id, toId: mentioning.id, type: 'CONTAINS' });

    const hygiene = await loadWorkHygiene(prisma, { teamId: team.id, teamKey: DEFAULT_TEAM_KEY });
    expect(hygiene.unplaced.map((issue) => issue.identifier)).toEqual([loose.identifier]);
    expect(hygiene.unplacedCount).toBe(1);
    // placed is a sibling under the same milestone — not linked to "mentioning" — so both mentions count.
    expect(hygiene.unlinkedMentions.map((pair) => `${pair.from.identifier}>${pair.to.identifier}`).sort()).toEqual(
      [`${mentioning.identifier}>${loose.identifier}`, `${mentioning.identifier}>${placed.identifier}`].sort(),
    );
    expect(hygiene.dependencyWithoutBlocks.map((pair) => pair.to.identifier)).toEqual([loose.identifier]);

    await createWorkLink(prisma, { fromId: loose.id, toId: mentioning.id, type: 'BLOCKS' });
    const after = await loadWorkHygiene(prisma, { teamId: team.id, teamKey: DEFAULT_TEAM_KEY });
    expect(after.dependencyWithoutBlocksCount).toBe(0);
    expect(after.unlinkedMentions.map((pair) => pair.to.identifier)).toEqual([placed.identifier]);
  });

  it('flags finished research nothing derives from, unless it says there was nothing actionable', async () => {
    const review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'REVIEW' } });
    const research = await proposeWork(prisma, { teamId: team.id, title: 'Competitor study', labels: ['research'] });
    await prisma.issue.update({ where: { id: research.id }, data: { commitmentStatus: 'COMMITTED', stateId: review.id } });
    expect(await researchLacksDownstream(prisma, research.id)).toBe(true);
    expect((await loadWorkHygiene(prisma, { teamId: team.id, teamKey: DEFAULT_TEAM_KEY })).researchWithoutDownstream.map((issue) => issue.id)).toContain(research.id);
    const hygiene = await loadWorkHygiene(prisma, { teamId: team.id, teamKey: DEFAULT_TEAM_KEY });
    expect(hygiene.researchWithoutDownstreamCount).toBe(hygiene.researchWithoutDownstream.length);

    expect(await researchLacksDownstream(prisma, research.id, 'Read three vendors; no actionable points.')).toBe(false);

    const derived = await proposeWork(prisma, { teamId: team.id, title: 'Do the thing', relatedWorkId: research.id, relatedWorkType: 'DERIVED_FROM' });
    expect(derived).toBeTruthy();
    expect(await researchLacksDownstream(prisma, research.id)).toBe(false);

    const plain = await proposeWork(prisma, { teamId: team.id, title: 'Not research' });
    expect(await researchLacksDownstream(prisma, plain.id)).toBe(false);
  });
});

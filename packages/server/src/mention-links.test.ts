import type { Team, User } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { proposeWork } from './claim-service.ts';
import { createComment, createIssue, updateIssue } from './issue-service.ts';
import { createWorkLink } from './link-service.ts';
import { dependencyHints, extractTeamReferences } from './mention-links.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();

describe('extractTeamReferences', () => {
  it('finds team-key and alias references, canonicalised and de-duplicated', () => {
    expect(extractTeamReferences(['see INV-12 and inv-12, LUM-7; not SON-3 or INV-x'], 'INV', ['LUM']).sort()).toEqual(['INV-12', 'INV-7']);
    expect(extractTeamReferences([null, 'INV-007'], 'INV', [])).toEqual(['INV-7']);
  });
});

describe('mention links (INV-720)', () => {
  let team: Team;
  let human: User;

  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const make = (title: string, extra: Record<string, unknown> = {}) => createIssue(prisma, { teamId: team.id, title, ...extra });
  const related = (fromId: string, toId: string) =>
    prisma.workLink.count({ where: { type: 'RELATED_TO', fromId, toId } });

  it('links work mentioned in a new description, once, and never to itself', async () => {
    const target = await make('Target');
    const writer = await make('Writer', { description: `Depends on nothing; see ${target.identifier} and ${target.identifier} again.` });
    expect(await related(writer.id, target.id)).toBe(1);
    const self = await make('Self');
    await updateIssue(prisma, self.id, { description: `I am ${self.identifier}` });
    expect(await prisma.workLink.count({ where: { OR: [{ fromId: self.id }, { toId: self.id }] } })).toBe(0);
  });

  it('adds edges when an edit adds a mention and keeps them when the mention is removed', async () => {
    const target = await make('Target');
    const writer = await make('Writer', { description: 'nothing yet' });
    await updateIssue(prisma, writer.id, { description: `now mentions ${target.identifier}` });
    expect(await related(writer.id, target.id)).toBe(1);
    await updateIssue(prisma, writer.id, { description: 'mention removed' });
    expect(await related(writer.id, target.id)).toBe(1);
  });

  it('does not add RELATED_TO when any link already connects the two', async () => {
    const blocker = await make('Blocker');
    const blocked = await make('Blocked');
    await createWorkLink(prisma, { fromId: blocker.id, toId: blocked.id, type: 'BLOCKS' });
    await updateIssue(prisma, blocked.id, { description: `waits on ${blocker.identifier}` });
    expect(await prisma.workLink.count({ where: { OR: [{ fromId: blocked.id, toId: blocker.id }, { fromId: blocker.id, toId: blocked.id }] } })).toBe(1);
  });

  it('drops the generic RELATED_TO when a specific relation joins the same pair', async () => {
    const upstream = await make('Upstream');
    const work = await make('Work', { description: `see ${upstream.identifier}` });
    expect(await related(work.id, upstream.id)).toBe(1);
    await createWorkLink(prisma, { fromId: upstream.id, toId: work.id, type: 'BLOCKS' });
    expect(await prisma.workLink.findMany({ where: { OR: [{ fromId: work.id }, { toId: work.id }] }, select: { type: true } }))
      .toEqual([{ type: 'BLOCKS' }]);
  });

  it('links mentions in comments, attributed to the commenter', async () => {
    const target = await make('Target');
    const work = await make('Discussed');
    await createComment(prisma, { issueId: work.id, body: `This duplicates ${target.identifier}?` }, human.id);
    const link = await prisma.workLink.findFirstOrThrow({ where: { type: 'RELATED_TO', fromId: work.id, toId: target.id } });
    expect(link.actorId).toBe(human.id);
  });

  it('resolves a project alias prefix to the team identifier', async () => {
    const project = await make('acme/app', { kind: 'PROJECT', repository: 'acme/app' });
    await updateIssue(prisma, project.id, { alias: 'LUM' });
    const target = await make('Target');
    const number = target.identifier.split('-')[1];
    const writer = await make('Writer', { description: `see LUM-${number}` });
    expect(await related(writer.id, target.id)).toBe(1);
  });

  it('records declared dependencies at proposal time, without a shadowing RELATED_TO', async () => {
    const upstream = await make('Upstream');
    const downstream = await make('Downstream');
    const proposed = await proposeWork(prisma, {
      teamId: team.id,
      title: 'Middle',
      description: `After ${upstream.identifier}; unblocks ${downstream.identifier}.`,
      blockedBy: [upstream.identifier],
      blocks: [downstream.id],
    });
    expect(await prisma.workLink.count({ where: { type: 'BLOCKS', fromId: upstream.id, toId: proposed.id } })).toBe(1);
    expect(await prisma.workLink.count({ where: { type: 'BLOCKS', fromId: proposed.id, toId: downstream.id } })).toBe(1);
    expect(await prisma.workLink.count({ where: { type: 'RELATED_TO', OR: [{ fromId: proposed.id }, { toId: proposed.id }] } })).toBe(0);
  });

  it('rolls the whole proposal back when a declared blocker does not exist', async () => {
    const before = await prisma.issue.count();
    await expect(proposeWork(prisma, { teamId: team.id, title: 'Doomed', blockedBy: ['INV-99999'] })).rejects.toThrow();
    expect(await prisma.issue.count()).toBe(before);
  });

  it('hints at dependencies written in prose but not recorded as BLOCKS', async () => {
    const prereq = await make('Prereq');
    const other = await make('Other');
    const work = await make('Work', { description: `依赖 ${prereq.identifier} 完成。另见 ${other.identifier}。` });
    const texts = [work.description];
    expect(await dependencyHints(prisma, { id: work.id, teamId: team.id, texts })).toEqual([prereq.identifier]);
    await createWorkLink(prisma, { fromId: prereq.id, toId: work.id, type: 'BLOCKS' });
    expect(await dependencyHints(prisma, { id: work.id, teamId: team.id, texts })).toEqual([]);
    // Clause-scoped: the wording must be about this reference.
    const later = await make('Later');
    expect(await dependencyHints(prisma, { id: work.id, teamId: team.id, texts: [`先做 ${later.identifier} 完成后再开始`] })).toEqual([later.identifier]);
    expect(await dependencyHints(prisma, { id: work.id, teamId: team.id, texts: [`blocked by ${other.identifier}, unrelated to ${later.identifier}`] })).toEqual([other.identifier]);
  });
});

/**
 * A small work graph for looking at the neighbourhood view by eye:
 *
 *   fakechris/Involute (PROJECT)
 *     └─ INV-1 Graph visualisation (MILESTONE)
 *          └─ INV-2 /graph for a project (EPIC)
 *               ├─ INV-3 The item you are looking at (ISSUE)   ← the focus
 *               │    ├─ INV-4 A child of the focus
 *               │    └─ INV-5 Another child, blocked
 *               ├─ INV-6 A sibling, in progress
 *               └─ INV-7 A sibling, done
 *
 * INV-8 blocks INV-3 (an open blocker) and INV-3 blocks INV-9.
 */
import { PrismaClient } from '@prisma/client';

import { seedDatabase } from '../prisma/seed-helpers.ts';

const prisma = new PrismaClient();

async function main() {
  await seedDatabase(prisma);
  const team = await prisma.team.findUniqueOrThrow({ where: { key: 'INV' } });
  const state = async (name: string) =>
    prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, name } });
  const ready = await state('Ready');
  const started = await state('In Progress');
  const review = await state('In Review');
  const done = await state('Done');

  // Start from a clean graph so the demo is what it says it is.
  await prisma.workLink.deleteMany();
  await prisma.issue.deleteMany({ where: { repository: 'fakechris/Involute' } });

  let counter = 0;
  const make = async (title: string, extra: Record<string, unknown> = {}) => {
    counter += 1;
    return prisma.issue.create({
      data: {
        identifier: `INV-${counter}`,
        title,
        teamId: team.id,
        stateId: ready.id,
        repository: 'fakechris/Involute',
        commitmentStatus: 'COMMITTED',
        ...extra,
      },
    });
  };
  const contains = async (parentId: string, childId: string) =>
    prisma.workLink.create({ data: { type: 'CONTAINS', fromId: parentId, toId: childId } });
  const blocks = async (fromId: string, toId: string) =>
    prisma.workLink.create({ data: { type: 'BLOCKS', fromId: fromId, toId: toId } });

  const project = await make('fakechris/Involute Work-Graph Kernel', { kind: 'PROJECT' });
  const milestone = await make('Graph visualisation: outline, dependencies, timeline', { kind: 'MILESTONE' });
  const epic = await make('/graph for one project', { kind: 'EPIC' });
  const focus = await make('Neighbourhood graph on the issue page', { stateId: started.id });
  const childA = await make('Read the neighbourhood of one item');
  const childB = await make('Roll the milestone up by state', { stateId: review.id });
  const siblingA = await make('Depth control that follows the URL', { stateId: started.id });
  const siblingB = await make('Dependency edges that say what they mean', { stateId: done.id });
  const blocker = await make('The work graph read for one item', { stateId: started.id });
  const dependent = await make('The full graph view for one item', { stateId: ready.id });

  await contains(project.id, milestone.id);
  await contains(milestone.id, epic.id);
  await contains(epic.id, focus.id);
  await contains(epic.id, siblingA.id);
  await contains(epic.id, siblingB.id);
  await contains(focus.id, childA.id);
  await contains(focus.id, childB.id);
  await blocks(blocker.id, focus.id);
  await blocks(focus.id, dependent.id);
  // The second child waits on something unfinished.
  await blocks(blocker.id, childB.id);

  console.log(`focus: ${focus.identifier} ${focus.title}`);
  console.log(`blocker: ${blocker.identifier}`);
  console.log(`siblings: ${siblingA.identifier}, ${siblingB.identifier}`);
  console.log(`children: ${childA.identifier}, ${childB.identifier}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

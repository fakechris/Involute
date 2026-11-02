/**
 * A small work graph for looking at the neighbourhood view by eye:
 *
 *   Demo: Neighbourhood demo (PROJECT)
 *     └─ Demo: Graph visualisation (MILESTONE)
 *          └─ Demo: /graph for one project (EPIC)
 *               ├─ Demo: The item you are looking at (ISSUE)   ← the focus
 *               │    ├─ Demo: A child of the focus
 *               │    └─ Demo: Another child, blocked
 *               ├─ Demo: A sibling, in progress
 *               └─ Demo: A sibling, done
 *
 * The blocker blocks the focus (an open blocker) and the focus blocks one
 * dependent.
 *
 * The demo owns its rows three ways over: a title prefix, a repository of its
 * own, and identifiers taken from the team's own counter, so the reset below
 * can never reach real work. The script also refuses to run against a
 * database that is not clearly disposable.
 */
import { PrismaClient } from '@prisma/client';

import { seedDatabase } from '../prisma/seed-helpers.ts';

const prisma = new PrismaClient();

/** The repository the demo owns; nothing else is ever written or deleted. */
const DEMO_REPOSITORY = 'demo/neighbourhood';
/** Every demo item carries this prefix, so the reset finds exactly its own rows. */
const DEMO_TITLE_PREFIX = 'Demo: ';

/**
 * Refuses to reset a database that may hold real work.
 *
 * The demo replaces the graph under it, so running it against a database with
 * live work items would destroy them. A database is only considered disposable
 * when its name says so (`*_test`) or when the operator says so explicitly.
 */
function assertDisposableDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  let dbName = '';
  try {
    dbName = new URL(url).pathname.replace(/^\//, '');
  } catch {
    dbName = '';
  }
  const disposable = /_test$/i.test(dbName) || process.env.ALLOW_DEMO_SEED === 'true';
  if (!disposable) {
    throw new Error(
      `Refusing to reset the graph in database '${dbName || 'unknown'}'. ` +
        'Point DATABASE_URL at a *_test database, or set ALLOW_DEMO_SEED=true to say out loud that it is disposable.',
    );
  }
}

async function main() {
  assertDisposableDatabase();
  await seedDatabase(prisma);
  const team = await prisma.team.findUniqueOrThrow({ where: { key: 'INV' } });
  const state = async (name: string) =>
    prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, name } });
  const ready = await state('Ready');
  const started = await state('In Progress');
  const review = await state('In Review');
  const done = await state('Done');

  // Start from a clean demo graph so the demo is what it says it is. The reset
  // only touches rows this script wrote; the links go with the items, because
  // WorkLink rows cascade when their item is deleted.
  await prisma.issue.deleteMany({
    where: { teamId: team.id, repository: DEMO_REPOSITORY, title: { startsWith: DEMO_TITLE_PREFIX } },
  });

  /**
   * The identifier comes from the team's own counter, the same one the product
   * uses, so the demo can never collide with a real work item's number — and
   * the product simply continues after the demo's numbers.
   */
  const allocateIdentifier = async (): Promise<string> => {
    const updated = await prisma.team.update({
      where: { id: team.id },
      data: { nextIssueNumber: { increment: 1 } },
      select: { key: true, nextIssueNumber: true },
    });
    return `${updated.key.toUpperCase()}-${updated.nextIssueNumber - 1}`;
  };

  const make = async (title: string, extra: Record<string, unknown> = {}) => {
    const identifier = await allocateIdentifier();
    return prisma.issue.create({
      data: {
        identifier,
        title: `${DEMO_TITLE_PREFIX}${title}`,
        teamId: team.id,
        stateId: ready.id,
        repository: DEMO_REPOSITORY,
        commitmentStatus: 'COMMITTED',
        ...extra,
      },
    });
  };

  /** CONTAINS also writes the parent pointer, the way the link service does. */
  const contains = async (parentId: string, childId: string) => {
    await prisma.workLink.create({ data: { type: 'CONTAINS', fromId: parentId, toId: childId } });
    await prisma.issue.update({ where: { id: childId }, data: { parentId } });
  };
  const blocks = async (fromId: string, toId: string) =>
    prisma.workLink.create({ data: { type: 'BLOCKS', fromId, toId } });

  const project = await make('Neighbourhood demo', { kind: 'PROJECT' });
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

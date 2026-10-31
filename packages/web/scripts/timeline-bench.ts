/**
 * Before/after for the /graph timeline at the size of the largest project the
 * server allows (2000 nodes). Run with:
 *   node --experimental-strip-types packages/web/scripts/timeline-bench.ts
 */
import { buildBlockerIndex, buildOutline, openBlockersOf } from '../src/work/graph-model.ts';
import { containerSpan, containerSpans, cumulativeSeries, timeRange } from '../src/work/timeline-model.ts';

type Any = any;

function build(n: number) {
  const nodes: Any[] = [];
  const edges: Any[] = [];
  const push = (id: string, kind: string, parent: string | null) => {
    nodes.push({
      id,
      identifier: id,
      title: `item ${id}`,
      kind,
      commitmentStatus: 'COMMITTED',
      stateName: 'Ready',
      stateType: 'UNSTARTED',
      assigneeName: null,
      external: false,
    });
    if (parent) edges.push({ id: `c-${parent}-${id}`, type: 'CONTAINS', fromId: parent, toId: id });
  };

  push('PROJECT', 'PROJECT', null);
  const milestones = Array.from({ length: 8 }, (_, i) => `M${i}`);
  milestones.forEach((m) => push(m, 'MILESTONE', 'PROJECT'));
  const epics = Array.from({ length: 24 }, (_, i) => `E${i}`);
  epics.forEach((e, i) => push(e, 'EPIC', milestones[i % milestones.length]));
  const leaves = n - 1 - milestones.length - epics.length;
  for (let i = 0; i < leaves; i += 1) push(`L${i}`, 'ISSUE', epics[i % epics.length]);
  for (let i = 0; i < leaves; i += 3) edges.push({ id: `b-${i}`, type: 'BLOCKS', fromId: `L${i}`, toId: `L${Math.max(0, i - 1)}` });
  return { nodes, edges };
}

function entriesFor(ids: string[]) {
  const map = new Map<string, Any>();
  for (const id of ids) {
    const committed = new Date('2026-09-09T15:00:00Z');
    const started = new Date('2026-09-12T10:00:00Z');
    const done = new Date('2026-09-25T10:00:00Z');
    map.set(id, {
      workId: id,
      committedAt: committed,
      startedAt: started,
      reviewAt: new Date('2026-09-22T10:00:00Z'),
      completedAt: done,
      canceledAt: null,
      transitions: [
        { at: committed, stateName: 'Ready', stateType: 'UNSTARTED' },
        { at: started, stateName: 'In Progress', stateType: 'STARTED' },
        { at: new Date('2026-09-22T10:00:00Z'), stateName: 'In Review', stateType: 'REVIEW' },
        { at: done, stateName: 'Done', stateType: 'COMPLETED' },
      ],
      history: 'FULL',
    });
  }
  return map;
}

function flatten(items: any[], out: any[] = []): any[] {
  for (const item of items) {
    out.push(item);
    if (item.children.length) flatten(item.children, out);
  }
  return out;
}

const now = new Date('2026-10-30T00:00:00Z');
const ROUNDS = 3;

/**
 * One warm-up run that is thrown away, then the fastest of ROUNDS. A single
 * cold sample measures the JIT as much as the algorithm, and whichever path
 * runs first pays for it — so both sides are measured the same way.
 */
function fastest(run: () => void): number {
  run();
  let lowest = Number.POSITIVE_INFINITY;
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = performance.now();
    run();
    lowest = Math.min(lowest, performance.now() - start);
  }
  return lowest;
}

console.log('nodes  edges  | blockers: per-row scan  index | containers: per-container  batch | cumulative');

for (const n of [500, 1000, 2000]) {
  const { nodes, edges } = build(n);
  const byId = new Map(nodes.map((nd) => [nd.id, nd]));
  const entries = entriesFor(nodes.map((nd) => nd.id));
  const outline = buildOutline(nodes, edges, 'PROJECT');
  const rows = flatten([...outline.roots, ...outline.unplaced]);

  const scanMs = fastest(() => {
    for (const row of rows) openBlockersOf(row.node.id, edges, byId);
  });

  const indexMs = fastest(() => {
    const index = buildBlockerIndex(edges, byId);
    for (const row of rows) index.get(row.node.id);
  });

  const perContainerMs = fastest(() => {
    for (const row of rows) if (row.children.length) containerSpan(row, entries, now);
  });

  const batchMs = fastest(() => {
    containerSpans([...outline.roots, ...outline.unplaced], entries, now);
  });

  const range = timeRange([...entries.values()], now, 'week');
  const cumulativeMs = fastest(() => {
    cumulativeSeries([...entries.values()], range);
  });

  console.log(
    [
      String(n).padStart(5),
      String(edges.length).padStart(6),
      `| ${scanMs.toFixed(1).padStart(6)}ms ${indexMs.toFixed(1).padStart(6)}ms`,
      `| ${perContainerMs.toFixed(1).padStart(8)}ms ${batchMs.toFixed(1).padStart(6)}ms`,
      `| ${cumulativeMs.toFixed(1)}ms`,
    ].join(' '),
  );
}

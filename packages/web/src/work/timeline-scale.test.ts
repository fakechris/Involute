/**
 * The timeline's cost at the size of the largest project the server allows
 * (2000 nodes, INV-1443). Every project view asks the same two questions of
 * every row — which blockers gate it, and how far its container reaches — so
 * this measures that work per frame and fails if it starts scaling the way a
 * per-row scan does.
 */
import { describe, expect, it } from 'vitest';

import { buildBlockerIndex, buildOutline, openBlockersOf, type GraphEdge, type GraphNode } from './graph-model';
import { containerSpan, containerSpans, type TimelineEntry } from './timeline-model';

const NOW = new Date('2026-10-30T00:00:00Z');

function project(size: number): { nodes: GraphNode[]; edges: GraphEdge[]; entries: Map<string, TimelineEntry> } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const entries = new Map<string, TimelineEntry>();
  const node = (id: string, kind: GraphNode['kind']): GraphNode => ({
    id,
    identifier: id.toUpperCase(),
    title: id,
    kind,
    commitmentStatus: 'COMMITTED',
    stateName: 'Ready',
    stateType: 'UNSTARTED',
    assigneeName: null,
    external: false,
  });

  nodes.push(node('p', 'PROJECT'));
  const milestones = 8;
  for (let index = 0; index < milestones; index += 1) {
    nodes.push(node(`m${index}`, 'MILESTONE'));
    edges.push({ id: `cp${index}`, type: 'CONTAINS', fromId: 'p', toId: `m${index}` });
  }
  const leaves = size - 1 - milestones;
  for (let index = 0; index < leaves; index += 1) {
    const id = `l${index}`;
    nodes.push(node(id, 'ISSUE'));
    edges.push({ id: `cm${index}`, type: 'CONTAINS', fromId: `m${index % milestones}`, toId: id });
    if (index % 3 === 0) edges.push({ id: `b${index}`, type: 'BLOCKS', fromId: id, toId: `l${Math.max(0, index - 1)}` });
    entries.set(id, {
      workId: id,
      committedAt: new Date('2026-09-09T15:00:00Z'),
      startedAt: new Date('2026-09-12T10:00:00Z'),
      reviewAt: null,
      completedAt: index % 2 === 0 ? new Date('2026-09-25T10:00:00Z') : null,
      canceledAt: null,
      transitions: [
        { at: new Date('2026-09-09T15:00:00Z'), stateName: 'Ready', stateType: 'UNSTARTED' },
        { at: new Date('2026-09-12T10:00:00Z'), stateName: 'In Progress', stateType: 'STARTED' },
        ...(index % 2 === 0 ? [{ at: new Date('2026-09-25T10:00:00Z'), stateName: 'Done', stateType: 'COMPLETED' as const }] : []),
      ],
      history: 'FULL',
    });
  }
  return { nodes, edges, entries };
}

describe('timeline at the node limit', () => {
  const size = 2000;
  const { nodes, edges, entries } = project(size);
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const outline = buildOutline(nodes, edges, 'p');
  const items = [...outline.roots, ...outline.unplaced];

  it('answers every row from one index instead of scanning the edges per row', () => {
    const indexed = (): number => {
      const index = buildBlockerIndex(edges, byId);
      let count = 0;
      for (const item of nodes) count += (index.get(item.id) ?? []).length;
      return count;
    };
    const scanned = (): number => {
      let count = 0;
      for (const item of nodes) count += openBlockersOf(item.id, edges, byId).length;
      return count;
    };

    // Same answer, and the indexed way is the one the views use.
    expect(indexed()).toBe(scanned());

    // Both paths are measured the same way: one warm-up run that is thrown
    // away, then the fastest of three. A single cold run measures the JIT as
    // much as the algorithm, and whichever path runs first pays for it.
    const fastest = (run: () => number): number => {
      run();
      let lowest = Number.POSITIVE_INFINITY;
      for (let round = 0; round < 3; round += 1) {
        const start = performance.now();
        run();
        lowest = Math.min(lowest, performance.now() - start);
      }
      return lowest;
    };
    const indexedMs = fastest(indexed);
    const scannedMs = fastest(scanned);

    // A per-row scan is quadratic in the edges; the index is one pass. The
    // margin is wide on purpose: CI machines are slower than the numbers here.
    expect(indexedMs).toBeLessThan(20);
    expect(indexedMs * 3).toBeLessThan(scannedMs);
  });

  it('builds every container extent in one pass', () => {
    const spans = containerSpans(items, entries, NOW);
    for (const container of items) {
      expect(spans.get(container.node.id)).toEqual(containerSpan(container, entries, NOW));
    }
  });
});

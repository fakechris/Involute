import { describe, expect, it } from 'vitest';

import type { GraphEdge, GraphNode } from './graph-model';
import { buildNeighbourhood, toRollupLine } from './neighbourhood-model';

function node(id: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    identifier: id.toUpperCase(),
    title: `Work ${id}`,
    kind: 'ISSUE',
    commitmentStatus: 'COMMITTED',
    stateName: 'Ready',
    stateType: 'UNSTARTED',
    assigneeName: null,
    external: false,
    ...extra,
  };
}

function contains(from: string, to: string): GraphEdge {
  return { id: `c-${from}-${to}`, type: 'CONTAINS', fromId: from, toId: to };
}

function blocks(from: string, to: string): GraphEdge {
  return { id: `b-${from}-${to}`, type: 'BLOCKS', fromId: from, toId: to };
}

describe('buildNeighbourhood', () => {
  const nodes = [
    node('project', { kind: 'PROJECT' }),
    node('milestone', { kind: 'MILESTONE' }),
    node('focus'),
    node('sibling'),
    node('child'),
    node('blocker'),
    node('dependent'),
    node('far'),
  ];
  const edges = [
    contains('project', 'milestone'),
    contains('milestone', 'focus'),
    contains('milestone', 'sibling'),
    contains('focus', 'child'),
    blocks('blocker', 'focus'),
    blocks('focus', 'dependent'),
  ];

  it('splits the neighbourhood into the six questions a reader asks', () => {
    const neighbourhood = buildNeighbourhood(nodes, edges, 'focus');
    expect(neighbourhood).not.toBeNull();
    expect(neighbourhood!.ancestors.map((item) => item.id)).toEqual(['project', 'milestone']);
    expect(neighbourhood!.siblings.map((item) => item.id)).toEqual(['sibling']);
    expect(neighbourhood!.children.map((item) => item.id)).toEqual(['child']);
    expect(neighbourhood!.blockers.map((item) => item.id)).toEqual(['blocker']);
    expect(neighbourhood!.dependents.map((item) => item.id)).toEqual(['dependent']);
  });

  it('reads the chain from the top down, so the first ancestor is the root', () => {
    const neighbourhood = buildNeighbourhood(nodes, edges, 'focus');
    expect(neighbourhood!.ancestors[0]!.id).toBe('project');
    expect(neighbourhood!.ancestors[1]!.id).toBe('milestone');
  });

  it('puts the open blocker first — it is the one that matters', () => {
    const withTwo = [
      node('focus'),
      node('finished-blocker', { stateType: 'COMPLETED', stateName: 'Done' }),
      node('open-blocker', { stateType: 'STARTED', stateName: 'In Progress' }),
    ];
    const neighbourhood = buildNeighbourhood(
      withTwo,
      [blocks('finished-blocker', 'focus'), blocks('open-blocker', 'focus')],
      'focus',
    );
    expect(neighbourhood!.blockers.map((item) => item.id)).toEqual(['open-blocker', 'finished-blocker']);
  });

  it('has no siblings and no ancestors when the item stands alone', () => {
    const alone = [node('lonely')];
    const neighbourhood = buildNeighbourhood(alone, [], 'lonely');
    expect(neighbourhood!.ancestors).toEqual([]);
    expect(neighbourhood!.siblings).toEqual([]);
    expect(neighbourhood!.children).toEqual([]);
    expect(neighbourhood!.blockers).toEqual([]);
    expect(neighbourhood!.dependents).toEqual([]);
  });

  it('says nothing when the focus is not in the picture', () => {
    expect(buildNeighbourhood(nodes, edges, 'absent')).toBeNull();
  });

  it('ignores work that shares no link with the focus', () => {
    const neighbourhood = buildNeighbourhood(nodes, edges, 'focus');
    const mentioned = [...neighbourhood!.siblings, ...neighbourhood!.children, ...neighbourhood!.blockers];
    expect(mentioned.map((item) => item.id)).not.toContain('far');
  });
});

describe('toRollupLine', () => {
  it('reads a rollup as a fraction and a plain sentence', () => {
    const line = toRollupLine({
      id: 'm1',
      identifier: 'INV-1',
      title: 'M1',
      kind: 'MILESTONE',
      total: 8,
      completed: 3,
      inProgress: 2,
      blocked: 1,
      canceled: 0,
    });
    expect(line.ratio).toBeCloseTo(3 / 8);
    expect(line.label).toBe('3 of 8 done');
  });

  it('has no progress to speak of when nothing sits under it', () => {
    const line = toRollupLine({
      id: 'm1',
      identifier: 'INV-1',
      title: 'M1',
      kind: 'MILESTONE',
      total: 0,
      completed: 0,
      inProgress: 0,
      blocked: 0,
      canceled: 0,
    });
    expect(line.ratio).toBe(0);
    expect(line.label).toBe('nothing under it yet');
  });
});

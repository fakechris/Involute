import { describe, expect, it } from 'vitest';

import type { WorkflowStateType } from '../board/types';
import {
  blockNeighbourhood,
  buildOutline,
  classifyBlockEdge,
  layoutDag,
  LAYOUT,
  milestoneIndex,
  rollUpToMilestones,
  type GraphEdge,
  type GraphNode,
} from './graph-model';

function node(id: string, stateType: WorkflowStateType = 'UNSTARTED', extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    identifier: id.toUpperCase(),
    title: id,
    kind: 'ISSUE',
    commitmentStatus: 'COMMITTED',
    stateName: stateType,
    stateType,
    assigneeName: null,
    external: false,
    ...extra,
  };
}

let edgeSeq = 0;
function edge(fromId: string, toId: string, type: GraphEdge['type'] = 'BLOCKS'): GraphEdge {
  edgeSeq += 1;
  return { id: `e${edgeSeq}`, type, fromId, toId };
}

describe('classifyBlockEdge', () => {
  it('is open while the blocker is open and the blocked work waits', () => {
    expect(classifyBlockEdge(node('a', 'STARTED'), node('b', 'UNSTARTED'))).toBe('open');
  });

  it('is violated when blocked work started before its blocker closed', () => {
    expect(classifyBlockEdge(node('a', 'STARTED'), node('b', 'STARTED'))).toBe('violated');
    expect(classifyBlockEdge(node('a', 'UNSTARTED'), node('b', 'REVIEW'))).toBe('violated');
    expect(classifyBlockEdge(node('a', 'BACKLOG'), node('b', 'COMPLETED'))).toBe('violated');
  });

  it('is resolved once the blocker is Done or Canceled, or when it is only a candidate', () => {
    expect(classifyBlockEdge(node('a', 'COMPLETED'), node('b', 'STARTED'))).toBe('resolved');
    expect(classifyBlockEdge(node('a', 'CANCELED'), node('b', 'UNSTARTED'))).toBe('resolved');
    expect(classifyBlockEdge(node('a', 'STARTED', { commitmentStatus: 'CANDIDATE' }), node('b', 'STARTED'))).toBe('resolved');
  });
});

describe('buildOutline', () => {
  const project = node('p', 'STARTED', { kind: 'PROJECT' });
  const milestone = node('m', 'STARTED', { kind: 'MILESTONE' });
  const done = node('i1', 'COMPLETED');
  const doing = node('i2', 'STARTED');
  const loose = node('loose', 'BACKLOG');
  const edges = [edge('p', 'm', 'CONTAINS'), edge('m', 'i1', 'CONTAINS'), edge('m', 'i2', 'CONTAINS')];

  it('nests CONTAINS under the root and rolls leaf states up to containers', () => {
    const outline = buildOutline([project, milestone, done, doing, loose], edges, 'p');
    expect(outline.roots).toHaveLength(1);
    const [root] = outline.roots;
    expect(root!.children.map((child) => child.node.id)).toEqual(['m']);
    expect(root!.children[0]!.children.map((child) => child.node.id)).toEqual(['i1', 'i2']);
    expect(root!.rollup).toEqual({ COMPLETED: 1, STARTED: 1 });
    expect(root!.leafCount).toBe(2);
  });

  it('lists in-scope work the root does not reach instead of dropping it', () => {
    const outline = buildOutline([project, milestone, done, doing, loose], edges, 'p');
    expect(outline.unplaced.map((item) => item.node.id)).toEqual(['loose']);
  });

  it('keeps a stray subtree together and survives a CONTAINS cycle', () => {
    const outline = buildOutline(
      [project, node('x'), node('y'), node('c1'), node('c2')],
      [edge('x', 'y', 'CONTAINS'), edge('c1', 'c2', 'CONTAINS'), edge('c2', 'c1', 'CONTAINS')],
      'p',
    );
    const ids = outline.unplaced.map((item) => item.node.id);
    expect(ids).toContain('x');
    expect(ids).not.toContain('y');
    expect(outline.unplaced.find((item) => item.node.id === 'x')!.children[0]!.node.id).toBe('y');
    expect(ids.filter((id) => id === 'c1' || id === 'c2')).toHaveLength(1);
  });

  it('never places external nodes in the outline', () => {
    const outline = buildOutline([project, node('ext', 'STARTED', { external: true })], [], 'p');
    expect(outline.unplaced).toEqual([]);
  });
});

describe('blockNeighbourhood', () => {
  const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('x', 'c'), edge('c', 'y', 'RELATED_TO')];

  it('walks upstream and downstream along BLOCKS only, bounded by hops', () => {
    expect([...blockNeighbourhood('c', edges, 1)].sort()).toEqual(['b', 'c', 'd', 'x']);
    expect([...blockNeighbourhood('c', edges, Infinity)].sort()).toEqual(['a', 'b', 'c', 'd', 'x']);
  });
});

describe('milestone roll-up', () => {
  const nodes = [
    node('m1', 'STARTED', { kind: 'MILESTONE' }),
    node('m2', 'UNSTARTED', { kind: 'MILESTONE' }),
    node('a', 'STARTED'),
    node('b', 'COMPLETED'),
    node('c', 'STARTED'),
    node('solo', 'UNSTARTED'),
  ];
  const edges = [
    edge('m1', 'a', 'CONTAINS'),
    edge('m1', 'b', 'CONTAINS'),
    edge('m2', 'c', 'CONTAINS'),
    edge('a', 'c'),
    edge('b', 'c'),
    edge('a', 'b'),
    edge('c', 'solo'),
  ];

  it('finds the nearest milestone for each node', () => {
    const index = milestoneIndex(nodes, edges);
    expect(index.get('a')?.id).toBe('m1');
    expect(index.get('solo')).toBeNull();
    expect(index.get('m2')?.id).toBe('m2');
  });

  it('lifts BLOCKS to milestones, drops intra-milestone edges, keeps the worst status', () => {
    const rollup = rollUpToMilestones(nodes, edges);
    const summary = rollup.edges.map((lifted) => `${lifted.fromId}>${lifted.toId}:${lifted.count}:${lifted.status}`).sort();
    expect(summary).toEqual(['m1>m2:2:violated', 'm2>solo:1:open']);
    expect(rollup.nodes.map((item) => item.id).sort()).toEqual(['m1', 'm2', 'solo']);
  });
});

describe('layoutDag', () => {
  it('places each node one column right of its deepest blocker', () => {
    const layout = layoutDag(['a', 'b', 'c', 'd'], [edge('a', 'b'), edge('b', 'd'), edge('a', 'd'), edge('c', 'd')]);
    expect(layout.nodes.get('a')!.layer).toBe(0);
    expect(layout.nodes.get('b')!.layer).toBe(1);
    // c only gates d, so it sits just left of d.
    expect(layout.nodes.get('c')!.layer).toBe(1);
    expect(layout.nodes.get('d')!.layer).toBe(2);
    expect(layout.nodes.get('d')!.x).toBe(LAYOUT.padding + 2 * (LAYOUT.nodeWidth + LAYOUT.columnGap));
    expect(layout.width).toBe(LAYOUT.padding * 2 + 3 * LAYOUT.nodeWidth + 2 * LAYOUT.columnGap);
  });

  it('gives every node in a layer its own row', () => {
    const layout = layoutDag(['a', 'b', 'c'], []);
    const rows = [...layout.nodes.values()].map((item) => item.y).sort((left, right) => left - right);
    expect(new Set(rows).size).toBe(3);
  });

  it('orders a layer to follow its blockers, reducing crossings', () => {
    // a1 -> b2 and a2 -> b1 would cross if b kept input order.
    const layout = layoutDag(['a1', 'a2', 'b1', 'b2'], [edge('a1', 'b2'), edge('a2', 'b1')]);
    expect(layout.nodes.get('b2')!.order).toBe(layout.nodes.get('a1')!.order);
    expect(layout.nodes.get('b1')!.order).toBe(layout.nodes.get('a2')!.order);
  });

  it('pulls a source next to its earliest dependent instead of column 0', () => {
    // chain a -> b -> c -> d, and late prerequisite x only gates d.
    const layout = layoutDag(['a', 'b', 'c', 'd', 'x'], [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('x', 'd')]);
    expect(layout.nodes.get('x')!.layer).toBe(2);
    expect(layout.nodes.get('a')!.layer).toBe(0);
  });

  it('terminates on a cycle', () => {
    const layout = layoutDag(['a', 'b'], [edge('a', 'b'), edge('b', 'a')]);
    expect(layout.nodes.size).toBe(2);
  });
});

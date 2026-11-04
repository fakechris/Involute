import { describe, expect, it } from 'vitest';

import type { GraphEdge, GraphNode } from './graph-model';
import { buildNeighbourhood } from './neighbourhood-model';
import { layoutNeighbourhood, type PlacedNode } from './neighbourhood-layout';

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

const SIZE = { width: 360, height: 300 };

function layoutOf(nodes: GraphNode[], edges: GraphEdge[], focusId = 'focus', caps = {}) {
  const neighbourhood = buildNeighbourhood(nodes, edges, focusId);
  expect(neighbourhood).not.toBeNull();
  return layoutNeighbourhood({ neighbourhood: neighbourhood!, edges, ...SIZE, caps });
}

function spot(layout: ReturnType<typeof layoutOf>, id: string): PlacedNode {
  const found = layout.nodes.find((item) => item.id === id);
  expect(found).toBeDefined();
  return found!;
}

describe('layoutNeighbourhood', () => {
  const nodes = [
    node('project', { kind: 'PROJECT' }),
    node('milestone', { kind: 'MILESTONE' }),
    node('focus'),
    node('sibling'),
    node('child'),
    node('blocker'),
    node('dependent'),
  ];
  const edges = [
    contains('project', 'milestone'),
    contains('milestone', 'focus'),
    contains('milestone', 'sibling'),
    contains('focus', 'child'),
    blocks('blocker', 'focus'),
    blocks('focus', 'dependent'),
  ];

  it('puts the focus in the middle and every other item around it', () => {
    const layout = layoutOf(nodes, edges);
    const hub = spot(layout, 'focus');
    expect(hub.role).toBe('focus');
    expect(hub.x).toBe(SIZE.width / 2);
    expect(hub.y).toBe(SIZE.height / 2);
    expect(layout.nodes.filter((item) => item.role === 'focus')).toHaveLength(1);
    expect(layout.nodes).toHaveLength(7);
  });

  it('gives every role its own sector, so a role reads from where it sits', () => {
    const layout = layoutOf(nodes, edges);
    // Ancestors above, siblings to the left, children below.
    expect(spot(layout, 'project').y).toBeLessThan(spot(layout, 'focus').y);
    expect(spot(layout, 'sibling').x).toBeLessThan(spot(layout, 'focus').x);
    expect(spot(layout, 'child').y).toBeGreaterThan(spot(layout, 'focus').y);
    // Dependencies on the right: the blocker above, the dependent below.
    expect(spot(layout, 'blocker').x).toBeGreaterThan(spot(layout, 'focus').x);
    expect(spot(layout, 'dependent').x).toBeGreaterThan(spot(layout, 'focus').x);
    expect(spot(layout, 'blocker').y).toBeLessThan(spot(layout, 'dependent').y);
  });

  it('keeps the sectors apart, so two roles never land on the same spot', () => {
    const layout = layoutOf(nodes, edges);
    const roles = ['project', 'sibling', 'child', 'blocker', 'dependent'];
    const seen = roles.map((id) => {
      const item = spot(layout, id);
      return `${item.role}:${Math.round(item.angle / 10) * 10}`;
    });
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('draws contains from the parent to the focus and to each sibling', () => {
    const layout = layoutOf(nodes, edges);
    const kindOf = (id: string) => layout.edges.find((edge) => edge.id === id)?.kind;
    expect(kindOf('c-milestone-focus')).toBe('hierarchy');
    expect(kindOf('c-project-milestone')).toBe('hierarchy');
    expect(kindOf('c-focus-child')).toBe('hierarchy');
    const siblingEdge = layout.edges.find((edge) => edge.id === 'c-milestone-sibling');
    expect(siblingEdge).toMatchObject({ kind: 'hierarchy', fromId: 'milestone', toId: 'sibling' });
    expect(layout.edges.some((edge) => edge.fromId === 'focus' && edge.toId === 'sibling')).toBe(false);
    // The parent fan (the focus and its siblings) is labelled once.
    const containsLabels = layout.edges.filter((edge) => edge.label === 'contains');
    expect(containsLabels.map((edge) => edge.toId).sort()).toEqual(['child', 'focus']);
    // The blocker is open work, so its edge says so.
    expect(kindOf('b-blocker-focus')).toBe('open');
    expect(kindOf('b-focus-dependent')).toBe('open');
  });

  it('colours a dependency that was started too early as violated', () => {
    const started = [node('focus', { stateType: 'STARTED', stateName: 'In Progress' }), node('blocker', { stateType: 'STARTED', stateName: 'In Progress' })];
    const layout = layoutOf(started, [blocks('blocker', 'focus')]);
    expect(layout.edges.find((edge) => edge.id === 'b-blocker-focus')?.kind).toBe('violated');
  });

  it('says how many items a sector could not show instead of dropping them', () => {
    const many = [node('focus'), node('s1'), node('s2'), node('s3'), node('s4')];
    const manyEdges = [
      contains('focus', 's1'),
      contains('focus', 's2'),
      contains('focus', 's3'),
      contains('focus', 's4'),
    ];
    const layout = layoutOf(many, manyEdges, 'focus', { child: 2 });
    expect(layout.nodes.filter((item) => item.role === 'child')).toHaveLength(2);
    expect(layout.hidden.child).toBe(2);
    expect(layout.hidden.sibling).toBe(0);
  });

  it('draws the same map every time', () => {
    const first = layoutOf(nodes, edges);
    const second = layoutOf(nodes, edges);
    expect(second.nodes.map((item) => `${item.id}:${item.x}:${item.y}`)).toEqual(
      first.nodes.map((item) => `${item.id}:${item.x}:${item.y}`),
    );
    expect(second.edges.map((item) => item.path)).toEqual(first.edges.map((item) => item.path));
  });

  it('draws an empty neighbourhood rather than failing', () => {
    const layout = layoutOf([node('lonely')], [], 'lonely');
    expect(layout.nodes).toHaveLength(1);
    expect(layout.edges).toHaveLength(0);
  });
});

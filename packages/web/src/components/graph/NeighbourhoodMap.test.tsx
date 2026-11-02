import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NeighbourhoodMap } from './NeighbourhoodMap';
import type { GraphEdge, GraphNode } from '../../work/graph-model';

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

const nodes = [
  node('project', { kind: 'PROJECT' }),
  node('milestone', { kind: 'MILESTONE' }),
  node('focus'),
  node('sibling'),
  node('sibling2'),
  node('child'),
  node('blocker'),
  node('dependent'),
];

const edges = [
  contains('project', 'milestone'),
  contains('milestone', 'focus'),
  contains('milestone', 'sibling'),
  contains('milestone', 'sibling2'),
  contains('focus', 'child'),
  blocks('blocker', 'focus'),
  blocks('focus', 'dependent'),
];

afterEach(cleanup);

describe('NeighbourhoodMap', () => {
  it('draws the focus and everything around it, each with its number', () => {
    render(<NeighbourhoodMap nodes={nodes} edges={edges} focusId="focus" />);
    expect(screen.getByText('FOCUS')).toBeTruthy();
    expect(screen.getByText('MILESTONE')).toBeTruthy();
    expect(screen.getByText('SIBLING')).toBeTruthy();
    expect(screen.getByText('CHILD')).toBeTruthy();
    expect(screen.getByText('BLOCKER')).toBeTruthy();
    expect(screen.getByText('DEPENDENT')).toBeTruthy();
  });

  it('scales with its container instead of fixing a size', () => {
    const { container } = render(<NeighbourhoodMap nodes={nodes} edges={edges} focusId="focus" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 360 250');
  });

  it('picks a node when it is clicked', () => {
    const onSelect = vi.fn();
    render(<NeighbourhoodMap nodes={nodes} edges={edges} focusId="focus" onSelect={onSelect} />);
    fireEvent.click(screen.getByLabelText('BLOCKER Work blocker'));
    expect(onSelect).toHaveBeenCalledWith('blocker');
  });

  it('lights the edges that touch the hovered node and fades the rest', () => {
    const { container } = render(<NeighbourhoodMap nodes={nodes} edges={edges} focusId="focus" />);
    fireEvent.mouseEnter(screen.getByLabelText('BLOCKER Work blocker'));
    const fadedEdges = container.querySelectorAll('.issue-neighbourhood__map-edge--faded');
    const litEdges = container.querySelectorAll('.issue-neighbourhood__map-edge:not(.issue-neighbourhood__map-edge--faded)');
    // The blocker's own edge stays lit; the others fade back.
    expect(litEdges.length).toBe(1);
    expect(fadedEdges.length).toBeGreaterThan(0);
    const fadedNodes = container.querySelectorAll('.issue-neighbourhood__map-node--faded');
    expect(fadedNodes.length).toBeGreaterThan(0);
  });

  it('counts each role in the key, and says how many it could not show', () => {
    render(
      <NeighbourhoodMap nodes={nodes} edges={edges} focusId="focus" caps={{ sibling: 1, child: 4 }} />,
    );
    expect(screen.getByText(/1 sibling \(\+1\)/)).toBeTruthy();
    expect(screen.getByText(/1 child/)).toBeTruthy();
    expect(screen.getByText(/2 ancestors/)).toBeTruthy();
  });

  it('says nothing about a role that is not there', () => {
    render(<NeighbourhoodMap nodes={[node('focus')]} edges={[]} focusId="focus" />);
    expect(screen.queryByText(/siblings/)).toBeNull();
    expect(screen.getByText('FOCUS')).toBeTruthy();
  });
});

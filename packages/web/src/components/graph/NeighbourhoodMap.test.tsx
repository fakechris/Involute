import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NeighbourhoodMap } from './NeighbourhoodMap';
import { WorkReferenceProvider } from '../WorkReference';
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

// The work card behind a node (INV-1544) asks the server like a reference in text.
vi.mock('@apollo/client/react', () => {
  const client = {
    query: (options: { variables: { identifiers: string[] } }) =>
      Promise.resolve({
        data: {
          issuePreviews: options.variables.identifiers.map((reference) => ({
            id: reference.toLowerCase(),
            reference,
            identifier: reference,
            title: `Work ${reference.toLowerCase()}`,
            stateName: 'In Review',
            stateType: 'REVIEW',
            commitmentStatus: 'COMMITTED',
            priority: 0,
            kind: 'ISSUE',
            repository: 'fakechris/Involute',
            teamKey: 'INV',
            typeLabel: 'Feature',
            excerpt: 'What the sibling delivers.',
            updatedAt: '2026-11-01T00:00:00.000Z',
          })),
        },
      }),
  };
  return { useApolloClient: () => client };
});

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
    expect(screen.getByText(/1 same parent \(\+1 more\)/)).toBeTruthy();
    expect(screen.getByText(/1 sub-issue/)).toBeTruthy();
    expect(screen.getByText(/2 parent chain/)).toBeTruthy();
    expect(screen.getByText(/1 blocks this/)).toBeTruthy();
    expect(screen.getByText(/1 blocked by this/)).toBeTruthy();
    // The key says what an arrow means, in words (INV-1546).
    expect(screen.getByText(/A → B: A contains B \(parent\), or A blocks B/)).toBeTruthy();
  });

  it('says nothing about a role that is not there', () => {
    render(<NeighbourhoodMap nodes={[node('focus')]} edges={[]} focusId="focus" />);
    expect(screen.queryByText(/same parent/)).toBeNull();
    expect(screen.getByText('FOCUS')).toBeTruthy();
  });
  it('shows the same work card as a reference in text when a node is hovered, not a native tooltip (INV-1544)', async () => {
    const { container } = render(
      <WorkReferenceProvider>
        <NeighbourhoodMap nodes={nodes} edges={edges} focusId="focus" />
      </WorkReferenceProvider>,
    );
    expect(container.querySelector('title')).toBeNull();
    const sibling = screen.getByRole('button', { name: 'SIBLING Work sibling' });
    fireEvent.mouseEnter(sibling);
    const card = await screen.findByRole('tooltip');
    expect(card).toHaveTextContent('SIBLING');
    expect(card).toHaveTextContent('In Review');
    expect(card).toHaveTextContent('What the sibling delivers.');
    expect(sibling).toHaveAttribute('aria-describedby', card.id);
  });
  it('tells roles apart by shape and links by arrow and label, not colour alone (INV-1546)', () => {
    const { container } = render(<NeighbourhoodMap nodes={nodes} edges={edges} focusId="focus" />);
    const shapeOf = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name} `) }).firstElementChild!.tagName;
    expect(shapeOf('MILESTONE')).toBe('rect');
    expect(shapeOf('BLOCKER')).toBe('polygon');
    expect(shapeOf('DEPENDENT')).toBe('polygon');
    expect(shapeOf('CHILD')).toBe('circle');

    // Blocker → focus and focus → dependent carry an arrowhead and the word "blocks".
    const blockEdge = container.querySelector('[data-edge-from="blocker"][data-edge-to="focus"]')!;
    expect(blockEdge.querySelector('path')!.getAttribute('marker-end')).toMatch(/^url\(#/);
    expect(blockEdge).toHaveTextContent('blocks');
    expect(container.querySelector('[data-edge-from="focus"][data-edge-to="dependent"]')).toHaveTextContent('blocks');
    // The parent points at its child, labelled "parent"; a peer is a plain dashed hint.
    const parentEdge = container.querySelector('[data-edge-from="milestone"][data-edge-to="focus"]')!;
    expect(parentEdge).toHaveTextContent('parent');
    const peer = container.querySelector('[data-edge-kind="peer"]')!;
    expect(peer.querySelector('path')!.getAttribute('marker-end')).toBeNull();
    expect(peer.textContent).toBe('');
  });

  it('draws an item once, in its strongest role: a sibling that blocks is a blocker (INV-1546)', () => {
    const withSiblingBlocker = [...edges, blocks('sibling', 'focus')];
    render(<NeighbourhoodMap nodes={nodes} edges={withSiblingBlocker} focusId="focus" />);
    expect(screen.getAllByRole('button', { name: /^SIBLING / })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^SIBLING / }).firstElementChild!.tagName).toBe('polygon');
    expect(screen.getByText(/2 block this/)).toBeTruthy();
  });
});

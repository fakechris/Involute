import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IssueNeighbourhood } from './IssueNeighbourhood';

const { mockUseQuery, navigate } = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (document: unknown, options?: { variables?: { id?: string; depth?: number } }) => {
    mockUseQuery(document, options);
    return { data: graph, loading: false, error: undefined };
  },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

const graph = {
  issueGraph: {
    focus: {
      id: 'focus',
      identifier: 'INV-1496',
      title: 'Neighbourhood graph',
      kind: 'ISSUE',
      commitmentStatus: 'COMMITTED',
      state: { id: 's1', name: 'In Progress', type: 'STARTED' },
      assignee: { id: 'u1', name: 'Astra' },
    },
    nodes: [
      {
        id: 'milestone',
        identifier: 'INV-680',
        title: 'Project work graph visualisation',
        kind: 'MILESTONE',
        commitmentStatus: 'COMMITTED',
        state: { id: 's2', name: 'In Progress', type: 'STARTED' },
        assignee: null,
      },
      {
        id: 'epic',
        identifier: 'INV-681',
        title: '/graph for a project',
        kind: 'EPIC',
        commitmentStatus: 'COMMITTED',
        state: { id: 's2', name: 'In Progress', type: 'STARTED' },
        assignee: null,
      },
      {
        id: 'focus',
        identifier: 'INV-1496',
        title: 'Neighbourhood graph',
        kind: 'ISSUE',
        commitmentStatus: 'COMMITTED',
        state: { id: 's1', name: 'In Progress', type: 'STARTED' },
        assignee: { id: 'u1', name: 'Astra' },
      },
      {
        id: 'sibling',
        identifier: 'INV-1497',
        title: 'A sibling under the same parent',
        kind: 'ISSUE',
        commitmentStatus: 'COMMITTED',
        state: { id: 's3', name: 'Ready', type: 'UNSTARTED' },
        assignee: null,
      },
      {
        id: 'child',
        identifier: 'INV-1498',
        title: 'A child',
        kind: 'ISSUE',
        commitmentStatus: 'COMMITTED',
        state: { id: 's3', name: 'Ready', type: 'UNSTARTED' },
        assignee: null,
      },
      {
        id: 'blocker',
        identifier: 'INV-1400',
        title: 'The thing in the way',
        kind: 'ISSUE',
        commitmentStatus: 'COMMITTED',
        state: { id: 's1', name: 'In Progress', type: 'STARTED' },
        assignee: null,
      },
    ],
    ancestors: [
      {
        id: 'milestone',
        identifier: 'INV-680',
        title: 'Project work graph visualisation',
        kind: 'MILESTONE',
        commitmentStatus: 'COMMITTED',
        state: { id: 's2', name: 'In Progress', type: 'STARTED' },
        assignee: null,
      },
      {
        id: 'epic',
        identifier: 'INV-681',
        title: '/graph for a project',
        kind: 'EPIC',
        commitmentStatus: 'COMMITTED',
        state: { id: 's2', name: 'In Progress', type: 'STARTED' },
        assignee: null,
      },
    ],
    edges: [
      { id: 'e1', type: 'CONTAINS', fromId: 'milestone', toId: 'epic' },
      { id: 'e2', type: 'CONTAINS', fromId: 'epic', toId: 'focus' },
      { id: 'e3', type: 'CONTAINS', fromId: 'epic', toId: 'sibling' },
      { id: 'e4', type: 'CONTAINS', fromId: 'focus', toId: 'child' },
      { id: 'e5', type: 'BLOCKS', fromId: 'blocker', toId: 'focus' },
    ],
    rollups: [
      {
        id: 'epic',
        identifier: 'INV-681',
        title: '/graph for a project',
        kind: 'EPIC',
        total: 8,
        completed: 3,
        inProgress: 2,
        blocked: 1,
        canceled: 0,
      },
    ],
    truncated: false,
  },
};

afterEach(() => {
  cleanup();
  mockUseQuery.mockClear();
  navigate.mockClear();
});

describe('IssueNeighbourhood', () => {
  it('reads the progress of the milestone the item sits in', () => {
    render(<IssueNeighbourhood issueId="focus" issueIdentifier="INV-1496" onOpen={() => {}} />);
    expect(screen.getByText('3 of 8 done')).toBeTruthy();
    expect(screen.getByText('2 in flight')).toBeTruthy();
    expect(screen.getByText('1 stuck')).toBeTruthy();
  });

  it('shows the chain above the item, its peers and what waits under it', () => {
    render(<IssueNeighbourhood issueId="focus" issueIdentifier="INV-1496" onOpen={() => {}} />);
    expect(screen.getByText('INV-680')).toBeTruthy();
    // The epic is both an ancestor in the spine and the container the rollup
    // is measured over, so it is named twice.
    expect(screen.getAllByText('INV-681').length).toBeGreaterThan(0);
    expect(screen.getByText('INV-1497')).toBeTruthy();
    expect(screen.getByText('INV-1498')).toBeTruthy();
  });

  it('names what the item waits on', () => {
    render(<IssueNeighbourhood issueId="focus" issueIdentifier="INV-1496" onOpen={() => {}} />);
    expect(screen.getByText('The thing in the way')).toBeTruthy();
  });

  it('opens another item when a row is clicked', () => {
    const onOpen = vi.fn();
    render(<IssueNeighbourhood issueId="focus" issueIdentifier="INV-1496" onOpen={onOpen} />);
    fireEvent.click(screen.getByLabelText('Open INV-1400 The thing in the way'));
    expect(onOpen).toHaveBeenCalledWith('blocker');
  });

  it('points at the full graph for the item', () => {
    render(<IssueNeighbourhood issueId="focus" issueIdentifier="INV-1496" onOpen={() => {}} />);
    fireEvent.click(screen.getByText('Open full graph'));
    expect(navigate).toHaveBeenCalledWith('/graph?scope=issue&focus=INV-1496');
  });
});

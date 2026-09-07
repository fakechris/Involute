import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CyclesPage } from './CyclesPage';

const mockRunIssueCreate = vi.fn();
const mockRunIssueUpdate = vi.fn();
const mockRunIssueDelete = vi.fn();

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
});

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn((document) => {
    const docStr = JSON.stringify(document);

    if (docStr.includes('BoardPage')) {
      return {
        data: {
          teams: {
            nodes: [
              {
                id: 'team-1',
                key: 'INV',
                name: 'Involute',
                states: {
                  nodes: [
                    { id: 'state-1', name: 'Backlog', type: 'BACKLOG' },
                    { id: 'state-2', name: 'In Progress', type: 'STARTED' },
                    { id: 'state-3', name: 'Done', type: 'COMPLETED' },
                  ],
                },
              },
            ],
          },
        },
        loading: false,
      };
    }

    if (docStr.includes('MilestoneIssues')) {
      return {
        data: {
          issues: {
            nodes: [
              {
                id: 'milestone-1',
                identifier: 'INV-10',
                title: 'Beta Release',
                description: 'First testable milestone',
                outcome: 'Beta ready',
                scope: 'Engine',
                acceptance: 'Zero errors',
                priority: 1,
                kind: 'MILESTONE',
                createdAt: '2026-04-01T10:00:00.000Z',
                updatedAt: '2026-04-01T10:00:00.000Z',
                state: { id: 'state-2', name: 'In Progress', type: 'STARTED', position: 1 },
                assignee: { id: 'user-1', name: 'Admin', email: 'admin@involute.local' },
                team: { id: 'team-1', key: 'INV', name: 'Involute' },
                children: {
                  nodes: [
                    {
                      id: 'child-1',
                      identifier: 'INV-11',
                      title: 'Implement auth',
                      kind: 'ISSUE',
                      state: { id: 'state-3', name: 'Done', type: 'COMPLETED' },
                      assignee: { id: 'user-1', name: 'Admin' },
                    },
                    {
                      id: 'child-2',
                      identifier: 'INV-12',
                      title: 'Add test suite',
                      kind: 'ISSUE',
                      state: { id: 'state-2', name: 'In Progress', type: 'STARTED' },
                      assignee: null,
                    },
                  ],
                },
              },
            ],
          },
        },
        loading: false,
        refetch: vi.fn(),
      };
    }

    // Default CYCLES_QUERY
    return {
      data: {
        cycles: {
          nodes: [
            {
              id: 'cycle-1',
              name: 'Sprint 1',
              number: 1,
              startsAt: '2026-04-01T00:00:00.000Z',
              endsAt: '2026-04-15T00:00:00.000Z',
              issues: { nodes: [] },
              createdAt: '2026-04-01T00:00:00.000Z',
              updatedAt: '2026-04-01T00:00:00.000Z',
            },
          ],
        },
      },
      loading: false,
      refetch: vi.fn(),
    };
  }),
  useMutation: vi.fn((document) => {
    const docStr = JSON.stringify(document);
    if (docStr.includes('IssueCreate')) {
      return [mockRunIssueCreate, { loading: false }];
    }
    if (docStr.includes('IssueUpdate')) {
      return [mockRunIssueUpdate, { loading: false }];
    }
    if (docStr.includes('IssueDelete')) {
      return [mockRunIssueDelete, { loading: false }];
    }
    return [vi.fn(), { loading: false }];
  }),
}));

describe('CyclesPage', () => {
  it('renders Work Graph Milestones by default', () => {
    render(
      <MemoryRouter>
        <CyclesPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Milestones')).toBeInTheDocument();
    expect(screen.getByText('INV-10')).toBeInTheDocument();
    expect(screen.getByText('Beta Release')).toBeInTheDocument();
    expect(screen.getByText('Implement auth')).toBeInTheDocument();
    expect(screen.getByText('1/2 (50%)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Work context' })).toBeInTheDocument();
  });

  it('switches to Legacy Cycles tab when clicked', () => {
    render(
      <MemoryRouter>
        <CyclesPage />
      </MemoryRouter>,
    );

    const cyclesTab = screen.getByRole('button', { name: 'Cycles (Legacy)' });
    fireEvent.click(cyclesTab);

    expect(screen.getByText('Sprint 1')).toBeInTheDocument();
  });
});

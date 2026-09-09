import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CandidatesPage } from './CandidatesPage';

const mockRunCommit = vi.fn();
const mockRunReject = vi.fn();
const mockRunSnooze = vi.fn();
const mockRunLink = vi.fn();
const mockRefetch = vi.fn().mockResolvedValue(undefined);
const mockFetchMore = vi.fn().mockResolvedValue(undefined);

const candidateItems = [
  {
    id: 'cand-1',
    identifier: 'INV-40',
    title: 'Deploy VPS onto immutable image SHA',
    description: 'Docker immutable build',
    commitmentStatus: 'CANDIDATE',
    kind: 'ISSUE',
    revision: 1,
    outcome: 'Immutable deploy',
    scope: 'ops',
    constraints: null,
    acceptance: 'Deploy verified',
    verification: 'pnpm smoke:prod',
    repository: 'fakechris/Involute',
    createdAt: '2026-09-09T09:38:00.000Z',
    snoozedUntil: null,
    team: { id: 'team-1', key: 'INV' },
    assignee: null,
  },
  {
    id: 'cand-2',
    identifier: 'INV-21',
    title: 'Search across every agent and thread',
    description: 'Transcripts search',
    commitmentStatus: 'CANDIDATE',
    kind: 'ISSUE',
    revision: 1,
    outcome: 'Fast thread search',
    scope: 'search',
    constraints: null,
    acceptance: 'Typing finds messages',
    verification: null,
    repository: 'fakechris/lumenbox',
    createdAt: '2026-09-09T09:19:00.000Z',
    snoozedUntil: null,
    team: { id: 'team-1', key: 'INV' },
    assignee: null,
  },
];

const mockTeams = [
  {
    id: 'team-1',
    key: 'INV',
    memberships: {
      nodes: [
        {
          id: 'mem-1',
          user: {
            id: 'user-admin',
            name: 'Admin User',
            email: 'admin@involute.local',
            actorKind: 'HUMAN',
          },
        },
      ],
    },
  },
];

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRunCommit.mockResolvedValue({
    data: {
      workCommit: {
        success: true,
        issue: { id: 'cand-1', identifier: 'INV-40', revision: 2 },
      },
    },
  });
  mockRunReject.mockResolvedValue({
    data: {
      workReject: {
        success: true,
        issue: { id: 'cand-2', identifier: 'INV-21', revision: 2 },
      },
    },
  });
});

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn(() => ({
    data: {
      issues: {
        nodes: candidateItems,
        pageInfo: { endCursor: null, hasNextPage: false },
      },
      teams: {
        nodes: mockTeams,
      },
    },
    loading: false,
    error: undefined,
    refetch: mockRefetch,
    fetchMore: mockFetchMore,
  })),
  useMutation: vi.fn((mutation) => {
    // If it's commit mutation
    return [mockRunCommit, { loading: false }];
  }),
}));

describe('CandidatesPage', () => {
  it('renders project switcher tabs and filters by project', async () => {
    render(
      <MemoryRouter>
        <CandidatesPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Candidates' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /All Projects/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /fakechris\/Involute/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /fakechris\/lumenbox/ })).toBeInTheDocument();

    expect(screen.getByText('INV-40')).toBeInTheDocument();
    expect(screen.getByText('INV-21')).toBeInTheDocument();

    // Click project tab "fakechris/Involute"
    fireEvent.click(screen.getByRole('tab', { name: /fakechris\/Involute/ }));
    expect(screen.getByText('INV-40')).toBeInTheDocument();
    expect(screen.queryByText('INV-21')).not.toBeInTheDocument();
  });

  it('supports multi-select checkboxes and batch commit', async () => {
    render(
      <MemoryRouter>
        <CandidatesPage />
      </MemoryRouter>,
    );

    // Select all visible
    const selectAllCheckbox = screen.getByLabelText(/Select all visible/);
    fireEvent.click(selectAllCheckbox);

    // Both candidates selected
    expect(screen.getByText(/selected/)).toBeInTheDocument();
    const batchCommitBtn = screen.getByRole('button', { name: /Batch Commit \(2\)/ });
    expect(batchCommitBtn).toBeInTheDocument();

    // Trigger batch commit
    fireEvent.click(batchCommitBtn);

    await waitFor(() => expect(mockRunCommit).toHaveBeenCalledTimes(2));
    expect(mockRunCommit).toHaveBeenCalledWith({
      variables: {
        id: 'cand-1',
        input: {
          expectedRevision: 1,
          acceptance: 'Deploy verified',
          assigneeId: 'user-admin',
        },
      },
    });
    expect(mockRunCommit).toHaveBeenCalledWith({
      variables: {
        id: 'cand-2',
        input: {
          expectedRevision: 1,
          acceptance: 'Typing finds messages',
          assigneeId: 'user-admin',
        },
      },
    });
  });
});

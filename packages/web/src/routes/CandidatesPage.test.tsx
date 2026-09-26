import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CandidatesPage } from './CandidatesPage';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-probe">{location.pathname + location.search}</output>;
}

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
    parent: { id: 'm-1', identifier: 'INV-716', title: 'Norm v1', kind: 'MILESTONE' },
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

// Mutable holder so individual tests can swap the query result; the page
// re-renders (and re-calls useQuery) after its assignee-init effect, so
// mockReturnValueOnce is not reliable here.
const { queryDataHolder } = vi.hoisted(() => ({
  queryDataHolder: { current: null as null | { issues: unknown; teams: unknown } },
}));

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

const placementOptions = {
  projects: { nodes: [{ id: 'p-lum', identifier: 'INV-96', title: 'fakechris/lumenbox', kind: 'PROJECT' }] },
  milestones: { nodes: [{ id: 'm-lum', identifier: 'INV-141', title: 'Browser and computer use', kind: 'MILESTONE' }] },
  epics: { nodes: [] },
};

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn((document: { loc?: { source?: { body?: string } } }) => document.loc?.source?.body?.includes('query PlacementOptions') ? {
    data: placementOptions,
    loading: false,
  } : ({
    data: queryDataHolder.current ?? {
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

  it('shows commit-target badges for backlog candidates, distinguishing parked from default', () => {
    const backlogCandidates = [
      {
        ...candidateItems[0],
        id: 'cand-b1',
        identifier: 'INV-50',
        title: 'Explicitly parked candidate',
        repository: 'fakechris/Involute',
        source: 'initial_state=BACKLOG',
        state: { id: 'st-backlog', name: 'Backlog', type: 'BACKLOG', position: 0 },
      },
      {
        ...candidateItems[1],
        id: 'cand-b2',
        identifier: 'INV-51',
        title: 'Default-landed backlog candidate',
        repository: 'fakechris/Involute',
        source: null,
        state: { id: 'st-backlog', name: 'Backlog', type: 'BACKLOG', position: 0 },
      },
    ];
    queryDataHolder.current = {
      issues: { nodes: backlogCandidates, pageInfo: { endCursor: null, hasNextPage: false } },
      teams: { nodes: mockTeams },
    };
    try {
      render(
        <MemoryRouter>
          <CandidatesPage />
        </MemoryRouter>,
      );

      expect(screen.getByText('Target: Backlog')).toBeInTheDocument();
      expect(screen.getByTitle(/stays parked in Backlog/)).toBeInTheDocument();
      expect(screen.getByText('Target: Ready')).toBeInTheDocument();
      expect(screen.getByTitle(/moved out of Backlog/)).toBeInTheDocument();
    } finally {
      queryDataHolder.current = null;
    }
  });

  it('shows a post-commit glance dialog grouped by project and navigates to the board', async () => {
    render(
      <MemoryRouter>
        <CandidatesPage />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByLabelText(/Select all visible/));
    fireEvent.click(screen.getByRole('button', { name: /Batch Commit \(2\)/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Batch commit summary' });
    expect(dialog).toHaveTextContent('Committed 2 work items');

    const involuteRow = screen.getByRole('link', { name: /Involute× 1/ });
    const lumenboxRow = screen.getByRole('link', { name: /lumenbox× 1/ });
    expect(involuteRow).toBeInTheDocument();
    expect(lumenboxRow).toBeInTheDocument();

    fireEvent.click(lumenboxRow);

    await waitFor(() =>
      expect(screen.getByTestId('location-probe')).toHaveTextContent(
        '/?team=INV&project=fakechris%2Flumenbox',
      ),
    );
    expect(screen.queryByRole('dialog', { name: 'Batch commit summary' })).not.toBeInTheDocument();
  });

  describe('placement before commit (INV-719)', () => {
    it('shows where a placed candidate lives and asks for a parent when it has none', () => {
      render(<MemoryRouter><CandidatesPage /></MemoryRouter>);
      const placed = screen.getByRole('article', { name: 'INV-40 candidate' });
      expect(placed).toHaveTextContent('INV-716');
      expect(placed).toHaveTextContent('Norm v1');

      const unplaced = screen.getByRole('article', { name: 'INV-21 candidate' });
      const picker = within(unplaced).getByLabelText('Parent for INV-21');
      const labels = within(picker).getAllByRole('option').map((option) => option.textContent);
      expect(labels).toEqual(['Choose where this belongs', 'INV-141 — Browser and computer use', 'No milestone (INV-96)']);
      expect(within(unplaced).getByRole('button', { name: /Commit/ })).toBeDisabled();
    });

    it('sends the chosen parent with the commit', async () => {
      render(<MemoryRouter><CandidatesPage /></MemoryRouter>);
      const unplaced = screen.getByRole('article', { name: 'INV-21 candidate' });
      fireEvent.change(within(unplaced).getByLabelText('Parent for INV-21'), { target: { value: 'm-lum' } });
      fireEvent.change(within(unplaced).getByLabelText('Owner for INV-21'), { target: { value: 'user-admin' } });
      fireEvent.click(within(unplaced).getByRole('button', { name: /Commit/ }));
      await waitFor(() =>
        expect(mockRunCommit).toHaveBeenCalledWith({
          variables: { id: 'cand-2', input: expect.objectContaining({ parentId: 'm-lum', expectedRevision: 1 }) },
        }),
      );
    });

    it('shows the server\'s reason when a commit is refused', async () => {
      mockRunCommit.mockResolvedValueOnce({
        data: { workCommit: { success: false, issue: null, message: 'Committed work requires a human owner.' } },
      });
      render(<MemoryRouter><CandidatesPage /></MemoryRouter>);
      const placed = screen.getByRole('article', { name: 'INV-40 candidate' });
      fireEvent.click(within(placed).getByRole('button', { name: /Commit/ }));
      expect(await within(placed).findByRole('alert')).toHaveTextContent('Committed work requires a human owner.');
    });

    it('counts refused batch commits as failures and names why', async () => {
      mockRunCommit
        .mockResolvedValueOnce({ data: { workCommit: { success: true, message: null, issue: { id: 'cand-1', identifier: 'INV-40', commitmentStatus: 'COMMITTED' } } } })
        .mockResolvedValueOnce({ data: { workCommit: { success: false, issue: null, message: 'Committed work requires a parent: place it first.' } } });
      render(<MemoryRouter><CandidatesPage /></MemoryRouter>);
      fireEvent.click(screen.getByLabelText(/Select all visible/));
      fireEvent.click(screen.getByRole('button', { name: /Batch Commit \(2\)/ }));
      expect(await screen.findByText(/Committed 1, failed 1\. INV-21: Committed work requires a parent/)).toBeInTheDocument();
    });
  });
});

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CandidatesPage } from './CandidatesPage';
import { CommitUndoHost } from '../undo/CommitUndoHost';
import { StatusUndoToast } from '../undo/StatusUndoToast';
import { handleSessionUndoKey, resetStatusUndo } from '../undo/status-undo';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-probe">{location.pathname + location.search}</output>;
}

const mockRunCommit = vi.fn();
const mockRunUncommit = vi.fn();
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
  resetStatusUndo();
  vi.clearAllMocks();
  mockRunUncommit.mockImplementation(async (options: { variables: { id: string; expectedRevision: number } }) => ({
    data: {
      workUncommit: {
        success: true,
        issue: { id: options.variables.id, identifier: options.variables.id, revision: options.variables.expectedRevision + 1, commitmentStatus: 'CANDIDATE' },
      },
    },
  }));
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
  useQuery: vi.fn((document: { loc?: { source?: { body?: string } } }) => document.loc?.source?.body?.includes('query GraphProjects') ? {
    data: { projectSummary: { totalCount: 1, projects: [{ repository: 'fakechris/lumenbox', name: 'Lumenbox', identifier: 'INV-96', totalCount: 1 }] } },
    loading: false,
  } : document.loc?.source?.body?.includes('query PlacementOptions') ? {
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
  useMutation: vi.fn((mutation: { loc?: { source?: { body?: string } } }) => {
    const body = mutation.loc?.source?.body ?? '';
    if (body.includes('workUncommit')) return [mockRunUncommit, { loading: false }];
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

  it('refuses to batch-commit a candidate without acceptance instead of inventing one (INV-998)', async () => {
    const blank = { ...candidateItems[0], id: 'cand-blank', identifier: 'INV-77', title: 'No criteria yet', acceptance: null };
    queryDataHolder.current = {
      issues: { nodes: [...candidateItems, blank], pageInfo: { endCursor: null, hasNextPage: false } },
      teams: { nodes: mockTeams },
    };
    render(
      <MemoryRouter>
        <CandidatesPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByLabelText(/Select all visible/));
    fireEvent.click(screen.getByRole('button', { name: /Batch Commit \(3\)/ }));

    expect(await screen.findByText(/INV-77 needs acceptance criteria/)).toBeInTheDocument();
    expect(mockRunCommit).not.toHaveBeenCalled();
    // The refusal points at the box to fill, and the card said so before (INV-1047).
    const card = screen.getByRole('article', { name: 'INV-77 candidate' });
    expect(within(card).getByText('Needs acceptance')).toBeInTheDocument();
    const box = screen.getByLabelText('Acceptance for INV-77');
    expect(box).toHaveFocus();
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(screen.getByRole('button', { name: 'Fill acceptance for INV-77' }));
    expect(box).toHaveFocus();
    expect(card.className).toContain('observation-card--attention');
    queryDataHolder.current = null;
  });

  it('undoes one batch commit as a single gesture and redoes it', async () => {
    const third = {
      ...candidateItems[0],
      id: 'cand-3',
      identifier: 'INV-41',
      title: 'Third candidate',
      acceptance: 'Third accepted',
    };
    queryDataHolder.current = {
      issues: { nodes: [...candidateItems, third], pageInfo: { endCursor: null, hasNextPage: false } },
      teams: { nodes: mockTeams },
    };
    mockRunUncommit.mockImplementation(async (options: { variables: { id: string; expectedRevision: number } }) => {
      if (options.variables.id === 'cand-2') {
        return { data: { workUncommit: { success: false, message: 'edited', issue: null } } };
      }
      return {
        data: {
          workUncommit: {
            success: true,
            issue: { id: options.variables.id, identifier: options.variables.id, revision: 3, commitmentStatus: 'CANDIDATE' },
          },
        },
      };
    });

    render(
      <MemoryRouter>
        <CandidatesPage />
        <StatusUndoToast />
        <CommitUndoHost />
      </MemoryRouter>,
    );
    window.addEventListener('keydown', handleSessionUndoKey);

    fireEvent.click(screen.getByLabelText(/Select all visible/));
    fireEvent.click(screen.getByRole('button', { name: /Batch Commit \(3\)/ }));
    const toast = await screen.findByTestId('status-undo-toast');
    expect(toast).toHaveTextContent('INV-40, INV-21, INV-41 committed');

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: 'z', metaKey: true });
    expect(mockRunUncommit).not.toHaveBeenCalled();
    input.remove();

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(mockRunUncommit).toHaveBeenCalledTimes(3));
    expect(await screen.findByTestId('status-undo-toast')).toHaveTextContent('Could not change INV-21');
    expect(screen.getByTitle('Select INV-40')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() => expect(mockRunCommit.mock.calls.length).toBeGreaterThan(3));
    window.removeEventListener('keydown', handleSessionUndoKey);
    queryDataHolder.current = null;
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

    it('places a triaged bug that has no repository by choosing its project first (INV-749)', async () => {
      queryDataHolder.current = {
        issues: {
          nodes: [{ ...candidateItems[1], id: 'cand-bug', identifier: 'INV-50', title: 'Crash somewhere', repository: null, source: 'bug-report' }],
          pageInfo: { endCursor: null, hasNextPage: false },
        },
        teams: { nodes: mockTeams },
      };
      try {
        render(<MemoryRouter><CandidatesPage /></MemoryRouter>);
        const card = screen.getByRole('article', { name: 'INV-50 candidate' });
        const field = within(card).getByLabelText('Parent for INV-50');
        expect(within(card).getByRole('button', { name: /Commit/ })).toBeDisabled();
        fireEvent.change(within(field).getByLabelText('Project'), { target: { value: 'fakechris/lumenbox' } });
        expect(within(field).getByLabelText('Location')).toHaveValue('INV-96');
        fireEvent.change(within(card).getByLabelText('Owner for INV-50'), { target: { value: 'user-admin' } });
        fireEvent.click(within(card).getByRole('button', { name: /Commit/ }));
        await waitFor(() =>
          expect(mockRunCommit).toHaveBeenCalledWith({
            variables: { id: 'cand-bug', input: expect.objectContaining({ parentId: 'INV-96' }) },
          }),
        );
      } finally {
        queryDataHolder.current = null;
      }
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
      expect(await screen.findByText(/Committed 1, failed 1\. Committed work requires a parent.*\(INV-21\)/)).toBeInTheDocument();
    });
  });

  describe('zero-bug triage (INV-750)', () => {
    const bugData = () => ({
      issues: {
        nodes: [{ ...candidateItems[0], id: 'cand-bug', identifier: 'INV-60', title: 'Crash', priority: 0, labels: { nodes: [{ id: 'l-bug', name: 'Bug' }] } }],
        pageInfo: { endCursor: null, hasNextPage: false },
      },
      teams: { nodes: mockTeams },
    });

    it('does not batch-commit bugs that have no priority', async () => {
      queryDataHolder.current = bugData();
      try {
        render(
          <MemoryRouter>
            <CandidatesPage />
          </MemoryRouter>,
        );
        fireEvent.click(screen.getByLabelText(/Select all visible/));
        const batch = screen.getByRole('button', { name: /Batch Commit \(1\)/ });
        expect(batch).toBeDisabled();
        expect(batch).toHaveAttribute('title', 'Choose a priority on each bug card first: it sets the SLA.');
        expect(mockRunCommit).not.toHaveBeenCalled();
      } finally {
        queryDataHolder.current = null;
      }
    });

    it('batch-commits a bug after a priority is chosen on its card', async () => {
      queryDataHolder.current = bugData();
      try {
        render(
          <MemoryRouter>
            <CandidatesPage />
          </MemoryRouter>,
        );
        fireEvent.click(screen.getByLabelText(/Select all visible/));
        const card = screen.getByRole('article', { name: 'INV-60 candidate' });
        fireEvent.change(within(card).getByLabelText('Priority for INV-60'), { target: { value: '2' } });
        const batch = screen.getByRole('button', { name: /Batch Commit \(1\)/ });
        expect(batch).toBeEnabled();
        fireEvent.click(batch);
        await waitFor(() =>
          expect(mockRunCommit).toHaveBeenCalledWith({
            variables: { id: 'cand-bug', input: expect.objectContaining({ priority: 2 }) },
          }),
        );
      } finally {
        queryDataHolder.current = null;
      }
    });

    it('commits a bug only with a priority and declines it only with a reason', async () => {
      queryDataHolder.current = bugData();
      try {
        render(<MemoryRouter><CandidatesPage /></MemoryRouter>);
        const card = screen.getByRole('article', { name: 'INV-60 candidate' });
        const commit = within(card).getByRole('button', { name: /Commit/ });
        const reject = within(card).getByRole('button', { name: /Reject/ });
        expect(commit).toBeDisabled();
        expect(reject).toBeDisabled();
        fireEvent.change(within(card).getByLabelText('Reject reason for INV-60'), { target: { value: 'Works as designed' } });
        expect(reject).toBeEnabled();
        fireEvent.change(within(card).getByLabelText('Priority for INV-60'), { target: { value: '2' } });
        fireEvent.change(within(card).getByLabelText('Owner for INV-60'), { target: { value: 'user-admin' } });
        fireEvent.click(commit);
        await waitFor(() =>
          expect(mockRunCommit).toHaveBeenCalledWith({
            variables: { id: 'cand-bug', input: expect.objectContaining({ priority: 2 }) },
          }),
        );
      } finally {
        queryDataHolder.current = null;
      }
    });

    it('filters to bugs when "Bugs only" is on', async () => {
      const { useQuery } = await import('@apollo/client/react');
      render(<MemoryRouter initialEntries={['/candidates?type=bug']}><CandidatesPage /></MemoryRouter>);
      expect(screen.getByRole('button', { name: 'Bugs only' })).toHaveAttribute('aria-pressed', 'true');
      const calls = vi.mocked(useQuery).mock.calls.filter(([document]) => (document as { loc?: { source?: { body?: string } } }).loc?.source?.body?.includes('query CandidatesPage'));
      const variables = (calls.at(-1)?.[1] as { variables?: { filter?: Record<string, unknown> } })?.variables;
      expect(variables?.filter).toMatchObject({ labels: { some: { name: { in: ['bug', 'Bug', 'BUG'] } } } });
      // The fixture has no bug candidates, so nothing is listed.
      expect(screen.queryByRole('article', { name: 'INV-40 candidate' })).not.toBeInTheDocument();
    });
  });

  describe('settling the whole contract at commit, and undoing a rejection (INV-792)', () => {
    it('commits with edited contract fields and a chosen starting state', async () => {
      queryDataHolder.current = {
        issues: { nodes: [candidateItems[0]], pageInfo: { endCursor: null, hasNextPage: false } },
        teams: {
          nodes: [
            {
              ...mockTeams[0],
              states: { nodes: [{ id: 'state-ready', name: 'Ready', type: 'UNSTARTED' }, { id: 'state-progress', name: 'In Progress', type: 'STARTED' }, { id: 'state-done', name: 'Done', type: 'COMPLETED' }] },
            },
          ],
        },
      };
      try {
        render(<MemoryRouter><CandidatesPage /></MemoryRouter>);
        const card = screen.getByRole('article', { name: 'INV-40 candidate' });
        fireEvent.change(within(card).getByLabelText('Scope for INV-40'), { target: { value: 'ops and docs' } });
        const start = within(card).getByLabelText('Starting state for INV-40');
        expect(within(start).getAllByRole('option').map((option) => option.textContent)).toEqual([
          'Default (as proposed, or Ready)',
          'Ready',
          'In Progress',
        ]);
        fireEvent.change(start, { target: { value: 'state-progress' } });
        fireEvent.change(within(card).getByLabelText('Owner for INV-40'), { target: { value: 'user-admin' } });
        fireEvent.click(within(card).getByRole('button', { name: /Commit/ }));
        await waitFor(() => expect(mockRunCommit).toHaveBeenCalledTimes(1));
        const input = mockRunCommit.mock.calls[0]![0].variables.input;
        expect(input).toMatchObject({ scope: 'ops and docs', stateId: 'state-progress' });
        // Unchanged fields are not re-sent.
        expect(input).not.toHaveProperty('outcome');
      } finally {
        queryDataHolder.current = null;
      }
    });

    it('lists rejected work with why, and restores it with a reason', async () => {
      const { useQuery, useMutation } = await import('@apollo/client/react');
      const restore = vi.fn().mockResolvedValue({ data: { workRestore: { success: true, message: null } } });
      const originalQuery = vi.mocked(useQuery).getMockImplementation()!;
      const originalMutation = vi.mocked(useMutation).getMockImplementation()!;
      vi.mocked(useQuery).mockImplementation(((document: { loc?: { source?: { body?: string } } }, options: unknown) =>
        document.loc?.source?.body?.includes('query RejectedWork')
          ? { data: { issues: { nodes: [{ id: 'rej-1', identifier: 'INV-77', title: 'Old idea', kind: 'ISSUE', repository: 'acme/app', updatedAt: '2026-09-20T00:00:00.000Z', rejectionReason: 'Not now' }] } }, loading: false, refetch: mockRefetch }
          : originalQuery(document as never, options as never)) as never);
      vi.mocked(useMutation).mockImplementation(((document: { loc?: { source?: { body?: string } } }) =>
        document.loc?.source?.body?.includes('mutation WorkRestore') ? [restore, { loading: false }] : [mockRunCommit, { loading: false }]) as never);
      try {
        render(<MemoryRouter initialEntries={['/candidates?view=rejected']}><CandidatesPage /></MemoryRouter>);
        expect(screen.getByRole('button', { name: 'Rejected' })).toHaveAttribute('aria-pressed', 'true');
        const row = screen.getByRole('listitem', { name: 'INV-77 rejected' });
        expect(row).toHaveTextContent('Why: Not now');
        const button = within(row).getByRole('button', { name: 'Restore to candidate' });
        expect(button).toBeDisabled();
        fireEvent.change(within(row).getByLabelText('Reason to restore INV-77'), { target: { value: 'Rejected by mistake' } });
        fireEvent.click(button);
        await waitFor(() => expect(restore).toHaveBeenCalledWith({ variables: { id: 'rej-1', reason: 'Rejected by mistake' } }));
        await waitFor(() => expect(mockRefetch).toHaveBeenCalled());
      } finally {
        vi.mocked(useQuery).mockImplementation(originalQuery);
        vi.mocked(useMutation).mockImplementation(originalMutation);
      }
    });
  });

  it('offers to record a dependency the text names but no BLOCKS link records (INV-720)', async () => {
    mockRunCommit.mockClear();
    queryDataHolder.current = {
      issues: {
        nodes: [{ ...candidateItems[0], dependencyHints: ['INV-420'] }],
        pageInfo: { endCursor: null, hasNextPage: false },
      },
      teams: { nodes: mockTeams },
    };
    render(<MemoryRouter><CandidatesPage /></MemoryRouter>);
    const hint = screen.getByLabelText('Dependency hints for INV-40');
    fireEvent.click(within(hint).getByRole('button', { name: 'INV-420 blocks this' }));
    await waitFor(() =>
      expect(mockRunCommit).toHaveBeenCalledWith({ variables: { fromId: 'INV-420', toId: 'cand-1', type: 'BLOCKS' } }),
    );
    queryDataHolder.current = null;
  });
});

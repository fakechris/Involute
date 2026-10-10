import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BugsPage } from './BugsPage';

const bugsPageData = {
  bugSummary: {
    openCount: 3,
    closedCount: 2,
    byPriority: [
      { priority: 1, count: 1 },
      { priority: 2, count: 1 },
      { priority: 0, count: 1 },
    ],
    byRepository: [
      { repository: 'fakechris/Involute', openCount: 2, closedCount: 2 },
      { repository: null, openCount: 1, closedCount: 0 },
    ],
    byTypeLabel: [{ label: 'ui', count: 2 }],
    unclaimedOpenCount: 2,
    oldestOpenAgeDays: 12.4,
    avgOpenAgeDays: 6.1,
    createdPerWeek: [
      { weekStart: '2026-07-20', count: 0 },
      { weekStart: '2026-07-27', count: 1 },
      { weekStart: '2026-08-03', count: 0 },
      { weekStart: '2026-08-10', count: 0 },
      { weekStart: '2026-08-17', count: 3 },
      { weekStart: '2026-08-24', count: 0 },
      { weekStart: '2026-08-31', count: 1 },
      { weekStart: '2026-09-07', count: 2 },
    ],
    mostDuplicated: [
      { id: 'issue-high', identifier: 'INV-32', title: 'High wrong totals', priority: 2, duplicateCount: 3 },
      { id: 'issue-urgent', identifier: 'INV-30', title: 'Urgent crash on save', priority: 1, duplicateCount: 1 },
    ],
    metrics: {
      triageHoursP50: 3.5,
      triageHoursP90: 70,
      triagedCount: 4,
      untriagedCount: 2,
      slaMetCount: 3,
      slaBreachedClosedCount: 1,
      slaMetRate: 0.75,
      atRiskOpenCount: 1,
      breachedOpen: [{ id: 'issue-urgent', identifier: 'INV-30', title: 'Urgent crash on save', overdueHours: 5.5 }],
      bySource: [
        { source: 'HUMAN_REPORT', count: 3 },
        { source: 'AGENT', count: 2 },
      ],
      byResolution: [
        { resolution: 'INVALID', source: 'AGENT', count: 1 },
        { resolution: 'WONT_DO', source: 'HUMAN_REPORT', count: 1 },
      ],
      unplacedOpenCount: 1,
      closedEverCount: 8,
      reopenedCount: 2,
      reopenRate: 0.25,
      autoAcceptedCount: 4,
      reopenedAfterAutoAcceptCount: 1,
      reopenedAfterAutoAcceptRate: 0.25,
    },
  },
  issues: {
    nodes: [
      {
        id: 'issue-low',
        identifier: 'INV-31',
        title: 'Low priority polish',
        priority: 0,
        repository: null,
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-09-09T10:00:00.000Z',
        state: { id: 'state-ready', name: 'Ready', type: 'UNSTARTED', position: 1 },
        team: { id: 'team-1', key: 'INV' },
        labels: { nodes: [{ id: 'label-bug', name: 'bug' }] },
      },
      {
        id: 'issue-urgent',
        identifier: 'INV-30',
        title: 'Urgent crash on save',
        revision: 4,
        priority: 1,
        repository: 'fakechris/Involute',
        createdAt: '2026-08-02T10:00:00.000Z',
        updatedAt: '2026-09-01T10:00:00.000Z',
        state: { id: 'state-ready', name: 'Ready', type: 'UNSTARTED', position: 1 },
        team: { id: 'team-1', key: 'INV' },
        labels: { nodes: [{ id: 'label-bug', name: 'bug' }] },
      },
      {
        id: 'issue-high',
        identifier: 'INV-32',
        title: 'High wrong totals',
        priority: 2,
        repository: 'fakechris/Involute',
        createdAt: '2026-08-03T10:00:00.000Z',
        updatedAt: '2026-09-05T10:00:00.000Z',
        state: { id: 'state-progress', name: 'In Progress', type: 'STARTED', position: 2 },
        team: { id: 'team-1', key: 'INV' },
        labels: { nodes: [{ id: 'label-bug', name: 'bug' }] },
      },
      {
        id: 'issue-done',
        identifier: 'INV-10',
        title: 'Fixed last week',
        priority: 1,
        repository: 'fakechris/Involute',
        createdAt: '2026-07-01T10:00:00.000Z',
        updatedAt: '2026-08-20T10:00:00.000Z',
        state: { id: 'state-done', name: 'Done', type: 'COMPLETED', position: 4 },
        team: { id: 'team-1', key: 'INV' },
        labels: { nodes: [{ id: 'label-bug', name: 'bug' }] },
      },
    ],
    pageInfo: { endCursor: null, hasNextPage: false },
  },
  teams: {
    nodes: [{
      id: 'team-1',
      states: {
        nodes: [
          { id: 'state-backlog', name: 'Backlog', type: 'BACKLOG', position: 0 },
          { id: 'state-ready', name: 'Ready', type: 'UNSTARTED', position: 1 },
          { id: 'state-progress', name: 'In Progress', type: 'STARTED', position: 2 },
        ],
      },
    }],
  },
};

const mockUpdate = vi.fn();

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
});

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn(() => ({
    data: bugsPageData,
    loading: false,
    error: undefined,
    refetch: vi.fn(),
  })),
  useMutation: vi.fn(() => [mockUpdate, { loading: false }]),
  useLazyQuery: vi.fn(() => [vi.fn(), { data: undefined, loading: false, error: undefined }]),
}));

vi.mock('../lib/session', () => ({
  fetchSessionState: vi.fn().mockResolvedValue({ authenticated: true, authMode: 'session', googleOAuthConfigured: false, viewer: { email: 'me@test', globalRole: 'USER', id: 'user-me', name: 'Me' } }),
}));

function LocationState() {
  return <pre data-testid="location-state">{JSON.stringify(useLocation().state)}</pre>;
}

describe('BugsPage', () => {
  it('shows triage time, SLA outcomes, breaches, sources and unplaced bugs (INV-751)', () => {
    render(
      <MemoryRouter>
        <BugsPage />
      </MemoryRouter>,
    );
    const triage = screen.getByLabelText('Triage and SLA');
    expect(triage).toHaveTextContent('2Waiting in triage');
    expect(triage).toHaveTextContent('3.5h / 3dTriage time p50 / p90 (4 triaged)');
    expect(triage).toHaveTextContent('75%Fixed within SLA (3 of 4)');
    expect(triage).toHaveTextContent('1 / 1Open past SLA / at risk');
    expect(triage).toHaveTextContent('1Open bugs with no parent (goal 0)');
    expect(within(triage).getByRole('link', { name: /Waiting in triage/ })).toHaveAttribute('href', '/candidates?type=bug');
    const breaches = screen.getByLabelText('Open bugs past their SLA');
    expect(breaches).toHaveTextContent('INV-30');
    expect(breaches).toHaveTextContent('5.5h over');
    expect(screen.getByLabelText('Bugs by source')).toHaveTextContent('Reported by people3Filed by agents2');
  });

  it('shows the reopen rate and reopens after the Auto-Accept Gate accepted (INV-1120)', () => {
    render(
      <MemoryRouter>
        <BugsPage />
      </MemoryRouter>,
    );
    const triage = screen.getByLabelText('Triage and SLA');
    expect(triage).toHaveTextContent('25%Reopened (2 of 8 closed)');
    expect(triage).toHaveTextContent('25%Reopened after auto-accept (1 of 4)');
  });

  it('shows why bugs were closed without a fix, by reporter, with the false-report rate (INV-1118)', () => {
    render(
      <MemoryRouter>
        <BugsPage />
      </MemoryRouter>,
    );
    const panel = screen.getByLabelText('Bugs closed without a fix');
    const rows = within(panel).getAllByRole('row').map((row) => row.textContent);
    expect(rows).toEqual([
      'ResolutionReported by peopleFiled by agentsOther',
      "Won't do100",
      'Invalid (not a real problem)010',
      'False-report rate0%50%—',
    ]);
  });

  it('lists the open bugs reported again most, most duplicates first (INV-1124)', () => {
    render(
      <MemoryRouter>
        <BugsPage />
      </MemoryRouter>,
    );
    const panel = screen.getByLabelText('Most duplicated open bugs');
    const rows = within(panel).getAllByRole('row').map((row) => row.textContent);
    expect(rows).toEqual(['BugDuplicates', 'INV-32High wrong totals3', 'INV-30Urgent crash on save1']);
    expect(within(panel).getByRole('button', { name: /INV-32/ })).toHaveAttribute('title', expect.stringMatching(/raising its priority/));
  });

  it('renders the header stat cards', () => {
    render(
      <MemoryRouter>
        <BugsPage />
      </MemoryRouter>,
    );

    const stats = screen.getByLabelText('Bug statistics');
    const cards = within(stats).getAllByText(/./, { selector: '.bugs-stat__label' });
    expect(cards.map((card) => card.textContent)).toEqual([
      'Open',
      'Unclaimed',
      'Urgent + High open',
      'Avg open age (days)',
    ]);
    const values = within(stats).getAllByText(/./, { selector: '.bugs-stat__value' });
    expect(values.map((value) => value.textContent)).toEqual(['3', '2', '2', '6']);
  });

  it('renders by-project and by-type tables', () => {
    render(
      <MemoryRouter>
        <BugsPage />
      </MemoryRouter>,
    );

    const byProject = screen.getByLabelText('Bugs by project');
    expect(within(byProject).getByText('fakechris/Involute')).toBeInTheDocument();
    expect(within(byProject).getByText('No project')).toBeInTheDocument();

    const byType = screen.getByLabelText('Open bugs by type');
    expect(within(byType).getByText('ui')).toBeInTheDocument();
    expect(within(byType).getByText('2')).toBeInTheDocument();
  });

  it('renders the 8-week creation trend', () => {
    render(
      <MemoryRouter>
        <BugsPage />
      </MemoryRouter>,
    );

    const trend = screen.getByLabelText('Bug creation trend');
    expect(within(trend).getAllByText(/^\d{2}-\d{2}$/)).toHaveLength(8);
    expect(within(trend).getByText('3')).toBeInTheDocument();
  });

  it('lists open bugs urgent-first with priority 0 last and hides closed bugs', () => {
    render(
      <MemoryRouter>
        <BugsPage />
      </MemoryRouter>,
    );

    const list = within(screen.getByRole('region', { name: 'Open bugs' })).getByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('INV-30');
    expect(items[1]).toHaveTextContent('INV-32');
    expect(items[2]).toHaveTextContent('INV-31');
    expect(screen.queryByText('Fixed last week')).not.toBeInTheDocument();
  });

  // INV-1133
  it('opens each bug on its own page and changes it in place with its revision', async () => {
    mockUpdate.mockResolvedValue({ data: { issueUpdate: { issue: null, success: true } } });
    render(<MemoryRouter><BugsPage /></MemoryRouter>);
    const list = screen.getByRole('list', { name: 'Open bugs list' });
    expect(within(list).getByRole('link', { name: 'INV-30' })).toHaveAttribute('href', '/issue/INV-30');

    fireEvent.change(within(list).getByLabelText('Priority of INV-30'), { target: { value: '2' } });
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith({ variables: { id: 'issue-urgent', input: { expectedRevision: 4, priority: 2 } } }));

    fireEvent.change(within(list).getByLabelText('Status of INV-30'), { target: { value: 'state-progress' } });
    await waitFor(() => expect(mockUpdate).toHaveBeenLastCalledWith({ variables: { id: 'issue-urgent', input: { expectedRevision: 4, stateId: 'state-progress' } } }));

    const assign = await within(list).findAllByRole('button', { name: 'Assign to me' });
    await waitFor(() => expect(assign[0]).not.toBeDisabled());
    fireEvent.click(assign[0]!);
    await waitFor(() => expect(mockUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ variables: expect.objectContaining({ input: expect.objectContaining({ assigneeId: 'user-me' }) }) })));
  });

  it('shows why the server refused a change, e.g. a bug moved to Backlog', async () => {
    mockUpdate.mockResolvedValue({ data: { issueUpdate: { issue: null, message: 'A committed bug cannot go to Backlog.', success: false } } });
    render(<MemoryRouter><BugsPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Status of INV-30'), { target: { value: 'state-backlog' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('A committed bug cannot go to Backlog.');
  });

  it('reports a bug from the page', () => {
    render(
      <MemoryRouter initialEntries={['/bugs']}>
        <Routes>
          <Route path="/bugs" element={<BugsPage />} />
          <Route path="/" element={<LocationState />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Report bug' }));
    expect(screen.getByTestId('location-state')).toHaveTextContent('{"openReportBug":true}');
  });
});

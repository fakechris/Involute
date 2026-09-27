import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
      unplacedOpenCount: 1,
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
};

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
  useMutation: vi.fn(() => [vi.fn(), { loading: false }]),
}));

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
});

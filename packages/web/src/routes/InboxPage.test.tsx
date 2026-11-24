import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkReferenceProvider } from '../components/WorkReference';
import { InboxPage, groupActivity, resolutionText } from './InboxPage';
import type { NotificationRecordItem } from '../board/types';

const mockRunMarkRead = vi.fn();
const mockPreviewClient = {
  query: vi.fn((options: { variables: { identifiers: string[] } }) =>
    Promise.resolve({
      data: {
        issuePreviews: options.variables.identifiers
          .filter((reference) => reference === 'INV-391')
          .map((reference) => ({
            id: 'work-391',
            reference,
            identifier: reference,
            title: 'Unrelated item',
            stateName: 'Done',
            stateType: 'COMPLETED',
            commitmentStatus: 'COMMITTED',
            priority: 0,
            kind: 'ISSUE',
            repository: 'fakechris/Involute',
            teamKey: 'INV',
            typeLabel: null,
            excerpt: null,
            updatedAt: '2026-10-01T00:00:00.000Z',
          })),
      },
    }),
  ),
};
const mockRunMarkAllRead = vi.fn();
let bugNotifications: NotificationRecordItem[] = [];

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  bugNotifications = [];
});

vi.mock('@apollo/client/react', () => ({
  // Work references in payload details ask the server (INV-1536); it knows INV-391.
  useApolloClient: () => mockPreviewClient,
  useQuery: vi.fn(() => ({
    data: {
      notifications: {
        nodes: [
          ...bugNotifications,
          {
            id: 'notif-1',
            type: 'decision.requested',
            actionable: true,
            resolvedAt: null,
            payload: { summary: 'Approval required for schema change' },
            readAt: null,
            createdAt: '2026-04-02T10:00:00.000Z',
            work: {
              id: 'issue-1',
              identifier: 'INV-1',
              title: 'Database connection pool',
              kind: 'ISSUE',
              state: { id: 'state-1', name: 'In Review', type: 'STARTED' },
            },
          },
          {
            id: 'notif-2',
            type: 'run.completed',
            payload: { summary: 'Agent run #42 succeeded' },
            readAt: '2026-04-02T09:00:00.000Z',
            createdAt: '2026-04-02T08:00:00.000Z',
            work: {
              id: 'issue-2',
              identifier: 'INV-2',
              title: 'Fix race condition',
              kind: 'ISSUE',
              state: { id: 'state-2', name: 'Done', type: 'COMPLETED' },
            },
          },
          {
            id: 'notif-3',
            type: 'ops.github.pr_unverified_reference',
            payload: {
              summary: 'PR #64 references an unrelated issue',
              prUrl: 'https://github.com/acme/app/pull/64',
              identifier: 'INV-391',
              reason: 'team-mismatch',
            },
            readAt: '2026-04-02T07:00:00.000Z',
            createdAt: '2026-04-02T07:00:00.000Z',
            work: null,
          },
        ],
      },
      unreadNotificationCount: 1,
    },
    loading: false,
    error: undefined,
    refetch: vi.fn(),
  })),
  useMutation: vi.fn((document) => {
    const docStr = JSON.stringify(document);
    if (docStr.includes('NotificationMarkRead')) {
      return [mockRunMarkRead, { loading: false }];
    }
    return [mockRunMarkAllRead, { loading: false }];
  }),
}));

describe('InboxPage', () => {
  it('shows the details and links of a notification with no work item (INV-794)', async () => {
    render(
      <MemoryRouter>
        <WorkReferenceProvider>
          <InboxPage />
        </WorkReferenceProvider>
      </MemoryRouter>,
    );
    const details = screen.getByLabelText('Notification details');
    expect(details).toHaveTextContent('team-mismatch');
    expect(screen.getByRole('link', { name: 'https://github.com/acme/app/pull/64' })).toHaveAttribute(
      'href',
      'https://github.com/acme/app/pull/64',
    );
    expect(await screen.findByRole('link', { name: 'INV-391' })).toHaveAttribute('href', '/issue/INV-391');
    expect(screen.getByRole('link', { name: 'Open in Ops' })).toHaveAttribute('href', '/ops#traceability');
  });

  it('renders activity without an unread number: the only count is Needs you (INV-1093)', () => {
    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.queryByText('1')).toBeNull();
    expect(screen.getByRole('link', { name: 'What needs you' })).toHaveAttribute('href', '/todo');
    expect(screen.getByText('Decision requested')).toBeInTheDocument();
    expect(screen.getByText('INV-1')).toBeInTheDocument();
    expect(screen.getByText('Database connection pool')).toBeInTheDocument();
    expect(screen.getByText('Approval required for schema change')).toBeInTheDocument();
    expect(screen.getByText('Run completed')).toBeInTheDocument();
  });

  it('marks individual notification as read when clicking the mark-as-read check button', () => {
    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );

    const markReadBtn = screen.getByRole('button', { name: 'Mark as read' });
    fireEvent.click(markReadBtn);

    expect(mockRunMarkRead).toHaveBeenCalledWith({
      variables: { id: 'notif-1' },
    });
  });

  it('allows clicking Mark all read button', () => {
    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );

    const markAllBtn = screen.getByRole('button', { name: 'Mark all read' });
    fireEvent.click(markAllBtn);

    expect(mockRunMarkAllRead).toHaveBeenCalled();
  });

  // INV-1093
  it('folds a work item\'s notifications into one row and links an open decision to Needs you', () => {
    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );
    // decision.requested on INV-1 is actionable and still open.
    expect(screen.getByRole('link', { name: 'Waiting on you · Needs you' })).toHaveAttribute('href', '/todo');
  });

  it('shows both bug reports but links only the triage report to Needs you (INV-2113)', () => {
    bugNotifications = [false, true].map((triage, index) => ({
      id: `bug-${index}`,
      type: 'bug.reported',
      actionable: triage,
      resolvedAt: null,
      readAt: null,
      payload: { triage },
      createdAt: '2026-04-02T10:00:00.000Z',
      work: { id: `work-${index}`, identifier: `INV-${100 + index}`, title: triage ? 'Unplaced bug' : 'Placed bug' },
    }));
    render(
      <MemoryRouter initialEntries={['/inbox']}>
        <Routes>
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/todo" element={<h1>Needs you queue</h1>} />
        </Routes>
      </MemoryRouter>,
    );

    const placed = screen.getByRole('button', { name: /INV-100.*Bug reported.*Placed bug/i });
    const unplaced = screen.getByRole('button', { name: /INV-101.*Bug reported.*Unplaced bug/i });
    expect(within(placed).queryByRole('link', { name: /Needs you/ })).not.toBeInTheDocument();
    const triageLink = within(unplaced).getByRole('link', { name: 'Waiting on you · Needs you' });
    expect(fireEvent.keyDown(triageLink, { key: 'Enter' })).toBe(true);
    fireEvent.click(triageLink);
    expect(screen.getByRole('heading', { name: 'Needs you queue' })).toBeInTheDocument();
    expect(mockRunMarkRead).not.toHaveBeenCalled();
  });
});

describe('Activity rows (INV-1093)', () => {
  const base = (id: string, workId: string | null, extra: Partial<NotificationRecordItem> = {}): NotificationRecordItem => ({
    createdAt: '2026-10-10T00:00:00.000Z',
    id,
    payload: null,
    readAt: null,
    type: 'work.committed',
    work: workId ? { id: workId, identifier: workId.toUpperCase(), title: workId } : null,
    ...extra,
  });

  it('keeps one row per work item at the newest notification, and lone rows for no work', () => {
    const rows = groupActivity([base('n3', 'inv-1'), base('n2', null), base('n1', 'inv-1'), base('n0', 'inv-2')]);
    expect(rows.map((row) => [row.item.id, row.more.map((entry) => entry.id)])).toEqual([
      ['n3', ['n1']],
      ['n2', []],
      ['n0', []],
    ]);
  });

  it('says who decided a resolved notification and how', () => {
    expect(resolutionText(base('a', 'inv-1', { actionable: true, resolution: 'accepted', resolvedAt: '2026-10-10T01:00:00.000Z', resolvedBy: { email: null, id: 'u', name: 'Chris' } }))).toBe('Accepted by Chris');
    expect(resolutionText(base('b', 'inv-1', { actionable: true }))).toBeNull();
    expect(resolutionText(base('c', 'inv-1'))).toBeNull();
  });
});

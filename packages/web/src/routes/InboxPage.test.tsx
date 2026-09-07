import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InboxPage } from './InboxPage';

const mockRunMarkRead = vi.fn();
const mockRunMarkAllRead = vi.fn();

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
});

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn(() => ({
    data: {
      notifications: {
        nodes: [
          {
            id: 'notif-1',
            type: 'decision.requested',
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
  it('renders real notifications and shows unread badge', () => {
    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Inbox')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
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
});

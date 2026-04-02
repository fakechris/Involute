import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IssueSummary } from '../board/types';

const useSortableSpy = vi.hoisted(() => vi.fn());

vi.mock('@dnd-kit/sortable', async () => {
  const actual = await vi.importActual<typeof import('@dnd-kit/sortable')>('@dnd-kit/sortable');

  return {
    ...actual,
    useSortable: useSortableSpy.mockImplementation(() => ({
      attributes: {},
      listeners: {},
      setActivatorNodeRef: vi.fn(),
      setNodeRef: vi.fn(),
      transform: null,
      transition: null,
      isDragging: false,
    })),
  };
});

import { IssueCard } from './IssueCard';

beforeEach(() => {
  useSortableSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

const makeIssue = (overrides: Partial<IssueSummary> = {}): IssueSummary => ({
  id: 'issue-1',
  identifier: 'INV-1',
  title: 'Test issue',
  description: 'Test description',
  createdAt: '2026-04-02T10:00:00.000Z',
  updatedAt: '2026-04-02T10:00:00.000Z',
  state: { id: 'state-backlog', name: 'Backlog' },
  team: { id: 'team-1', key: 'INV' },
  labels: { nodes: [{ id: 'label-task', name: 'task' }] },
  assignee: { id: 'user-1', name: 'Admin', email: 'admin@involute.local' },
  children: { nodes: [] },
  parent: null,
  comments: { nodes: [] },
  ...overrides,
});

describe('IssueCard', () => {
  it('passes stateId from issue.state.id to useSortable data', () => {
    const issue = makeIssue({ state: { id: 'state-progress', name: 'In Progress' } });

    render(<IssueCard issue={issue} />);

    expect(useSortableSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'issue-1',
        data: expect.objectContaining({
          stateId: 'state-progress',
          type: 'issue-card',
        }),
      }),
    );
  });

  it('includes the issue object in useSortable data alongside stateId', () => {
    const issue = makeIssue();

    render(<IssueCard issue={issue} />);

    const lastCall = useSortableSpy.mock.calls[useSortableSpy.mock.calls.length - 1]?.[0];
    expect(lastCall).toBeDefined();
    expect(lastCall.data).toHaveProperty('issue', issue);
    expect(lastCall.data).toHaveProperty('stateId', 'state-backlog');
    expect(lastCall.data).toHaveProperty('type', 'issue-card');
  });

  it('updates useSortable stateId when issue state changes across renders', () => {
    const issue = makeIssue({ state: { id: 'state-backlog', name: 'Backlog' } });
    const { rerender } = render(<IssueCard issue={issue} />);

    expect(useSortableSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stateId: 'state-backlog' }),
      }),
    );

    const updatedIssue = makeIssue({ state: { id: 'state-done', name: 'Done' } });
    rerender(<IssueCard issue={updatedIssue} />);

    expect(useSortableSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stateId: 'state-done' }),
      }),
    );
  });

  it('renders the issue card with correct content', () => {
    const issue = makeIssue();

    render(<IssueCard issue={issue} />);

    expect(screen.getAllByText('INV-1').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Test issue').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('task').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Admin').length).toBeGreaterThanOrEqual(1);
  });

  it('renders a stable drag handle selector and accessible label based on the issue identifier', () => {
    const issue = makeIssue({ identifier: 'INV-42' });

    render(<IssueCard issue={issue} />);

    const dragHandle = screen.getByTestId('issue-drag-handle-INV-42');
    expect(dragHandle).toHaveAccessibleName('Drag INV-42');
    expect(screen.getByTestId('issue-card-issue-1')).toHaveAttribute('data-issue-identifier', 'INV-42');
  });

  it('disables sortable registration and omits the drag handle for preview cards', () => {
    const issue = makeIssue({ identifier: 'INV-99' });

    render(<IssueCard issue={issue} sortable={false} />);

    expect(useSortableSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          issue,
          stateId: 'state-backlog',
          type: 'issue-card',
        }),
        disabled: true,
        id: 'issue-1',
      }),
    );
    expect(screen.queryByTestId('issue-drag-handle-INV-99')).not.toBeInTheDocument();
    expect(screen.getByTestId('issue-card-issue-1')).toHaveAttribute('data-sortable', 'false');
  });

  it('wires the drag handle as the sortable activator node', () => {
    const setActivatorNodeRef = vi.fn();
    useSortableSpy.mockImplementationOnce(() => ({
      attributes: {},
      listeners: {},
      setActivatorNodeRef,
      setNodeRef: vi.fn(),
      transform: null,
      transition: null,
      isDragging: false,
    }));

    render(<IssueCard issue={makeIssue()} />);

    expect(setActivatorNodeRef).toHaveBeenCalledTimes(1);
    expect(setActivatorNodeRef.mock.calls[0]?.[0]).toBeInstanceOf(HTMLButtonElement);
    expect(setActivatorNodeRef.mock.calls[0]?.[0]).toHaveAttribute('data-testid', 'issue-drag-handle-INV-1');
  });
});

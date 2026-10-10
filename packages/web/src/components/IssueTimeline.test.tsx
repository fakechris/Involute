import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IssueTimeline, type IssueTimelineEntry } from './IssueTimeline';

const mockStar = vi.fn();
const mockUnstar = vi.fn();
const mockRefetch = vi.fn();
let entries: IssueTimelineEntry[] = [];

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn(() => ({ data: { issueTimeline: { workId: 'issue-1', truncated: false, entries } }, refetch: mockRefetch })),
  useMutation: vi.fn((document: { loc?: { source: { body: string } } }) =>
    document.loc?.source.body.includes('IssueTimelineUnstar') ? [mockUnstar] : [mockStar]),
}));

const builder = { id: 'agent-1', name: 'Builder', email: null };
const admin = { id: 'user-1', name: 'Admin', email: 'admin@involute.local' };

function entry(partial: Partial<IssueTimelineEntry> & Pick<IssueTimelineEntry, 'key' | 'kind' | 'at' | 'summary'>): IssueTimelineEntry {
  return { actor: builder, actorKind: 'AGENT', detail: null, url: null, sourceId: partial.key, starred: false, starredAt: null, starredBy: null, ...partial };
}

const comment = { id: 'c1', body: 'Looks right', createdAt: '2026-10-09T08:05:00.000Z', user: admin };

function renderTimeline() {
  return render(
    <IssueTimeline
      issueId="issue-1"
      comments={[comment]}
      refreshKey="1"
      renderComment={(item, star) => (
        <div data-testid={`comment-${item.id}`}>
          {item.body}
          {star}
        </div>
      )}
    />,
  );
}

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  entries = [
    entry({ key: 'audit:a1', kind: 'CREATED', at: '2026-10-09T08:00:00.000Z', summary: 'Created in Ready', actor: admin, actorKind: 'HUMAN' }),
    entry({ key: 'audit:a2', kind: 'STATE', at: '2026-10-09T08:04:00.000Z', summary: 'Moved from Ready to In Progress' }),
    // The server lists the comment too; the page renders its own copy of it.
    entry({ key: 'comment:c1', kind: 'COMMENT', at: comment.createdAt, summary: 'Commented', actor: admin, starred: true, starredBy: admin }),
    entry({ key: 'evidence:e1', kind: 'EVIDENCE', at: '2026-10-09T08:06:00.000Z', summary: 'Attached pr evidence', url: 'https://github.com/test/placement/pull/9' }),
  ];
  mockStar.mockResolvedValue({ data: { issueTimelineStar: { success: true, message: null, entryKey: 'audit:a2', starred: true } } });
  mockUnstar.mockResolvedValue({ data: { issueTimelineUnstar: { success: true, message: null, entryKey: 'comment:c1', starred: false } } });
});

describe('issue timeline (INV-1116)', () => {
  it('shows audit changes, evidence and the page comments in time order with their actors', () => {
    renderTimeline();
    const activity = screen.getByLabelText('Issue activity');
    const text = activity.textContent ?? '';
    expect(text.indexOf('Created in Ready')).toBeLessThan(text.indexOf('Moved from Ready to In Progress'));
    expect(text.indexOf('Moved from Ready to In Progress')).toBeLessThan(text.indexOf('Looks right'));
    expect(text.indexOf('Looks right')).toBeLessThan(text.indexOf('Attached pr evidence'));
    // The comment appears once, rendered by the page.
    expect(within(activity).getAllByText('Looks right')).toHaveLength(1);
    expect(within(activity).queryByText('Commented')).not.toBeInTheDocument();
    expect(within(activity).getAllByText('Builder')).toHaveLength(2);
    expect(within(activity).getByRole('link', { name: 'link' })).toHaveAttribute('href', 'https://github.com/test/placement/pull/9');
  });

  it('stars an entry as a key event and removes a star, through the GraphQL mutations', async () => {
    renderTimeline();
    const stateRow = screen.getByText('Moved from Ready to In Progress').closest('.issue-activity__event') as HTMLElement;
    fireEvent.click(within(stateRow).getByRole('button', { name: 'Star as key event' }));
    await waitFor(() => expect(mockStar).toHaveBeenCalledWith({ variables: { input: { issueId: 'issue-1', entryKey: 'audit:a2' } } }));
    expect(within(stateRow).getByRole('button', { name: 'Remove star' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(within(screen.getByTestId('comment-c1')).getByRole('button', { name: 'Remove star' }));
    await waitFor(() => expect(mockUnstar).toHaveBeenCalledWith({ variables: { input: { issueId: 'issue-1', entryKey: 'comment:c1' } } }));
    expect(within(screen.getByTestId('comment-c1')).getByRole('button', { name: 'Star as key event' })).toBeInTheDocument();
    expect(mockRefetch).toHaveBeenCalled();
  });

  it('narrows to key events and says why a star was refused', async () => {
    renderTimeline();
    fireEvent.click(screen.getByRole('button', { name: 'Key events only' }));
    const activity = screen.getByLabelText('Issue activity');
    expect(within(activity).getByText('Looks right')).toBeInTheDocument();
    expect(within(activity).queryByText('Created in Ready')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Key events only' }));

    mockStar.mockResolvedValueOnce({ data: { issueTimelineStar: { success: false, message: 'Team not found.', entryKey: null, starred: null } } });
    const createdRow = screen.getByText('Created in Ready').closest('.issue-activity__event') as HTMLElement;
    fireEvent.click(within(createdRow).getByRole('button', { name: 'Star as key event' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Team not found.');
    expect(within(createdRow).getByRole('button', { name: 'Star as key event' })).toBeInTheDocument();
  });
});

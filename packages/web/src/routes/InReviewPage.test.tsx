import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InReviewPage } from './InReviewPage';

const mockRunReview = vi.fn();
const mockRefetch = vi.fn().mockResolvedValue(undefined);
const mockFetchMore = vi.fn().mockResolvedValue(undefined);

const reviewItems = [
  {
    id: 'issue-r1',
    deliveryRootId: null as string | null,
    identifier: 'INV-101',
    title: 'Ship batch review UI',
    description: 'Multi-select accept/return',
    commitmentStatus: 'COMMITTED',
    kind: 'ISSUE',
    revision: 3,
    outcome: 'Batch review works',
    scope: 'web',
    constraints: null,
    acceptance: 'Bulk accept audited',
    verification: 'unit tests',
    repository: 'fakechris/Involute',
    createdAt: '2026-09-07T10:00:00.000Z',
    team: { id: 'team-1', key: 'INV' },
    assignee: { id: 'user-1', name: 'Admin', email: 'admin@involute.local', actorKind: 'HUMAN' },
    state: { id: 'state-review', name: 'In Review', type: 'REVIEW', position: 3 },
    reviewWait: { since: '2026-09-03T10:00:00.000Z', waitMs: 4 * 86_400_000, overdue: true },
  },
  {
    id: 'issue-r2',
    identifier: 'INV-102',
    title: 'Return ambiguous evidence',
    description: null,
    commitmentStatus: 'COMMITTED',
    kind: 'ISSUE',
    revision: 2,
    outcome: null,
    scope: null,
    constraints: null,
    acceptance: null,
    verification: null,
    repository: null,
    createdAt: '2026-09-07T11:00:00.000Z',
    team: { id: 'team-1', key: 'INV' },
    assignee: null,
    state: { id: 'state-review', name: 'In Review', type: 'REVIEW', position: 3 },
    pendingContractAmendment: { id: 'amend-1' },
  },
];

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  reviewItems[0]!.deliveryRootId = null;
  mockRunReview.mockResolvedValue({
    data: {
      workReview: {
        success: true,
        issue: { id: 'issue-r1', identifier: 'INV-101', revision: 4 },
        decision: { id: 'decision-1', decision: 'ACCEPTED' },
      },
    },
  });
});

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn(() => ({
    data: {
      issues: {
        nodes: reviewItems,
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    },
    loading: false,
    error: undefined,
    refetch: mockRefetch,
    fetchMore: mockFetchMore,
  })),
  useMutation: vi.fn(() => [mockRunReview, { loading: false }]),
}));

describe('InReviewPage', () => {
  it('routes inherited work to its package and excludes it from bulk acceptance', async () => {
    reviewItems[0]!.deliveryRootId = 'delivery-root';
    render(<MemoryRouter><InReviewPage /></MemoryRouter>);
    const child = screen.getByRole('listitem', { name: 'INV-101 in review' });
    expect(within(child).getByRole('button', { name: 'Review delivery package' })).toBeInTheDocument();
    expect(within(child).queryByRole('button', { name: /^Accept$/ })).toBeNull();
    expect(within(child).queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Select all visible' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Bulk accept' }));
    await waitFor(() => expect(mockRunReview).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(mockRunReview.mock.calls)).not.toContain('issue-r1');
  });

  // INV-1002
  it('shows how long each item has waited in Review and marks an overdue bug', () => {
    render(
      <MemoryRouter>
        <InReviewPage />
      </MemoryRouter>,
    );
    const first = screen.getByRole('listitem', { name: 'INV-101 in review' });
    expect(within(first).getByText('waiting 4d · overdue')).toBeInTheDocument();
    expect(within(first).getByText('waiting 4d · overdue')).toHaveClass('issue-relations__error');
  });

  it('marks work whose contract has a proposed change waiting (INV-869)', () => {
    render(
      <MemoryRouter>
        <InReviewPage />
      </MemoryRouter>,
    );
    const marked = screen.getByRole('listitem', { name: 'INV-102 in review' });
    expect(within(marked).getByRole('button', { name: 'contract change proposed' })).toBeInTheDocument();
    const unmarked = screen.getByRole('listitem', { name: 'INV-101 in review' });
    expect(within(unmarked).queryByRole('button', { name: 'contract change proposed' })).toBeNull();
  });

  it('filters In Review and supports multi-select plus bulk accept', async () => {
    render(
      <MemoryRouter>
        <InReviewPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'In Review' })).toBeInTheDocument();
    expect(screen.getByLabelText('In Review IQL filter')).toHaveValue('state:"In Review"');
    expect(screen.getByText('INV-101')).toBeInTheDocument();
    expect(screen.getByText('INV-102')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Select INV-101'));
    fireEvent.click(screen.getByLabelText('Select INV-102'));

    expect(screen.getByText('2 selected')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Bulk review reason'), {
      target: { value: 'Looks good' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bulk accept' }));

    await waitFor(() => expect(mockRunReview).toHaveBeenCalledTimes(2));
    expect(mockRunReview).toHaveBeenCalledWith({
      variables: {
        id: 'issue-r1',
        input: { decision: 'ACCEPTED', expectedRevision: 3, reason: 'Looks good' },
      },
    });
    expect(mockRunReview).toHaveBeenCalledWith({
      variables: {
        id: 'issue-r2',
        input: { decision: 'ACCEPTED', expectedRevision: 2, reason: 'Looks good' },
      },
    });
  });

  it('bulk rejects / returns selected In Review items via workReview', async () => {
    render(
      <MemoryRouter>
        <InReviewPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByLabelText('Select INV-101'));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk reject / return' }));

    await waitFor(() => expect(mockRunReview).toHaveBeenCalledTimes(1));
    expect(mockRunReview).toHaveBeenCalledWith({
      variables: {
        id: 'issue-r1',
        input: { decision: 'REJECTED', expectedRevision: 3 },
      },
    });
  });

  it('accepts or returns a single item and shows why a review was refused (INV-790)', async () => {
    render(
      <MemoryRouter>
        <InReviewPage />
      </MemoryRouter>,
    );
    const first = screen.getByRole('listitem', { name: 'INV-101 in review' });
    fireEvent.click(within(first).getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(mockRunReview).toHaveBeenCalledWith({ variables: { id: 'issue-r1', input: { decision: 'ACCEPTED', expectedRevision: 3 } } }),
    );
    await waitFor(() => expect(mockRefetch).toHaveBeenCalled());

    mockRunReview.mockResolvedValueOnce({ data: { workReview: { success: false, message: 'Work revision changed.', issue: null, decision: null } } });
    const second = screen.getByRole('listitem', { name: 'INV-102 in review' });
    fireEvent.click(within(second).getByRole('button', { name: 'Return' }));
    expect(await within(second).findByRole('alert')).toHaveTextContent('Work revision changed.');
    expect(mockRunReview).toHaveBeenLastCalledWith({ variables: { id: 'issue-r2', input: { decision: 'REJECTED', expectedRevision: 2 } } });
  });

  it('applies a custom IQL filter from the view bar', () => {
    render(
      <MemoryRouter>
        <InReviewPage />
      </MemoryRouter>,
    );

    const input = screen.getByLabelText('In Review IQL filter');
    fireEvent.change(input, { target: { value: 'state:"In Review" team:INV' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filter' }));
    expect(screen.getByText('Active: state:"In Review" team:INV')).toBeInTheDocument();
  });

  it('switches project with the pills and sends the repository filter (INV-1076)', async () => {
    const { useQuery } = await import('@apollo/client/react');
    render(
      <MemoryRouter initialEntries={['/in-review']}>
        <InReviewPage />
      </MemoryRouter>,
    );
    const switcher = screen.getByRole('tablist', { name: 'Project switcher' });
    expect(within(switcher).getByRole('tab', { name: /All Projects/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(switcher).getByRole('tab', { name: /fakechris\/Involute/ }));
    expect(within(switcher).getByRole('tab', { name: /fakechris\/Involute/ })).toHaveAttribute('aria-selected', 'true');
    const calls = (useQuery as unknown as { mock: { calls: Array<[unknown, { variables: { filter: Record<string, unknown> } }]> } }).mock.calls;
    expect(calls.some(([, options]) => (options.variables.filter as { repository?: { eq: string } }).repository?.eq === 'fakechris/Involute')).toBe(true);
  });

  it('narrows the queue with the shared filter bar on top of the IQL view (INV-1077)', async () => {
    const { useQuery } = await import('@apollo/client/react');
    render(
      <MemoryRouter initialEntries={['/in-review?project=fakechris/Involute']}>
        <InReviewPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'bug' } });
    fireEvent.change(screen.getByLabelText('Filter by priority'), { target: { value: '1' } });
    const calls = (useQuery as unknown as { mock: { calls: Array<[unknown, { variables: { query?: string | null; filter: { repository?: { eq: string } } } }]> } }).mock.calls;
    const last = calls.filter(([, options]) => options.variables.filter.repository?.eq === 'fakechris/Involute').at(-1)!;
    expect(last[1].variables.query).toMatch(/^state:"In Review".* label:bug priority:1$/);
  });

  it('says why the Auto-Accept Gate left a bug for a person (INV-1075)', () => {
    (reviewItems[0] as Record<string, unknown>).autoAccept = { outcome: 'SKIPPED', accepted: false, createdAt: '2026-10-09T10:00:00.000Z', reasons: ['the fix commit has no CI checks (NO_CHECKS)'] };
    render(
      <MemoryRouter>
        <InReviewPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/not auto-accepted: the fix commit has no CI checks/)).toBeInTheDocument();
    delete (reviewItems[0] as Record<string, unknown>).autoAccept;
  });
});


import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InReviewPage } from './InReviewPage';

const mockRunReview = vi.fn();
const mockRefetch = vi.fn().mockResolvedValue(undefined);
const mockFetchMore = vi.fn().mockResolvedValue(undefined);

const reviewItems = [
  {
    id: 'issue-r1',
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
  },
];

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
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
});

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  apolloMocks,
  boardQueryResult,
  renderApp,
  type IssueCreateMutationData,
  type IssueSummary,
} from './test/app-test-helpers';

describe('App issue creation', () => {
  it('shows a newly created SON issue on the Sonata board even when the initial workspace dataset exceeds 200 items', async () => {
    const invIssues = Array.from({ length: 200 }, (_, index) => ({
      id: `inv-issue-${index + 1}`,
      identifier: `INV-${index + 1}`,
      title: `Involute issue ${index + 1}`,
      description: `INV issue ${index + 1}`,
      createdAt: `2026-04-02T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
      updatedAt: `2026-04-02T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
      state: { id: 'state-backlog', name: 'Backlog' },
      team: { id: 'team-1', key: 'INV' },
      labels: { nodes: [] },
      assignee: null,
      children: { nodes: [] },
      parent: null,
      comments: { nodes: [] },
    })) satisfies IssueSummary[];

    const sonIssue = {
      id: 'son-issue-425',
      identifier: 'SON-425',
      title: 'Newest Sonata issue',
      description: 'Recently created in SON',
      createdAt: '2026-04-03T09:00:00.000Z',
      updatedAt: '2026-04-03T09:00:00.000Z',
      state: { id: 'son-backlog', name: 'Backlog' },
      team: { id: 'team-2', key: 'SON' },
      labels: { nodes: [] },
      assignee: null,
      children: { nodes: [] },
      parent: null,
      comments: { nodes: [] },
    } satisfies IssueSummary;

    renderApp(
      {
        data: {
          ...boardQueryResult,
          issues: {
            nodes: [...invIssues, sonIssue],
            pageInfo: boardQueryResult.issues.pageInfo,
          },
        },
        loading: false,
      },
      ['/'],
    );

    fireEvent.change(await screen.findByLabelText('Select team'), {
      target: { value: 'SON' },
    });

    expect(await within(screen.getByTestId('column-Backlog')).findByText('SON-425')).toBeInTheDocument();
    expect(screen.getByText('Newest Sonata issue')).toBeInTheDocument();
  });

  it('creates an issue from the board UI and shows it in the backlog column', async () => {
    const createIssue = vi.fn().mockResolvedValue({
      data: {
        issueCreate: {
          success: true,
          issue: {
            id: 'issue-3',
            identifier: 'INV-3',
            title: 'Created issue',
            description: 'Created description',
            createdAt: '2026-04-02T13:00:00.000Z',
            updatedAt: '2026-04-02T13:00:00.000Z',
            state: { id: 'state-backlog', name: 'Backlog' },
            team: { id: 'team-1', key: 'INV' },
            labels: { nodes: [] },
            assignee: null,
            children: { nodes: [] },
            parent: null,
            comments: { nodes: [] },
          },
        },
      } satisfies IssueCreateMutationData,
    });

    apolloMocks.useMutation.mockImplementation((document) => {
      const source =
        typeof document === 'string'
          ? document
          : 'loc' in document && document.loc?.source.body
            ? document.loc.source.body
            : String(document);

      if (source.includes('mutation IssueCreate')) {
        return [createIssue];
      }

      if (source.includes('mutation CommentCreate')) {
        return [vi.fn().mockResolvedValue({ data: { commentCreate: { success: true, comment: null } } })];
      }

      return [vi.fn()];
    });

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Create issue' }));

    const dialog = await screen.findByRole('dialog', { name: 'Create issue drawer' });
    fireEvent.change(within(dialog).getByLabelText('Issue title'), {
      target: { value: 'Created issue' },
    });
    fireEvent.change(within(dialog).getByLabelText('Issue description'), {
      target: { value: 'Created description' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create issue' }));

    await waitFor(() =>
      expect(createIssue).toHaveBeenCalledWith({
        variables: {
          input: {
            teamId: 'team-1',
            title: 'Created issue',
            description: 'Created description',
          },
        },
      }),
    );

    const backlogColumn = screen.getByTestId('column-Backlog');
    expect(await within(backlogColumn).findByText('INV-3')).toBeInTheDocument();
    expect(within(backlogColumn).getByText('Created issue')).toBeInTheDocument();
  });
});

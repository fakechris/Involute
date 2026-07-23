import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, getIssue, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { IssueUpdateMutationData } from './board/types';

function renderTestApp(queryState = { data: boardQueryResult, loading: false }, initialEntries: string[] = ['/']) {
  return renderApp(App, queryState, initialEntries);
}

describe('App issue detail editing', () => {
  it('shows inline title editing guidance while the title input is focused', async () => {
    renderTestApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    const titleInput = within(drawer).getByLabelText('Issue title');

    expect(within(drawer).getByText('Editable title')).toBeInTheDocument();

    fireEvent.focus(titleInput);
    expect(within(drawer).getByText('Press Enter or blur to save')).toBeInTheDocument();

    fireEvent.blur(titleInput);
    await waitFor(() => expect(within(drawer).getByText('Editable title')).toBeInTheDocument());
  });

  it('saves title on Enter and keeps the new value after reopening', async () => {
    const mutate = vi.fn().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...getIssue('issue-1'),
            title: 'Enter-saved title',
          },
        },
      } satisfies IssueUpdateMutationData,
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderTestApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    let drawer = await screen.findByLabelText('Issue detail drawer');

    const titleInput = within(drawer).getByLabelText('Issue title');
    fireEvent.change(titleInput, { target: { value: 'Enter-saved title' } });
    fireEvent.keyDown(titleInput, { key: 'Enter', code: 'Enter' });

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        variables: {
          id: 'issue-1',
          input: { title: 'Enter-saved title' },
        },
      }),
    );

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    drawer = await screen.findByLabelText('Issue detail drawer');

    expect(within(drawer).getByLabelText('Issue title')).toHaveValue('Enter-saved title');
  });

  it('edits title and saves it via issueUpdate mutation', async () => {
    const mutate = vi.fn().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...getIssue('issue-1'),
            title: 'Updated backlog item',
          },
        },
      } satisfies IssueUpdateMutationData,
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderTestApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByLabelText('Issue detail drawer');

    const titleInput = within(drawer).getByLabelText('Issue title');
    fireEvent.change(titleInput, { target: { value: 'Updated backlog item' } });
    fireEvent.blur(titleInput);

    await waitFor(() =>
      expect(mutate).toHaveBeenNthCalledWith(1, {
        variables: {
          id: 'issue-1',
          input: { title: 'Updated backlog item' },
        },
      }),
    );
  });

  it('edits description and saves it via issueUpdate mutation', async () => {
    const mutate = vi.fn().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...getIssue('issue-1'),
            description: 'Updated description',
          },
        },
      } satisfies IssueUpdateMutationData,
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderTestApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByLabelText('Issue detail drawer');

    fireEvent.click(within(drawer).getByLabelText('Edit description'));
    const descriptionInput = within(drawer).getByLabelText('Issue description');
    fireEvent.change(descriptionInput, { target: { value: 'Updated description' } });
    fireEvent.click(within(drawer).getByText('Save'));

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        variables: {
          id: 'issue-1',
          input: { description: 'Updated description' },
        },
      }),
    );

    await waitFor(() =>
      expect(within(drawer).getByText('Updated description')).toBeInTheDocument(),
    );
  });

  it('resyncs the visible description after a successful save without closing the drawer', async () => {
    const mutate = vi.fn().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...getIssue('issue-1'),
            description: 'Persisted description from server',
          },
        },
      } satisfies IssueUpdateMutationData,
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderTestApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByLabelText('Issue detail drawer');

    fireEvent.click(within(drawer).getByLabelText('Edit description'));
    const descriptionInput = within(drawer).getByLabelText('Issue description');
    fireEvent.change(descriptionInput, { target: { value: 'Locally edited draft' } });
    fireEvent.click(within(drawer).getByText('Save'));

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        variables: {
          id: 'issue-1',
          input: { description: 'Locally edited draft' },
        },
      }),
    );

    await waitFor(() =>
      expect(within(drawer).getByText('Persisted description from server')).toBeInTheDocument(),
    );
  });

  it('resets drawer state when reopening a different issue', async () => {
    renderTestApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const firstDrawer = await screen.findByLabelText('Issue detail drawer');
    fireEvent.change(within(firstDrawer).getByLabelText('Issue title'), {
      target: { value: 'Unsaved title draft' },
    });
    fireEvent.click(within(firstDrawer).getByRole('button', { name: 'Close' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-2' }));
    const secondDrawer = await screen.findByLabelText('Issue detail drawer');

    expect(within(secondDrawer).getByLabelText('Issue title')).toHaveValue('Ready item');
    expect(within(secondDrawer).getByText('Ready description')).toBeInTheDocument();
  });

  it('shows the updated title after closing and reopening the same issue', async () => {
    const mutate = vi.fn().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...getIssue('issue-1'),
            title: 'Persisted title',
          },
        },
      } satisfies IssueUpdateMutationData,
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderTestApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    let drawer = await screen.findByLabelText('Issue detail drawer');

    const titleInput = within(drawer).getByLabelText('Issue title');
    fireEvent.change(titleInput, { target: { value: 'Persisted title' } });
    fireEvent.blur(titleInput);

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        variables: {
          id: 'issue-1',
          input: { title: 'Persisted title' },
        },
      }),
    );

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    drawer = await screen.findByLabelText('Issue detail drawer');

    expect(within(drawer).getByLabelText('Issue title')).toHaveValue('Persisted title');
  });
});

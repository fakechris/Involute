import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, getDocumentSource, getIssue, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { IssueUpdateMutationData } from './board/types';

type TestQueryState = Exclude<Parameters<typeof renderApp>[1], string[]>;

function renderTestApp(
  queryState: TestQueryState = { data: boardQueryResult, loading: false },
  initialEntries: string[] = ['/'],
) {
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
          input: { expectedRevision: 1, title: 'Enter-saved title' },
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
          input: { expectedRevision: 1, title: 'Updated backlog item' },
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
          input: { description: 'Updated description', expectedRevision: 1 },
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
          input: { description: 'Locally edited draft', expectedRevision: 1 },
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
          input: { expectedRevision: 1, title: 'Persisted title' },
        },
      }),
    );

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    drawer = await screen.findByLabelText('Issue detail drawer');

    expect(within(drawer).getByLabelText('Issue title')).toHaveValue('Persisted title');
  });

  it('reloads the latest issue after a revision conflict before retrying', async () => {
    const mutate = vi.fn().mockResolvedValue({
      data: { issueUpdate: { success: false, issue: null } } satisfies IssueUpdateMutationData,
    });
    const latestIssue = { ...getIssue('issue-1'), revision: 2, title: 'Changed by another actor' };
    const refetch = vi.fn().mockResolvedValue({ data: { issue: latestIssue } });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderTestApp({ data: boardQueryResult, loading: false, refetch }, ['/issue/issue-1']);
    const titleInput = await screen.findByLabelText('Issue title');
    fireEvent.change(titleInput, { target: { value: 'My stale edit' } });
    fireEvent.blur(titleInput);

    expect(await screen.findByText(/latest version was reloaded/i)).toBeInTheDocument();
    expect(refetch).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText('Issue title')).toHaveValue('Changed by another actor'));
  });
  it('lets a human rewrite the contract on the issue page (INV-786)', async () => {
    const mutate = vi.fn().mockImplementation(({ variables }) =>
      Promise.resolve({
        data: {
          issueUpdate: {
            success: true,
            message: null,
            issue: { ...getIssue('issue-1'), ...variables.input, revision: 2 },
          },
        } satisfies IssueUpdateMutationData,
      }),
    );
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderTestApp({ data: boardQueryResult, loading: false }, ['/issue/issue-1']);
    const contract = await screen.findByRole('region', { name: 'Contract' });
    fireEvent.click(within(contract).getByRole('button', { name: 'Edit contract' }));
    fireEvent.change(within(contract).getByLabelText('Contract Scope'), {
      target: { value: 'Research stays local; only one line in docs/73' },
    });
    fireEvent.change(within(contract).getByLabelText('Contract Acceptance'), {
      target: { value: 'docs/73 has the row' },
    });
    fireEvent.click(within(contract).getByRole('button', { name: 'Save contract' }));

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        variables: {
          id: 'issue-1',
          input: {
            expectedRevision: 1,
            scope: 'Research stays local; only one line in docs/73',
            acceptance: 'docs/73 has the row',
          },
        },
      }),
    );
    expect(await within(contract).findByText('Research stays local; only one line in docs/73')).toBeInTheDocument();
    expect(within(contract).queryByRole('button', { name: 'Save contract' })).not.toBeInTheDocument();
  });

  it('keeps the contract editor open and shows why the server refused', async () => {
    const mutate = vi.fn().mockResolvedValue({
      data: {
        issueUpdate: { success: false, issue: null, message: 'Committed work requires acceptance criteria.' },
      } satisfies IssueUpdateMutationData,
    });
    const refetch = vi.fn().mockResolvedValue({ data: { issue: getIssue('issue-1') } });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderTestApp({ data: boardQueryResult, loading: false, refetch }, ['/issue/issue-1']);
    const contract = await screen.findByRole('region', { name: 'Contract' });
    fireEvent.click(within(contract).getByRole('button', { name: 'Edit contract' }));
    fireEvent.change(within(contract).getByLabelText('Contract Outcome'), { target: { value: 'New outcome' } });
    fireEvent.click(within(contract).getByRole('button', { name: 'Save contract' }));

    expect(await screen.findByText('Committed work requires acceptance criteria.')).toBeInTheDocument();
    expect(within(contract).getByRole('button', { name: 'Save contract' })).toBeInTheDocument();
  });

  it('shows an agent\'s proposed contract change in the board drawer, and accepts it there (INV-896)', async () => {
    const accept = vi.fn().mockResolvedValue({ data: { contractAmendmentAccept: { success: true, message: null } } });
    const fallback = apolloMocks.useMutation.getMockImplementation() as ((document: unknown) => unknown) | undefined;
    apolloMocks.useMutation.mockImplementation((document: unknown) =>
      getDocumentSource(document).includes('mutation ContractAmendmentAccept') ? [accept] : fallback!(document),
    );
    const contractRefetch = vi.fn().mockResolvedValue(undefined);
    renderApp(
      App,
      {
        data: boardQueryResult,
        loading: false,
        contractRefetch,
        contractData: {
          issue: {
            id: 'issue-1',
            revision: 7,
            commitmentStatus: 'COMMITTED',
            outcome: 'No new implementation work.',
            scope: null,
            constraints: null,
            acceptance: 'Findings recorded.',
            verification: null,
            pendingContractAmendment: {
              id: 'amendment-1',
              reason: 'The review found three gaps worth fixing.',
              stale: false,
              proposedByClaimant: false,
              createdAt: '2026-09-30T14:00:00.000Z',
              proposedBy: { id: 'agent-1', name: 'Claude Code', email: null },
              changes: [{ field: 'outcome', before: 'No new implementation work.', after: 'Three fixes shipped.' }],
            },
          },
        },
      },
      ['/'],
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    const contract = within(drawer).getByRole('region', { name: 'Contract' });
    // The drawer shows the issue's own contract, not the board card's empty fields.
    expect(within(contract).getByText('Findings recorded.')).toBeInTheDocument();
    const proposal = within(contract).getByRole('region', { name: 'Proposed contract change' });
    expect(within(proposal).getByText(/three gaps worth fixing/)).toBeInTheDocument();

    fireEvent.click(within(proposal).getByRole('button', { name: 'Accept change' }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith({ variables: { input: { amendmentId: 'amendment-1' } } }));
    await waitFor(() => expect(contractRefetch).toHaveBeenCalled());
  });

  it('shows no proposal panel in the drawer when nothing is pending', async () => {
    renderTestApp();
    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    const contract = within(drawer).getByRole('region', { name: 'Contract' });
    expect(within(contract).queryByRole('region', { name: 'Proposed contract change' })).not.toBeInTheDocument();
  });
});

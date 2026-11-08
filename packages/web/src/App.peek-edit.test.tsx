import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IssueSummary, IssueUpdateMutationData } from './board/types';
import { apolloMocks, boardQueryResult, getDocumentSource, renderApp } from './test/app-test-helpers';
import { App } from './App';

const press = (key: string, init: KeyboardEventInit = {}) => act(() => { fireEvent.keyDown(window, { key, ...init }); });

async function focusCard(id: string) {
  for (let step = 0; step < 6 && screen.getByTestId(`issue-card-${id}`).getAttribute('data-focused') !== 'true'; step += 1) press(step < 3 ? 'k' : 'j');
  await waitFor(() => expect(screen.getByTestId(`issue-card-${id}`)).toHaveAttribute('data-focused', 'true'));
}

function installUpdate(update: (...args: unknown[]) => unknown) {
  apolloMocks.useMutation.mockImplementation((document: unknown) => {
    if (getDocumentSource(document).includes('mutation IssueUpdate')) return [update];
    return [vi.fn()];
  });
}

afterEach(() => cleanup());

describe('board peek editing (INV-271)', () => {
  it('applies a slow save to the issue that sent it after the preview moves on', async () => {
    let resolveUpdate: (value: { data: IssueUpdateMutationData }) => void = () => {};
    const update = vi.fn(() => new Promise<{ data: IssueUpdateMutationData }>((resolve) => {
      resolveUpdate = resolve;
    }));
    installUpdate(update);
    renderApp(App, { data: boardQueryResult, loading: false }, ['/']);

    await screen.findByTestId('issue-card-issue-1');
    await focusCard('issue-1');
    press(' ');
    const peek = await screen.findByRole('dialog', { name: 'Peek INV-1' });
    fireEvent.click(within(peek).getByRole('button', { name: 'Edit description' }));
    fireEvent.change(within(peek).getByRole('textbox', { name: 'Description' }), { target: { value: 'from A' } });
    fireEvent.click(within(peek).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({
      variables: { id: 'issue-1', input: { description: 'from A', expectedRevision: 1 } },
    }));

    // Default sort is updatedAt desc, so INV-2 sits above INV-1. k moves up.
    press('k');
    const next = await screen.findByRole('dialog', { name: 'Peek INV-2' });
    expect(within(next).getByText('Ready description')).toBeInTheDocument();
    expect(within(next).queryByDisplayValue('from A')).not.toBeInTheDocument();

    const issue = boardQueryResult.issues.nodes[0] as IssueSummary;
    await act(async () => {
      resolveUpdate({
        data: { issueUpdate: { success: true, issue: { ...issue, description: 'from A', revision: 2 } } },
      });
    });

    expect(screen.getByRole('dialog', { name: 'Peek INV-2' })).toHaveTextContent('Ready description');
    press('j');
    const back = await screen.findByRole('dialog', { name: 'Peek INV-1' });
    expect(within(back).getByText('Saved')).toBeInTheDocument();
    expect(within(back).getByText('from A')).toBeInTheDocument();
  });

  it('keeps the draft when the save is refused, and sends it again only from Apply my draft', async () => {
    const update = vi.fn()
      .mockResolvedValueOnce({
        data: { issueUpdate: { success: false, issue: null, message: 'Work revision does not match expected_revision.' } },
      })
      .mockResolvedValueOnce({
        data: {
          issueUpdate: {
            success: true,
            issue: { ...(boardQueryResult.issues.nodes[0] as IssueSummary), description: 'from A', revision: 9 },
          },
        },
      });
    installUpdate(update);
    const contractRefetch = vi.fn().mockResolvedValue({
      data: { issue: { id: 'issue-1', revision: 8, description: 'server copy', parent: null } },
    });
    renderApp(App, { data: boardQueryResult, loading: false, contractRefetch }, ['/']);

    await screen.findByTestId('issue-card-issue-1');
    await focusCard('issue-1');
    press(' ');
    const peek = await screen.findByRole('dialog', { name: 'Peek INV-1' });
    fireEvent.click(within(peek).getByRole('button', { name: 'Edit description' }));
    fireEvent.change(within(peek).getByRole('textbox', { name: 'Description' }), { target: { value: 'from A' } });
    fireEvent.click(within(peek).getByRole('button', { name: 'Save' }));

    expect(await within(peek).findByText('server copy')).toBeInTheDocument();
    expect(within(peek).getByRole('textbox', { name: 'Description' })).toHaveValue('from A');

    fireEvent.click(within(peek).getByRole('button', { name: 'Apply my draft' }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({
      variables: { id: 'issue-1', input: { description: 'from A', expectedRevision: 8 } },
    }));
  });

  it('keeps a dirty draft when the preview is closed and opened again', async () => {
    installUpdate(vi.fn());
    renderApp(App, { data: boardQueryResult, loading: false }, ['/']);
    await screen.findByTestId('issue-card-issue-1');
    await focusCard('issue-1');
    press(' ');
    const peek = await screen.findByRole('dialog', { name: 'Peek INV-1' });
    fireEvent.click(within(peek).getByRole('button', { name: 'Edit description' }));
    fireEvent.change(within(peek).getByRole('textbox', { name: 'Description' }), { target: { value: 'still here' } });
    press(' ');
    expect(screen.queryByRole('dialog', { name: 'Peek INV-1' })).not.toBeInTheDocument();
    press(' ');
    const again = await screen.findByRole('dialog', { name: 'Peek INV-1' });
    expect(within(again).getByRole('textbox', { name: 'Description' })).toHaveValue('still here');
    expect(within(again).getByText(/Draft kept/)).toBeInTheDocument();
    fireEvent.click(within(again).getByRole('button', { name: 'Cancel' }));
    expect(within(again).getByText('Backlog description')).toBeInTheDocument();
  });
});

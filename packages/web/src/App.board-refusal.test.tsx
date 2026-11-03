import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';

// INV-1534: a refused save says why where the person acted.
const MESSAGE = 'INV-1 is part of delivery package INV-9: accept INV-9 from In Review; that accepts every implementation unit together.';

describe('refused saves on the board (INV-1534)', () => {
  it('shows the server reason in the drawer under its header and in a floating notice that can be dismissed', async () => {
    const update = vi.fn().mockResolvedValue({ data: { issueUpdate: { success: false, message: MESSAGE, issue: null } } });
    apolloMocks.useMutation.mockImplementation((document: { loc?: { source: { body: string } } }) =>
      (document?.loc?.source.body ?? '').includes('mutation IssueUpdate') ? [update] : [vi.fn()]);
    renderApp(App, { data: boardQueryResult, loading: false }, ['/']);

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    const done = boardQueryResult.teams.nodes[0]!.states.nodes.find((state) => state.type === 'COMPLETED')!;
    fireEvent.change(within(drawer).getByLabelText('Issue state'), { target: { value: done.id } });

    await waitFor(() => expect(update).toHaveBeenCalled());
    const inDrawer = await within(drawer).findByText(MESSAGE);
    // Right under the header, before the two columns, not at the bottom of the drawer.
    expect(inDrawer.nextElementSibling).toHaveClass('issue-panel__body');

    const floating = screen.getAllByRole('alert').find((element) => element.classList.contains('page-notice--floating'))!;
    expect(floating).toHaveTextContent(MESSAGE);
    fireEvent.click(within(floating).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryAllByRole('alert').some((element) => element.classList.contains('page-notice--floating'))).toBe(false));
  });
});

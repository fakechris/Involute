import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { print } from 'graphql';

import { apolloMocks, boardQueryResult, getDocumentSource, renderApp } from './test/app-test-helpers';
import { App } from './App';
import { BOARD_PAGE_QUERY, ISSUE_DETAIL_QUERY } from './board/queries';
import type { IssueSummary } from './board/types';

/**
 * INV-1470: a hundred cards do not carry their bodies. The board list leaves
 * the descriptions out — they were half its payload and no card renders them
 * — and the drawer and the peek ask for the one issue they show.
 */

/** The list as the server now answers it: no bodies on the cards. */
function withoutBody(issue: IssueSummary): IssueSummary {
  const { description: _body, ...rest } = issue;

  return rest;
}

const slimBoard = {
  ...boardQueryResult,
  issues: {
    ...boardQueryResult.issues,
    nodes: boardQueryResult.issues.nodes.map(withoutBody),
  },
};

/** The issue's own answer: the contract, and the body the list left out. */
function detailOf(id: string, description: string) {
  return {
    detailData: {
      issue: {
        id,
        revision: 1,
        commitmentStatus: 'COMMITTED',
        description,
        outcome: null,
        scope: null,
        constraints: null,
        acceptance: null,
        verification: null,
        pendingContractAmendment: null,
      },
    },
  };
}

const press = (key: string, init: KeyboardEventInit = {}) => act(() => { fireEvent.keyDown(window, { key, ...init }); });

/** Focus a card by walking J/K until it holds the focus ring. */
async function focusCard(id: string) {
  for (let step = 0; step < 6 && screen.getByTestId(`issue-card-${id}`).getAttribute('data-focused') !== 'true'; step += 1) press(step < 3 ? 'k' : 'j');
  await waitFor(() => expect(screen.getByTestId(`issue-card-${id}`)).toHaveAttribute('data-focused', 'true'));
}

describe('board list without bodies (INV-1470)', () => {
  it('leaves the descriptions out of the list query and asks for them with the issue', () => {
    // The board does not ask for the bodies; a page that searches them does.
    expect(print(BOARD_PAGE_QUERY)).toMatch(/description @include\(if: \$withDescriptions\)/);
    expect(print(ISSUE_DETAIL_QUERY)).toMatch(/description/);
  });

  it('asks for the bodies on My Issues, which searches them', async () => {
    apolloMocks.useQuery.mockClear();
    renderApp(App, { data: boardQueryResult, loading: false }, ['/my-issues']);

    await waitFor(() => {
      const boardCall = apolloMocks.useQuery.mock.calls.find(([document]) =>
        getDocumentSource(document).includes('query BoardPage'),
      );
      expect(boardCall?.[1]).toMatchObject({ variables: { withDescriptions: true } });
    });
  });

  it('shows the body the drawer asked for, not one the list carried', async () => {
    renderApp(App, { data: slimBoard, loading: false, ...detailOf('issue-1', 'The body the list no longer carries.') }, ['/']);

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    expect(await within(drawer).findByText('The body the list no longer carries.')).toBeInTheDocument();
  });

  it('shows the peeked issue\'s body from the issue itself', async () => {
    renderApp(App, { data: slimBoard, loading: false, ...detailOf('issue-1', 'The peeked body.') }, ['/']);

    await screen.findByText('INV-1');
    await focusCard('issue-1');
    press(' ');

    const peek = await screen.findByRole('dialog', { name: 'Peek INV-1' });
    expect(await within(peek).findByText('The peeked body.')).toBeInTheDocument();
  });

  it('does not invite a description while the body is still on its way', async () => {
    renderApp(App, { data: slimBoard, loading: false, detailLoading: true }, ['/']);

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });

    // The body may already be there; asking for a new one would overwrite it.
    expect(await within(drawer).findByText('Loading description…')).toBeInTheDocument();
    expect(within(drawer).queryByText('Add a description…')).not.toBeInTheDocument();
  });

  it('keeps the issues the server matched when a text query is on', async () => {
    window.localStorage.setItem('involute.activeTeamKey', 'INV');
    window.localStorage.setItem(
      'involute.board.viewState.INV',
      JSON.stringify({ query: 'meituan', sortField: 'updatedAt', sortDirection: 'desc' }),
    );

    renderApp(App, { data: slimBoard, loading: false }, ['/']);

    // The list carries no bodies, so a second client-side search would find
    // nothing and empty the board. The server searched those bodies and
    // returned what matched; the board keeps its answer (INV-1470).
    expect(await screen.findByRole('button', { name: 'Open INV-1' })).toBeInTheDocument();
  });
});

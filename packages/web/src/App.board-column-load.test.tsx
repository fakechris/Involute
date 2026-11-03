import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apolloMocks, boardQueryResult, getIssue, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { IssueSummary } from './board/types';

// INV-1539: a column's Load more asks for that column, once, and stays loaded.
describe('a column loads its own items (INV-1539)', () => {
  const team = boardQueryResult.teams.nodes[0]!;
  const column = team.states.nodes.find((state) => state.type === 'STARTED')!;
  const loaded = boardQueryResult.issues.nodes.filter((issue) => issue.state.id === column.id).length;
  const older: IssueSummary[] = [1, 2].map((n) => ({
    ...getIssue('issue-1'),
    id: `older-${n}`,
    identifier: `INV-90${n}`,
    title: `Older started item ${n}`,
    state: { id: column.id, name: column.name, type: column.type, position: column.position },
  }));
  const columnData = { issues: { nodes: older, pageInfo: { hasNextPage: false, endCursor: null } } };
  const data = {
    ...boardQueryResult,
    issueStateCounts: [{ stateId: column.id, count: loaded + 2 }],
    issues: { ...boardQueryResult.issues, pageInfo: { ...boardQueryResult.issues.pageInfo, hasNextPage: true, endCursor: 'cursor-2' } },
  };

  it('shows every remaining item of the column on one click, and keeps them after the board is shown again', async () => {
    window.localStorage.removeItem('involute:column-loads');
    renderApp(App, { data, loading: false, columnData }, ['/']);

    const region = await screen.findByRole('region', { name: `${column.name} column` });
    expect(within(region).getByText('2 more not loaded')).toBeInTheDocument();
    fireEvent.click(within(region).getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(within(region).getByText('Older started item 1')).toBeInTheDocument());
    expect(within(region).getByText('Older started item 2')).toBeInTheDocument();
    expect(within(region).queryByText(/more not loaded/)).toBeNull();
    // The column asked for its own state under the board's filters, enough for all it holds.
    const asked = apolloMocks.useQuery.mock.calls
      .filter(([document]) => ((document as { loc?: { source: { body: string } } }).loc?.source.body ?? '').includes('query BoardColumnIssues'))
      .map(([, options]) => options?.variables);
    expect(asked[0]).toMatchObject({ first: loaded + 2, orderBy: 'UPDATED', filter: { stateIds: [column.id] } });

    // A reload (or any return to the board) shows the same column, not the first page again.
    cleanup();
    renderApp(App, { data, loading: false, columnData }, ['/']);
    const again = await screen.findByRole('region', { name: `${column.name} column` });
    await waitFor(() => expect(within(again).getByText('Older started item 2')).toBeInTheDocument());
    expect(JSON.parse(window.localStorage.getItem('involute:column-loads') ?? '{}')).toEqual({ [column.id]: loaded + 2 });
    window.localStorage.removeItem('involute:column-loads');
  });
});

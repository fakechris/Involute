import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

// The helpers mock Apollo; they load before the page so the page gets the mock.
import { apolloMocks, boardQueryResult, renderApp } from './test/app-test-helpers';
import { buildSearchIql } from './routes/SearchPage';
import type { WorkSearchQueryData } from './work/types';

const searchData: WorkSearchQueryData = {
  search: [
    {
      matchedField: 'contract',
      snippet: '…人工审批通过即可…',
      commentId: null,
      issue: {
        id: 'issue-1',
        identifier: 'INV-1',
        title: '候选队列',
        state: { id: 'state-backlog', name: 'Backlog', type: 'BACKLOG' },
        team: { id: 'team-1', key: 'INV' },
      },
    },
  ],
};

function searchVariables() {
  return apolloMocks.useQuery.mock.calls
    .filter(([document]) => String((document as { loc?: { source: { body: string } } })?.loc?.source.body ?? '').includes('query WorkSearch'))
    .map(([, options]) => options as { variables: Record<string, unknown>; skip?: boolean })
    .filter((options) => !options.skip)
    .map((options) => options.variables);
}

describe('Search page (INV-926)', () => {
  it('turns kind, state and label into the IQL work_search takes', () => {
    expect(buildSearchIql({ kind: '', state: '', label: '', iql: '' })).toBe('');
    expect(buildSearchIql({ kind: 'EPIC', state: 'STARTED', label: 'Needs triage', iql: 'priority:1' }))
      .toBe('kind:EPIC state-type:STARTED label:"Needs triage" priority:1');
  });

  it('lists every hit with where it matched, the snippet and highlighted words', async () => {
    renderApp({ data: boardQueryResult, loading: false, searchData }, ['/search?q=审批']);

    const results = await screen.findByRole('list', { name: 'Search results' });
    const link = within(results).getByRole('link', { name: /INV-1/ });
    expect(link).toHaveAttribute('href', '/issue/issue-1');
    expect(link).toHaveTextContent('in contract');
    expect(within(results).getByText('审批', { selector: 'mark' })).toBeInTheDocument();
    expect(searchVariables().at(-1)).toEqual({ query: '审批', first: 100 });
  });

  it('narrows by kind, state, label and project through the query it sends', async () => {
    renderApp(
      { data: boardQueryResult, loading: false, searchData },
      ['/search?q=审批&project=fakechris/lumenbox'],
    );
    const filters = await screen.findByLabelText('Search filters');

    fireEvent.change(within(filters).getByLabelText('Kind'), { target: { value: 'EPIC' } });
    fireEvent.change(within(filters).getByLabelText('State'), { target: { value: 'STARTED' } });
    fireEvent.change(within(filters).getByLabelText('Label'), { target: { value: 'Bug' } });

    await waitFor(() => {
      expect(searchVariables().at(-1)).toEqual({
        query: '审批',
        first: 100,
        iql: 'kind:EPIC state-type:STARTED label:"Bug"',
        repository: 'fakechris/lumenbox',
      });
    });
  });

  it('opens from ⌘K with "View all results"', async () => {
    renderApp({ data: boardQueryResult, loading: false, searchData }, ['/']);
    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Open command palette/i }));
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    fireEvent.change(within(palette).getByLabelText('Search commands'), { target: { value: '审批' } });
    fireEvent.click(within(palette).getByRole('button', { name: /View all results/ }));

    expect(await screen.findByRole('heading', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByLabelText('Search all work')).toHaveValue('审批');
  });
});

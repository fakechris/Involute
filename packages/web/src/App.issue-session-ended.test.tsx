import { CombinedGraphQLErrors } from '@apollo/client';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ISSUE_PAGE_QUERY } from './board/queries';
import { apolloMocks, boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';

// INV-2143: when the session ends while an issue page is open, the page keeps
// what it loaded and the draft being written; only a first load shows the error.
describe('issue page when the session ends', () => {
  it('keeps the issue and the comment draft after its query is refused as signed out', async () => {
    renderApp(App, { data: boardQueryResult, loading: false }, ['/issue/issue-1']);
    const draft = await screen.findByPlaceholderText('Leave a comment…');
    fireEvent.change(draft, { target: { value: 'Half-written thought' } });
    const title = boardQueryResult.issues.nodes.find((issue) => issue.id === 'issue-1')!.title;
    expect(screen.getAllByText(title).length).toBeGreaterThan(0);

    const answer = apolloMocks.useQuery.getMockImplementation() as (document: unknown, options: unknown) => { data?: unknown };
    const signedOut = new CombinedGraphQLErrors({ errors: [{ message: 'Not authenticated' }] });
    apolloMocks.useQuery.mockImplementation((document: unknown, options: unknown) => {
      const result = answer(document, options);
      return document === ISSUE_PAGE_QUERY ? { ...result, data: undefined, previousData: result.data, error: signedOut } : result;
    });
    // Any re-render now sees the refused query.
    fireEvent.change(screen.getByPlaceholderText('Leave a comment…'), { target: { value: 'Half-written thought, still here' } });

    expect(screen.getByPlaceholderText('Leave a comment…')).toHaveValue('Half-written thought, still here');
    expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Sign in with Google/)).toBeNull();
  });

  it('still shows the error when the very first load is refused', async () => {
    const signedOut = new CombinedGraphQLErrors({ errors: [{ message: 'Not authenticated' }] });
    renderApp(App, { data: boardQueryResult, loading: false }, ['/issue/issue-1']);
    const answer = apolloMocks.useQuery.getMockImplementation() as (document: unknown, options: unknown) => { data?: unknown };
    apolloMocks.useQuery.mockImplementation((document: unknown, options: unknown) => {
      const result = answer(document, options);
      return document === ISSUE_PAGE_QUERY ? { ...result, data: undefined, previousData: undefined, error: signedOut } : result;
    });
    fireEvent.change(await screen.findByPlaceholderText('Leave a comment…'), { target: { value: 'x' } });
    expect(screen.queryByPlaceholderText('Leave a comment…')).toBeNull();
  });
});

import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderApp } from './test/app-test-helpers';
import { boardQueryResult } from './test/app-test-helpers';
import {
  APP_SHELL_ISSUES_STORAGE_KEY,
  type AppShellIssueSummary,
} from './lib/app-shell-state';

describe('App shell state', () => {
  it('preserves the existing shell issue history when the direct issue page stores the current issue', async () => {
    const existingIssues: AppShellIssueSummary[] = [
      {
        id: 'issue-existing',
        identifier: 'SON-9',
        stateName: 'Backlog',
        teamKey: 'SON',
        title: 'Persisted recent issue',
      },
    ];

    window.localStorage.setItem(APP_SHELL_ISSUES_STORAGE_KEY, JSON.stringify(existingIssues));

    renderApp({ data: boardQueryResult, loading: false }, ['/issue/issue-2']);

    expect(await screen.findByRole('heading', { name: 'Issue detail' })).toBeInTheDocument();

    await waitFor(() => {
      const storedIssues = JSON.parse(
        window.localStorage.getItem(APP_SHELL_ISSUES_STORAGE_KEY) ?? '[]',
      ) as AppShellIssueSummary[];

      expect(storedIssues.map((issue) => issue.id)).toEqual(
        expect.arrayContaining(['issue-existing', 'issue-2']),
      );
    });
  });
});

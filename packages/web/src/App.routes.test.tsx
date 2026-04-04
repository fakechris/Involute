import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apolloMocks, boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';
import { ACTIVE_TEAM_STORAGE_KEY } from './board/utils';

function renderTestApp(queryState = { data: boardQueryResult, loading: false }, initialEntries: string[] = ['/']) {
  return renderApp(App, queryState, initialEntries);
}

describe('App routes and team flows', () => {
  it('persists the selected team across reload by restoring the saved team key from localStorage', async () => {
    window.localStorage.setItem(ACTIVE_TEAM_STORAGE_KEY, 'SON');

    renderTestApp({ data: boardQueryResult, loading: false }, ['/']);

    expect(await screen.findByText('Workflow overview for Sonata.')).toBeInTheDocument();
    expect(screen.getByLabelText('Select team')).toHaveValue('SON');
    expect(within(screen.getByTestId('column-Backlog')).getByText('SON-1')).toBeInTheDocument();
    expect(apolloMocks.useQuery).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        variables: {
          first: 200,
          filter: {
            team: {
              key: {
                eq: 'SON',
              },
            },
          },
        },
      }),
    );
  });

  it('hydrates the persisted team key before the initial board query runs on reload', async () => {
    window.localStorage.setItem(ACTIVE_TEAM_STORAGE_KEY, 'SON');

    renderTestApp({ data: boardQueryResult, loading: false }, ['/']);

    expect(apolloMocks.useQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        variables: {
          first: 200,
          filter: {
            team: {
              key: {
                eq: 'SON',
              },
            },
          },
        },
      }),
    );

    expect(await screen.findByText('Workflow overview for Sonata.')).toBeInTheDocument();
  });
});

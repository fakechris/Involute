import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  apolloMocks,
  boardQueryResult,
  renderApp,
} from './test/app-test-helpers';
import { ACTIVE_TEAM_STORAGE_KEY } from './board/utils';

describe('App team selection', () => {
  it('keeps board filtering in sync after changing teams and navigating from backlog', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/backlog']);

    fireEvent.change(await screen.findByLabelText('Select team'), {
      target: { value: 'SON' },
    });

    expect(await screen.findByText('Sonata backlog item')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Board' }));

    expect(await screen.findByText('Workflow overview for Sonata.')).toBeInTheDocument();
    expect(within(screen.getByTestId('column-Backlog')).getByText('SON-1')).toBeInTheDocument();
  });

  it('persists the selected team across reload by restoring the saved team key from localStorage', async () => {
    window.localStorage.setItem(ACTIVE_TEAM_STORAGE_KEY, 'SON');

    renderApp({ data: boardQueryResult, loading: false }, ['/']);

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

    renderApp({ data: boardQueryResult, loading: false }, ['/']);

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

  it('stores the active team selection for future board reloads', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/']);

    fireEvent.change(await screen.findByLabelText('Select team'), {
      target: { value: 'SON' },
    });

    await waitFor(() =>
      expect(window.localStorage.getItem(ACTIVE_TEAM_STORAGE_KEY)).toBe('SON'),
    );
  });

  it('requests board issues with a team-scoped filter after selecting Sonata', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/']);

    await screen.findByRole('heading', { name: 'Board' });

    expect(apolloMocks.useQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        variables: { first: 200 },
      }),
    );

    fireEvent.change(screen.getByLabelText('Select team'), {
      target: { value: 'SON' },
    });

    await waitFor(() =>
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
      ),
    );
  });
});

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, mockSessionState, renderApp } from './test/app-test-helpers';
import type { BoardPageQueryData, IssueSummary } from './board/types';

describe('App command palette', () => {
  it('opens the create issue dialog from the command palette action', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/']);

    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Search.*⌘K/i }));

    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    fireEvent.click(within(palette).getByRole('button', { name: /Create issue/i }));

    expect(await screen.findByRole('dialog', { name: 'Create issue drawer' })).toBeInTheDocument();
  });

  it('opens the create issue dialog after navigating back from a non-board route', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/issue/issue-1']);

    expect(await screen.findByRole('heading', { name: 'Issue detail' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Search.*⌘K/i }));

    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    fireEvent.click(within(palette).getByRole('button', { name: /Create issue/i }));

    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();
    expect(await screen.findByRole('dialog', { name: 'Create issue drawer' })).toBeInTheDocument();
  });

  it('searches across the full shell issue list instead of only a short recent subset', async () => {
    const expandedData: BoardPageQueryData = {
      ...boardQueryResult,
      issues: {
        ...boardQueryResult.issues,
        nodes: Array.from({ length: 14 }, (_, index) => ({
          ...(boardQueryResult.issues.nodes[0] as IssueSummary),
          id: `issue-${index + 1}`,
          identifier: `INV-${index + 1}`,
          title: index === 13 ? 'Needle issue thirteen' : `Board issue ${index + 1}`,
          team: { id: 'team-1', key: 'INV' },
        })),
      },
    };

    renderApp({ data: expandedData, loading: false }, ['/']);

    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Search.*⌘K/i }));

    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    fireEvent.change(within(palette).getByLabelText('Search commands'), {
      target: { value: 'Needle issue thirteen' },
    });

    expect(await within(palette).findByRole('button', { name: /INV-14 · Needle issue thirteen/i })).toBeInTheDocument();
  });

  it('loads a saved board view directly from the command palette', async () => {
    window.prompt = () => 'Bug queue';

    renderApp({ data: boardQueryResult, loading: false }, ['/']);

    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();

    const filters = screen.getByLabelText('Board filters');
    fireEvent.click(within(filters).getByText('Labels'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bug' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() => {
      expect(within(screen.getByTestId('column-Backlog')).getByText('Backlog item')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Search.*⌘K/i }));
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    fireEvent.click(within(palette).getByRole('button', { name: /Load board view · Bug queue/i }));

    await waitFor(() => {
      expect(within(screen.getByTestId('column-Backlog')).queryByTestId('issue-card-issue-1')).not.toBeInTheDocument();
      expect(screen.getByText(/Loaded view: Bug queue/i)).toBeInTheDocument();
    });
  });

  it('supports g-prefixed navigation shortcuts across board, backlog, and access', async () => {
    mockSessionState({
      authMode: 'session',
      authenticated: true,
      googleOAuthConfigured: true,
      viewer: {
        id: 'viewer-1',
        email: 'admin@example.com',
        name: 'Admin',
        globalRole: 'ADMIN',
      },
    });

    renderApp({ data: boardQueryResult, loading: false }, ['/']);

    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.keyDown(window, { key: 'l' });
    expect(await screen.findByRole('heading', { name: 'Backlog' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.keyDown(window, { key: 'a' });
    expect(await screen.findByRole('heading', { name: 'Access' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.keyDown(window, { key: 'b' });
    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();
  });
});

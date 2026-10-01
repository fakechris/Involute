import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, mockSessionState, renderApp } from './test/app-test-helpers';
import type { BoardPageQueryData, IssueSummary } from './board/types';

describe('App command palette', () => {
  it('opens the create issue dialog from the command palette action', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/']);

    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Open command palette/i }));

    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    fireEvent.click(within(palette).getByRole('button', { name: /Create issue/i }));

    expect(await screen.findByRole('dialog', { name: 'Create issue drawer' })).toBeInTheDocument();
  });

  it('opens the create issue dialog after navigating back from a non-board route', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/issue/issue-1']);

    expect(await screen.findByRole('heading', { name: 'Issue detail' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Open command palette/i }));

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

    fireEvent.click(screen.getByRole('button', { name: /Open command palette/i }));

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

    fireEvent.click(screen.getByRole('button', { name: /Filter/ }));

    const filters = screen.getByLabelText('Board filters');
    fireEvent.click(within(filters).getByText('Labels'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bug' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() => {
      expect(within(screen.getByTestId('column-Backlog')).getByText('Backlog item')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Open command palette/i }));
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
    // G A opens the current team's settings (INV-850).
    expect(await screen.findByRole('navigation', { name: 'Team settings sections' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.keyDown(window, { key: 'b' });
    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();
  });

  describe('searching all work (INV-925)', () => {
    const searchData = {
      search: [
        {
          matchedField: 'comment' as const,
          snippet: '…评论里提到溯源审计…',
          commentId: 'comment-9',
          issue: {
            id: 'issue-1',
            identifier: 'INV-1',
            title: 'Backlog item',
            state: { id: 'state-backlog', name: 'Backlog', type: 'BACKLOG' },
            team: { id: 'team-1', key: 'INV' },
          },
        },
        {
          matchedField: 'description' as const,
          snippet: '溯源 never loaded on this board',
          commentId: null,
          issue: {
            id: 'issue-remote',
            identifier: 'INV-777',
            title: 'Never loaded here',
            state: { id: 'state-ready', name: 'Ready', type: 'UNSTARTED' },
            team: { id: 'team-1', key: 'INV' },
          },
        },
      ],
    };

    it('lists server hits the board never loaded, with where the words were found', async () => {
      renderApp({ data: boardQueryResult, loading: false, searchData }, ['/']);
      expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Open command palette/i }));
      const palette = await screen.findByRole('dialog', { name: 'Command palette' });
      fireEvent.change(within(palette).getByLabelText('Search commands'), { target: { value: '溯源' } });

      const remote = await within(palette).findByRole('button', { name: /INV-777 · Never loaded here/ });
      expect(remote).toHaveTextContent('in description');
      const commentHit = within(palette).getByRole('button', { name: /INV-1 · Backlog item/ });
      expect(commentHit).toHaveTextContent('in comment');
      expect(within(commentHit).getByText('溯源', { selector: 'mark' })).toBeInTheDocument();
      // The board's own copy of INV-1 is not listed a second time.
      expect(within(palette).getAllByRole('button', { name: /INV-1 · Backlog item/ })).toHaveLength(1);

      fireEvent.click(commentHit);
      expect(await screen.findByRole('heading', { name: 'Issue detail' })).toBeInTheDocument();
    });

    it('opens the palette on the board search text from "Search all work"', async () => {
      renderApp({ data: boardQueryResult, loading: false, searchData }, ['/']);
      expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
      fireEvent.change(screen.getByLabelText('Search board issues'), { target: { value: '溯源' } });
      fireEvent.click(screen.getByRole('button', { name: /Search all work/ }));

      const palette = await screen.findByRole('dialog', { name: 'Command palette' });
      expect(within(palette).getByLabelText('Search commands')).toHaveValue('溯源');
      expect(await within(palette).findByRole('button', { name: /INV-777 · Never loaded here/ })).toBeInTheDocument();
    });
  });
});

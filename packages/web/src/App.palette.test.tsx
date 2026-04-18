import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { boardQueryResult, renderApp } from './test/app-test-helpers';
import type { BoardPageQueryData, IssueSummary } from './board/types';

describe('App command palette', () => {
  it('opens the create issue dialog from the command palette action', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/']);

    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Search issues and commands/i }));

    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    fireEvent.click(within(palette).getByRole('button', { name: /Create issue/i }));

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

    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Search issues and commands/i }));

    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    fireEvent.change(within(palette).getByLabelText('Search commands'), {
      target: { value: 'Needle issue thirteen' },
    });

    expect(await within(palette).findByRole('button', { name: /INV-14 · Needle issue thirteen/i })).toBeInTheDocument();
  });
});

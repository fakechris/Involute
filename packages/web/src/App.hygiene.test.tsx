import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';
import type { WorkHygieneQueryData } from './work/types';

const ref = (n: number, title: string) => ({ id: `id-${n}`, identifier: `INV-${n}`, title });

const hygieneData: WorkHygieneQueryData = {
  workHygiene: {
    unplacedCount: 2,
    unplaced: [
      { ...ref(437, 'Context overflow retry'), kind: 'ISSUE', repository: 'fakechris/lumenbox' },
      { ...ref(151, 'Cross-repo child'), kind: 'ISSUE', repository: 'fakechris/lumen-notes' },
    ],
    unlinkedMentionCount: 1,
    unlinkedMentions: [{ from: ref(642, 'Decision layer'), to: ref(455, 'Theme briefs') }],
    dependencyWithoutBlocksCount: 1,
    dependencyWithoutBlocks: [{ from: ref(439, 'Bundle MCP'), to: ref(420, 'G1') }],
    researchWithoutDownstream: [{ ...ref(694, 'External projects study'), repository: 'fakechris/lumenbox' }],
  },
};

describe('work graph health page (INV-721)', () => {
  it('shows the four counts and the items behind them', async () => {
    renderApp(App, { data: boardQueryResult, loading: false, hygieneData }, ['/hygiene']);
    expect(await screen.findByRole('heading', { name: 'Work graph health' })).toBeInTheDocument();
    const summary = screen.getByLabelText('Summary');
    expect(summary).toHaveTextContent('2Not in any project tree');
    expect(summary).toHaveTextContent('1Research with nothing derived');
    const unplaced = screen.getByRole('region', { name: 'Not in any project tree' });
    expect(within(unplaced).getByText('INV-437')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Research with nothing derived' })).getByText('INV-694')).toBeInTheDocument();
  });

  it('records a worded dependency in the right direction', async () => {
    const link = vi.fn().mockResolvedValue({ data: { workLink: { success: true, link: null } } });
    const fallback = apolloMocks.useMutation.getMockImplementation() as ((...args: unknown[]) => unknown) | undefined;
    apolloMocks.useMutation.mockImplementation((document: unknown, ...rest: unknown[]) => {
      const body = (document as { loc?: { source?: { body?: string } } }).loc?.source?.body ?? '';
      return body.includes('mutation WorkLink(') ? [link] : fallback ? fallback(document, ...rest) : [vi.fn()];
    });
    renderApp(App, { data: boardQueryResult, loading: false, hygieneData }, ['/hygiene']);
    fireEvent.click(await screen.findByRole('button', { name: 'INV-420 blocks INV-439' }));
    await waitFor(() => expect(link).toHaveBeenCalledWith({ variables: { fromId: 'id-420', toId: 'id-439', type: 'BLOCKS' } }));
  });

  it('opens from the keyboard with g h', async () => {
    renderApp(App, { data: boardQueryResult, loading: false, hygieneData }, ['/']);
    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.keyDown(window, { key: 'h' });
    expect(await screen.findByRole('heading', { name: 'Work graph health' })).toBeInTheDocument();
  });
});

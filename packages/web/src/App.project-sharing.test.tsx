import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, getIssue, renderApp } from './test/app-test-helpers';

// INV-833: a project is shared from its own page, with a link the other
// person can open.

const project = {
  ...getIssue('issue-1'),
  id: 'proj-1',
  identifier: 'INV-96',
  kind: 'PROJECT' as const,
  title: 'LumenBox project',
  repository: 'fakechris/lumenbox',
  alias: null,
  children: { nodes: [] },
};

const data = { ...boardQueryResult, issues: { ...boardQueryResult.issues, nodes: [...boardQueryResult.issues.nodes, project] } };

const people = [
  { id: 'user-2', name: 'Guest', email: 'guest@example.com', handle: null, actorKind: 'HUMAN', deactivatedAt: null },
  { id: 'agent-1', name: 'Codex', email: 'codex@agents.example', handle: 'codex', actorKind: 'AGENT', deactivatedAt: null },
  { id: 'svc-1', name: 'github-webhook', email: 'gh@services.example', handle: 'github-webhook', actorKind: 'SERVICE', deactivatedAt: null },
];

function sharesData(viewerCanShare: boolean, shares: unknown[] = []) {
  return { issue: { id: 'proj-1', viewerCanShare, shares }, users: { nodes: people } };
}

function mockShareMutations() {
  const upsert = vi.fn().mockResolvedValue({ data: { workShareUpsert: { success: true, message: null, share: { id: 's1', role: 'EDITOR' } } } });
  const remove = vi.fn().mockResolvedValue({ data: { workShareRemove: { success: true, message: null } } });
  apolloMocks.useMutation.mockImplementation((document: { loc?: { source: { body: string } } }) => {
    const body = document?.loc?.source.body ?? '';
    if (body.includes('workShareUpsert(')) return [upsert, { loading: false }];
    if (body.includes('workShareRemove(')) return [remove, { loading: false }];
    return [vi.fn(), { loading: false }];
  });
  return { remove, upsert };
}

async function openProject() {
  fireEvent.click(await screen.findByText('LumenBox project'));
}

describe('Project sharing (INV-833)', () => {
  it('lets a team manager share the project with a person or agent, and gives a board link scoped to it', async () => {
    const { upsert } = mockShareMutations();
    renderApp({ data, projectSharesData: sharesData(true), loading: false }, ['/projects']);
    await openProject();

    const section = await screen.findByRole('region', { name: 'Sharing' });
    const link = within(section).getByLabelText('Share link') as HTMLInputElement;
    expect(link.value).toContain('project=fakechris%2Flumenbox');

    const picker = within(section).getByLabelText('Share with');
    // Service actors are not people one shares with.
    expect(within(picker).queryByText(/github-webhook/)).not.toBeInTheDocument();
    fireEvent.change(picker, { target: { value: 'agent-1' } });
    fireEvent.change(within(section).getByLabelText('Share role'), { target: { value: 'EDITOR' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Share' }));

    await waitFor(() => {
      expect(upsert).toHaveBeenCalledWith({ variables: { role: 'EDITOR', userId: 'agent-1', workId: 'proj-1' } });
    });
  });

  it('lists existing shares with their role and removes one', async () => {
    const { remove } = mockShareMutations();
    const shares = [{ id: 's1', role: 'VIEWER', createdAt: '2026-09-28T00:00:00.000Z', user: people[0] }];
    renderApp({ data, projectSharesData: sharesData(true, shares), loading: false }, ['/projects']);
    await openProject();

    const section = await screen.findByRole('region', { name: 'Sharing' });
    expect(within(section).getByLabelText('Role for Guest')).toHaveValue('VIEWER');
    // Already shared: not offered again.
    expect(within(within(section).getByLabelText('Share with')).queryByText('Guest')).not.toBeInTheDocument();

    fireEvent.click(within(section).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith({ variables: { userId: 'user-2', workId: 'proj-1' } });
    });
  });

  it('shows nothing to someone who cannot manage the team', async () => {
    mockShareMutations();
    renderApp({ data, projectSharesData: sharesData(false), loading: false }, ['/projects']);
    await openProject();

    expect(await screen.findByText(/child issues \(CONTAINS\)/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Sharing' })).not.toBeInTheDocument();
  });
});

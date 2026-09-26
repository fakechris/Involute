import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  apolloMocks,
  boardQueryResult,
  renderApp,
  type IssueCreateMutationData,
  type IssueSummary,
} from './test/app-test-helpers';
import type { PlacementOptionsQueryData } from './work/types';

const placementData: PlacementOptionsQueryData = {
  projects: { nodes: [{ id: 'project-79', identifier: 'INV-79', title: 'fakechris/Involute', kind: 'PROJECT' }] },
  milestones: {
    nodes: [
      { id: 'milestone-80', identifier: 'INV-80', title: 'M1 Kernel', kind: 'MILESTONE', state: { type: 'STARTED' } },
      { id: 'milestone-81', identifier: 'INV-81', title: 'M0 Done', kind: 'MILESTONE', state: { type: 'COMPLETED' } },
    ],
  },
  epics: { nodes: [{ id: 'epic-82', identifier: 'INV-82', title: 'Search epic', kind: 'EPIC', state: { type: 'UNSTARTED' } }] },
};

function placedState() {
  return {
    data: {
      ...boardQueryResult,
      projectSummary: {
        totalCount: 3,
        noRepositoryCount: 0,
        projects: [
          { repository: 'fakechris/Involute', name: 'Involute', identifier: 'INV-79', totalCount: 3 },
          { repository: 'fakechris/no-project', name: 'fakechris/no-project', identifier: null, totalCount: 1 },
        ],
      },
    },
    loading: false,
    placementData,
  };
}

function mockCreate() {
  const createIssue = vi.fn().mockResolvedValue({
    data: {
      issueCreate: {
        success: true,
        message: null,
        issue: {
          id: 'issue-3',
          identifier: 'INV-3',
          revision: 1,
          title: 'Created issue',
          description: 'Created description',
          priority: 0,
          createdAt: '2026-04-02T13:00:00.000Z',
          updatedAt: '2026-04-02T13:00:00.000Z',
          state: { id: 'state-backlog', name: 'Backlog', type: 'BACKLOG' as const, position: 0 },
          team: { id: 'team-1', key: 'INV' },
          labels: { nodes: [] },
          assignee: null,
          children: { nodes: [] },
          parent: null,
          comments: { nodes: [] },
        },
      },
    } satisfies IssueCreateMutationData,
  });
  apolloMocks.useMutation.mockImplementation((document) => {
    const source =
      typeof document === 'string'
        ? document
        : 'loc' in document && document.loc?.source.body
          ? document.loc.source.body
          : String(document);
    return source.includes('mutation IssueCreate') ? [createIssue] : [vi.fn()];
  });
  return createIssue;
}

describe('App issue creation', () => {
  beforeEach(() => {
    window.localStorage.removeItem('involute.createPlacement.INV');
  });

  it('shows a newly created SON issue on the Sonata board even when the initial workspace dataset exceeds 200 items', async () => {
    const invIssues = Array.from({ length: 200 }, (_, index) => ({
      id: `inv-issue-${index + 1}`,
      identifier: `INV-${index + 1}`,
      revision: 1,
      title: `Involute issue ${index + 1}`,
      description: `INV issue ${index + 1}`,
      priority: 0,
      createdAt: `2026-04-02T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
      updatedAt: `2026-04-02T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
      state: { id: 'state-backlog', name: 'Backlog', type: 'BACKLOG' as const, position: 0 },
      team: { id: 'team-1', key: 'INV' },
      labels: { nodes: [] },
      assignee: null,
      children: { nodes: [] },
      parent: null,
      comments: { nodes: [] },
    })) satisfies IssueSummary[];

    const sonIssue = {
      id: 'son-issue-425',
      identifier: 'SON-425',
      revision: 1,
      title: 'Newest Sonata issue',
      description: 'Recently created in SON',
      priority: 0,
      createdAt: '2026-04-03T09:00:00.000Z',
      updatedAt: '2026-04-03T09:00:00.000Z',
      state: { id: 'son-backlog', name: 'Backlog', type: 'BACKLOG' as const, position: 0 },
      team: { id: 'team-2', key: 'SON' },
      labels: { nodes: [] },
      assignee: null,
      children: { nodes: [] },
      parent: null,
      comments: { nodes: [] },
    } satisfies IssueSummary;

    renderApp(
      {
        data: {
          ...boardQueryResult,
          issues: {
            nodes: [...invIssues, sonIssue],
            pageInfo: boardQueryResult.issues.pageInfo,
          },
        },
        loading: false,
      },
      ['/'],
    );

    fireEvent.change(await screen.findByLabelText('Select team', {}, { timeout: 3000 }), {
      target: { value: 'SON' },
    });

    expect(await within(screen.getByTestId('column-Backlog')).findByText('SON-425')).toBeInTheDocument();
    expect(screen.getByText('Newest Sonata issue')).toBeInTheDocument();
  });

  it('creates an issue where the person puts it and shows it in the backlog column', async () => {
    const createIssue = mockCreate();
    renderApp(placedState(), ['/']);

    fireEvent.click(await screen.findByRole('button', { name: 'Create issue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create issue drawer' });
    fireEvent.change(within(dialog).getByLabelText('Issue title'), { target: { value: 'Created issue' } });
    fireEvent.change(within(dialog).getByLabelText('Issue description'), { target: { value: 'Created description' } });

    // No context and nothing remembered: it has to be placed first.
    const submit = within(dialog).getByRole('button', { name: 'Create issue' });
    expect(submit).toBeDisabled();
    expect(within(dialog).getByText('Choose where it belongs')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Location')).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Project'), { target: { value: 'fakechris/Involute' } });
    const location = within(dialog).getByLabelText('Location') as HTMLSelectElement;
    expect(location.value).toBe('INV-79');
    expect(within(location).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'No milestone',
      'INV-80 — M1 Kernel',
      'Epic · INV-82 — Search epic',
    ]);
    fireEvent.change(location, { target: { value: 'milestone-80' } });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(createIssue).toHaveBeenCalledWith({
        variables: {
          input: { teamId: 'team-1', title: 'Created issue', parentId: 'milestone-80', description: 'Created description' },
        },
      }),
    );
    const backlogColumn = screen.getByTestId('column-Backlog');
    expect(await within(backlogColumn).findByText('INV-3')).toBeInTheDocument();
    expect(within(backlogColumn).getByText('Created issue')).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('involute.createPlacement.INV') ?? 'null')).toEqual({
      repository: 'fakechris/Involute',
      parentId: 'milestone-80',
    });
  });

  it('starts from the last placement, marked "Last used", and submits with Cmd+Enter', async () => {
    window.localStorage.setItem('involute.createPlacement.INV', JSON.stringify({ repository: 'fakechris/Involute', parentId: 'milestone-80' }));
    const createIssue = mockCreate();
    renderApp(placedState(), ['/']);

    fireEvent.click(await screen.findByRole('button', { name: 'Create issue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create issue drawer' });
    expect((within(dialog).getByLabelText('Project') as HTMLSelectElement).value).toBe('fakechris/Involute');
    expect((within(dialog).getByLabelText('Location') as HTMLSelectElement).value).toBe('milestone-80');
    expect(within(dialog).getByText(/Last used/)).toBeInTheDocument();

    const title = within(dialog).getByLabelText('Issue title');
    fireEvent.change(title, { target: { value: 'Keyboard issue' } });
    fireEvent.keyDown(title, { key: 'Enter', metaKey: true });
    await waitFor(() =>
      expect(createIssue).toHaveBeenCalledWith({
        variables: { input: { teamId: 'team-1', title: 'Keyboard issue', parentId: 'milestone-80' } },
      }),
    );
  });

  it('prefers the board project filter over the last placement, and drops a finished remembered milestone', async () => {
    window.localStorage.setItem('involute.createPlacement.INV', JSON.stringify({ repository: 'fakechris/Involute', parentId: 'milestone-81' }));
    renderApp(placedState(), ['/']);
    fireEvent.click(await screen.findByRole('button', { name: 'Create issue' }));
    const remembered = await screen.findByRole('dialog', { name: 'Create issue drawer' });
    // INV-81 is done, so it is not offered; the picker falls back to No milestone.
    await waitFor(() => expect((within(remembered).getByLabelText('Location') as HTMLSelectElement).value).toBe('INV-79'));
  });

  it('starts at No milestone of the project the board is filtered to', async () => {
    window.localStorage.setItem('involute.createPlacement.INV', JSON.stringify({ repository: 'fakechris/lumenbox', parentId: 'INV-96' }));
    renderApp(placedState(), ['/?project=fakechris/Involute']);
    fireEvent.click(await screen.findByRole('button', { name: 'Create issue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create issue drawer' });
    expect((within(dialog).getByLabelText('Project') as HTMLSelectElement).value).toBe('fakechris/Involute');
    expect((within(dialog).getByLabelText('Location') as HTMLSelectElement).value).toBe('INV-79');
    expect(within(dialog).queryByText(/Last used/)).not.toBeInTheDocument();
  });

  it('keeps the dialog open with "Create more" and shows why the server refused', async () => {
    const createIssue = mockCreate();
    createIssue.mockResolvedValueOnce({ data: { issueCreate: { success: false, message: 'Parent issue not found.', issue: null } } });
    renderApp(placedState(), ['/?project=fakechris/Involute']);
    fireEvent.click(await screen.findByRole('button', { name: 'Create issue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create issue drawer' });
    fireEvent.click(within(dialog).getByLabelText('Create more'));

    fireEvent.change(within(dialog).getByLabelText('Issue title'), { target: { value: 'First try' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create issue' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Parent issue not found.');
    expect(within(dialog).getByLabelText('Issue title')).toHaveValue('First try');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create issue' }));
    await waitFor(() => expect(createIssue).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(dialog).getByLabelText('Issue title')).toHaveValue(''));
    expect(screen.getByRole('dialog', { name: 'Create issue drawer' })).toBeInTheDocument();
    expect((within(dialog).getByLabelText('Location') as HTMLSelectElement).value).toBe('INV-79');
  });

  it('asks for a project first when the team has none', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/']);
    fireEvent.click(await screen.findByRole('button', { name: 'Create issue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create issue drawer' });
    expect(within(dialog).getByRole('note')).toHaveTextContent('New work goes under a project.');
    expect(within(dialog).getByRole('button', { name: 'Create issue' })).toBeDisabled();
  });
});

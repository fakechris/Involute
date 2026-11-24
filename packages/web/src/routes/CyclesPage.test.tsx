import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useQuery } from '@apollo/client/react';
import { CombinedGraphQLErrors } from '@apollo/client/errors';

import { READ_ONLY_TEAM_MESSAGE } from '../lib/apollo';
import { CyclesPage } from './CyclesPage';

const mockRunIssueCreate = vi.fn();
const mockRunIssueUpdate = vi.fn();
const mockRunIssueDelete = vi.fn();

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRunIssueCreate.mockResolvedValue({ data: { issueCreate: { success: true, message: null, issue: { id: 'm-new' } } } });
  mockRunIssueUpdate.mockResolvedValue({ data: { issueUpdate: { success: true, message: null, issue: { id: 'milestone-1' } } } });
});

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn((document) => {
    const docStr = JSON.stringify(document);

    if (docStr.includes('BoardPage')) {
      return {
        data: {
          teams: {
            nodes: [
              {
                id: 'team-1',
                key: 'INV',
                name: 'Involute',
                viewerCanWrite: true,
                states: {
                  nodes: [
                    { id: 'state-1', name: 'Backlog', type: 'BACKLOG' },
                    { id: 'state-2', name: 'In Progress', type: 'STARTED' },
                    { id: 'state-3', name: 'Done', type: 'COMPLETED' },
                  ],
                },
              },
            ],
          },
        },
        loading: false,
      };
    }

    if (docStr.includes('MilestoneIssues')) {
      return {
        data: {
          issues: {
            nodes: [
              {
                id: 'milestone-1',
                identifier: 'INV-10',
                title: 'Beta Release',
                description: 'First testable milestone',
                outcome: 'Beta ready',
                scope: 'Engine',
                acceptance: 'Zero errors',
                priority: 1,
                kind: 'MILESTONE',
                createdAt: '2026-04-01T10:00:00.000Z',
                updatedAt: '2026-04-01T10:00:00.000Z',
                state: { id: 'state-2', name: 'In Progress', type: 'STARTED', position: 1 },
                assignee: { id: 'user-1', name: 'Admin', email: 'admin@involute.local' },
                team: { id: 'team-1', key: 'INV', name: 'Involute' },
                children: {
                  nodes: [
                    {
                      id: 'child-1',
                      identifier: 'INV-11',
                      title: 'Implement auth',
                      kind: 'ISSUE',
                      state: { id: 'state-3', name: 'Done', type: 'COMPLETED' },
                      assignee: { id: 'user-1', name: 'Admin' },
                    },
                    {
                      id: 'child-2',
                      identifier: 'INV-12',
                      title: 'Add test suite',
                      kind: 'ISSUE',
                      state: { id: 'state-2', name: 'In Progress', type: 'STARTED' },
                      assignee: null,
                    },
                  ],
                },
              },
            ],
          },
        },
        loading: false,
        refetch: vi.fn(),
      };
    }

    if (docStr.includes('GraphProjects')) {
      return {
        data: { projectSummary: { totalCount: 1, projects: [{ repository: 'acme/app', name: 'App', identifier: 'INV-1', totalCount: 3 }] } },
        loading: false,
      };
    }

    if (docStr.includes('PlacementOptions')) {
      return { data: { projects: { nodes: [] }, milestones: { nodes: [] }, epics: { nodes: [] } }, loading: false };
    }

    // Default CYCLES_QUERY
    return {
      data: {
        cycles: {
          nodes: [
            {
              id: 'cycle-1',
              name: 'Sprint 1',
              number: 1,
              startsAt: '2026-04-01T00:00:00.000Z',
              endsAt: '2026-04-15T00:00:00.000Z',
              issues: { nodes: [] },
              createdAt: '2026-04-01T00:00:00.000Z',
              updatedAt: '2026-04-01T00:00:00.000Z',
            },
          ],
        },
      },
      loading: false,
      refetch: vi.fn(),
    };
  }),
  useMutation: vi.fn((document) => {
    const docStr = JSON.stringify(document);
    if (docStr.includes('IssueCreate')) {
      return [mockRunIssueCreate, { loading: false }];
    }
    if (docStr.includes('IssueUpdate')) {
      return [mockRunIssueUpdate, { loading: false }];
    }
    if (docStr.includes('IssueDelete')) {
      return [mockRunIssueDelete, { loading: false }];
    }
    return [vi.fn(), { loading: false }];
  }),
}));

describe('CyclesPage', () => {
  it('renders Work Graph Milestones by default', () => {
    render(
      <MemoryRouter>
        <CyclesPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Milestones')).toBeInTheDocument();
    expect(screen.getByText('INV-10')).toBeInTheDocument();
    expect(screen.getByText('Beta Release')).toBeInTheDocument();
    expect(screen.getByText('Implement auth')).toBeInTheDocument();
    expect(screen.getByText('1/2 (50%)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Work context' })).toBeInTheDocument();
  });

  it('creates a milestone in its project with an outcome, and shows why a create was refused (INV-792)', async () => {
    render(
      <MemoryRouter>
        <CyclesPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'New milestone' })[0]!);
    const form = screen.getByRole('dialog', { name: 'New milestone' });
    const create = within(form).getByRole('button', { name: 'Create', hidden: true });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('e.g. Release v1.0 or Core Engine'), { target: { value: 'GA' } });
    fireEvent.change(screen.getByLabelText('Milestone outcome'), { target: { value: 'Customers on v1' } });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'acme/app' } });
    expect((screen.getByLabelText('Location') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('Directly in the project');
    fireEvent.click(create);
    await waitFor(() => expect(mockRunIssueCreate).toHaveBeenCalledTimes(1));
    expect(mockRunIssueCreate.mock.calls[0]![0].variables.input).toMatchObject({
      title: 'GA',
      kind: 'MILESTONE',
      parentId: 'INV-1',
      outcome: 'Customers on v1',
    });

    // A created milestone closes the dialog; a refused one keeps it open with the reason.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New milestone' })).not.toBeInTheDocument());
    mockRunIssueCreate.mockResolvedValueOnce({ data: { issueCreate: { success: false, message: 'CONTAINS cannot cross repository boundaries.', issue: null } } });
    fireEvent.click(screen.getAllByRole('button', { name: 'New milestone' })[0]!);
    const retry = screen.getByRole('dialog', { name: 'New milestone' });
    fireEvent.change(within(retry).getByPlaceholderText('e.g. Release v1.0 or Core Engine'), { target: { value: 'GA' } });
    fireEvent.change(within(retry).getByLabelText('Project'), { target: { value: 'acme/app' } });
    fireEvent.click(within(retry).getByRole('button', { name: 'Create' }));
    expect(await within(retry).findByRole('alert')).toHaveTextContent('CONTAINS cannot cross repository boundaries.');
    expect(screen.getByRole('dialog', { name: 'New milestone' })).toBeInTheDocument();
  });

  it('edits a milestone outcome', async () => {
    render(
      <MemoryRouter>
        <CyclesPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Configure' })[0]!);
    const outcome = screen.getByLabelText('Milestone outcome') as HTMLTextAreaElement;
    expect(outcome.value).toBe('Beta ready');
    fireEvent.change(outcome, { target: { value: 'Beta ready for 10 teams' } });
    const form = screen.getByRole('dialog', { name: 'Edit milestone' });
    fireEvent.click(within(form).getByRole('button', { name: 'Save', hidden: true }));
    await waitFor(() =>
      expect(mockRunIssueUpdate).toHaveBeenCalledWith({
        variables: { id: 'milestone-1', input: expect.objectContaining({ outcome: 'Beta ready for 10 teams' }) },
      }),
    );
  });

  it('switches to Legacy Cycles tab when clicked', () => {
    render(
      <MemoryRouter>
        <CyclesPage />
      </MemoryRouter>,
    );

    const cyclesTab = screen.getByRole('button', { name: 'Cycles (Legacy)' });
    fireEvent.click(cyclesTab);

    expect(screen.getByText('Sprint 1')).toBeInTheDocument();
  });
});

describe('CyclesPage access and load failures', () => {
  function withQuery(override: (docStr: string, result: ReturnType<typeof useQuery>) => ReturnType<typeof useQuery>) {
    const query = vi.mocked(useQuery);
    const original = query.getMockImplementation()!;
    query.mockImplementation(((document: unknown, options: unknown) => override(JSON.stringify(document), original(document as never, options as never))) as never);
    return () => query.mockImplementation(original);
  }

  it('hides Edit, Delete and Configure on milestones the viewer may only read, and says why (INV-2160)', () => {
    const restore = withQuery((docStr, result) => {
      if (docStr.includes('BoardPage')) {
        const data = result.data as { teams: { nodes: Array<Record<string, unknown>> } };
        return { ...result, data: { teams: { nodes: data.teams.nodes.map((team) => ({ ...team, viewerCanWrite: false })) } } } as typeof result;
      }
      if (!docStr.includes('MilestoneIssues')) return result;
      const data = result.data as { issues: { nodes: Array<Record<string, unknown>> } };
      return { ...result, data: { issues: { nodes: data.issues.nodes.map((milestone) => ({ ...milestone, viewerCanWrite: false })) } } } as typeof result;
    });
    try {
      render(<MemoryRouter><CyclesPage /></MemoryRouter>);
      expect(screen.getByText('Beta Release')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Configure' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'New milestone' })).toBeNull();
      expect(screen.getByRole('note')).toHaveTextContent(READ_ONLY_TEAM_MESSAGE);
    } finally {
      restore();
    }
  });

  it('shows in the dialog why a Save was refused instead of doing nothing (INV-2160)', async () => {
    mockRunIssueUpdate.mockRejectedValueOnce(new CombinedGraphQLErrors({ errors: [{ message: 'You do not have edit access to this team.', extensions: { code: 'FORBIDDEN' } }] }));
    render(<MemoryRouter><CyclesPage /></MemoryRouter>);
    fireEvent.click(screen.getAllByRole('button', { name: 'Configure' })[0]!);
    const form = screen.getByRole('dialog', { name: 'Edit milestone' });
    fireEvent.click(within(form).getByRole('button', { name: 'Save', hidden: true }));
    expect(await within(form).findByRole('alert', { hidden: true })).toHaveTextContent(READ_ONLY_TEAM_MESSAGE);
  });

  it('shows a load failure with Retry, not "No milestones configured", when the milestones cannot be read (INV-2162)', async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    const restore = withQuery((docStr, result) => (docStr.includes('MilestoneIssues')
      ? ({ ...result, data: undefined, loading: false, error: new Error('Failed to fetch'), refetch } as typeof result)
      : result));
    try {
      render(<MemoryRouter><CyclesPage /></MemoryRouter>);
      expect(screen.getByText('Could not load milestones')).toBeInTheDocument();
      expect(screen.queryByText('No milestones configured')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(refetch).toHaveBeenCalled());
    } finally {
      restore();
    }
  });
});

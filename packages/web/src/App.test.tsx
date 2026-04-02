import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import type { BoardPageQueryData, IssueSummary, IssueUpdateMutationData } from './board/types';

const apolloMocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
}));

vi.mock('@apollo/client/react', async () => {
  const actual = await vi.importActual<typeof import('@apollo/client/react')>('@apollo/client/react');

  return {
    ...actual,
    useQuery: apolloMocks.useQuery,
    useMutation: apolloMocks.useMutation,
  };
});

vi.mock('@dnd-kit/core', async () => {
  const actual = await vi.importActual<typeof import('@dnd-kit/core')>('@dnd-kit/core');

  return {
    ...actual,
    DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    useSensor: vi.fn(() => ({})),
    useSensors: vi.fn(() => []),
  };
});

beforeEach(() => {
  apolloMocks.useQuery.mockReset();
  apolloMocks.useMutation.mockReset();
  apolloMocks.useMutation.mockReturnValue([vi.fn()]);
});

afterEach(() => {
  document.body.innerHTML = '';
});

const boardQueryResult: BoardPageQueryData = {
  teams: {
    nodes: [
      {
        id: 'team-1',
        key: 'INV',
        name: 'Involute',
        states: {
          nodes: [
            { id: 'state-backlog', name: 'Backlog' },
            { id: 'state-ready', name: 'Ready' },
            { id: 'state-progress', name: 'In Progress' },
            { id: 'state-review', name: 'In Review' },
            { id: 'state-done', name: 'Done' },
            { id: 'state-canceled', name: 'Canceled' },
          ],
        },
      },
    ],
  },
  users: {
    nodes: [
      {
        id: 'user-1',
        name: 'Admin',
        email: 'admin@involute.local',
      },
    ],
  },
  issues: {
    nodes: [
      {
        id: 'issue-1',
        identifier: 'INV-1',
        title: 'Backlog item',
        description: 'Backlog description',
        createdAt: '2026-04-02T10:00:00.000Z',
        updatedAt: '2026-04-02T10:00:00.000Z',
        state: { id: 'state-backlog', name: 'Backlog' },
        team: { id: 'team-1', key: 'INV' },
        labels: { nodes: [{ id: 'label-task', name: 'task' }] },
        assignee: { id: 'user-1', name: 'Admin', email: 'admin@involute.local' },
      },
      {
        id: 'issue-2',
        identifier: 'INV-2',
        title: 'Ready item',
        description: 'Ready description',
        createdAt: '2026-04-02T10:00:00.000Z',
        updatedAt: '2026-04-02T10:00:00.000Z',
        state: { id: 'state-ready', name: 'Ready' },
        team: { id: 'team-1', key: 'INV' },
        labels: { nodes: [{ id: 'label-bug', name: 'Bug' }] },
        assignee: null,
      },
    ],
  },
};

function renderApp(queryState: {
  data?: BoardPageQueryData;
  error?: Error;
  loading?: boolean;
} = {
  data: boardQueryResult,
  loading: false,
}) {
  apolloMocks.useQuery.mockReturnValue({
    data: queryState.data,
    error: queryState.error,
    loading: queryState.loading ?? false,
  });

  return render(
    <MemoryRouter initialEntries={['/']}>
      <App />
    </MemoryRouter>,
  );
}

describe('App', () => {
  it('renders all six board columns in order', async () => {
    renderApp();

    const headers = await screen.findAllByRole('heading', { level: 2 });

    expect(headers.map((header) => header.textContent)).toEqual([
      'Backlog',
      'Ready',
      'In Progress',
      'In Review',
      'Done',
      'Canceled',
    ]);
  });

  it('renders issue cards in the matching board columns', async () => {
    renderApp();

    expect(await screen.findByText('INV-1')).toBeInTheDocument();
    expect(screen.getByText('Backlog item')).toBeInTheDocument();
    expect(screen.getByText('task')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('INV-2')).toBeInTheDocument();
    expect(screen.getByText('Ready item')).toBeInTheDocument();
  });

  it('opens the issue drawer and changes state via dropdown', async () => {
    const mutate = vi.fn<
      (args: { variables: { id: string; input: { stateId: string } } }) => Promise<{ data: IssueUpdateMutationData }>
    >().mockResolvedValue({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...(boardQueryResult.issues.nodes[0] as IssueSummary),
            state: { id: 'state-progress', name: 'In Progress' },
          },
        },
      },
    });
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByLabelText('Issue detail drawer');

    fireEvent.change(within(drawer).getByLabelText('Issue state'), {
      target: { value: 'state-progress' },
    });

    expect(mutate).toHaveBeenCalledWith({
      variables: {
        id: 'issue-1',
        input: { stateId: 'state-progress' },
      },
    });

    expect(await within(screen.getByTestId('column-In Progress')).findByText('INV-1')).toBeInTheDocument();
  });

  it('shows an error and reverts optimistic move when state mutation fails', async () => {
    const mutate = vi.fn().mockRejectedValue(new Error('boom'));
    apolloMocks.useMutation.mockReturnValue([mutate]);

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByLabelText('Issue detail drawer');

    fireEvent.change(within(drawer).getByLabelText('Issue state'), {
      target: { value: 'state-progress' },
    });

    expect((await screen.findAllByText('We could not save the state change. Please try again.')).length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('column-Backlog')).getByText('INV-1')).toBeInTheDocument();
  });

  it('renders six empty columns without crashing when there are no issues', async () => {
    renderApp({
      data: {
        ...boardQueryResult,
        issues: {
          nodes: [],
        },
      },
      loading: false,
    });

    expect(await screen.findByText('No issues in Backlog yet.')).toBeInTheDocument();
    expect(screen.getByText('No issues in Canceled yet.')).toBeInTheDocument();
  });

  it('shows a user-friendly error state when the API request fails', async () => {
    renderApp({
      error: new Error('connect ECONNREFUSED 127.0.0.1:4200'),
      loading: false,
    });

    expect(
      await screen.findByText('We could not load the board right now. Please confirm the API server is running and try again.'),
    ).toBeInTheDocument();
  });
});

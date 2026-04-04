import { cleanup, render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ComponentType, ReactNode } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';

import type { BoardPageQueryData, IssueSummary } from '../board/types';

function buildDefaultUseMutationMock(document: unknown) {
  const source = String(document);

  if (source.includes('mutation CommentCreate')) {
    return [vi.fn().mockResolvedValue({ data: { commentCreate: { success: true, comment: null } } })];
  }

  if (source.includes('mutation CommentDelete')) {
    return [vi.fn().mockResolvedValue({ data: { commentDelete: { success: true, commentId: 'comment-1' } } })];
  }

  if (source.includes('mutation IssueDelete')) {
    return [vi.fn().mockResolvedValue({ data: { issueDelete: { success: true, issueId: 'issue-1' } } })];
  }

  return [vi.fn()];
}

type MockFn = ReturnType<typeof vi.fn>;
type ApolloMocks = {
  useQuery: MockFn;
  useMutation: MockFn;
};
type DndMocks = {
  useSensor: MockFn;
  useSensors: MockFn;
};

const hoistedMocks = vi.hoisted(() => ({
  apollo: {
    useQuery: vi.fn(),
    useMutation: vi.fn(),
  },
  dnd: {
    useSensor: vi.fn(() => ({})),
    useSensors: vi.fn(() => []),
  },
}));

export const apolloMocks: ApolloMocks = hoistedMocks.apollo;

vi.mock('@apollo/client/react', async () => {
  const actual = await vi.importActual<typeof import('@apollo/client/react')>('@apollo/client/react');

  return {
    ...actual,
    useQuery: hoistedMocks.apollo.useQuery,
    useMutation: hoistedMocks.apollo.useMutation,
  };
});

export const dndMocks: DndMocks = hoistedMocks.dnd;

vi.mock('@dnd-kit/core', async () => {
  const actual = await vi.importActual<typeof import('@dnd-kit/core')>('@dnd-kit/core');

  return {
    ...actual,
    DndContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DragOverlay: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    useSensor: hoistedMocks.dnd.useSensor,
    useSensors: hoistedMocks.dnd.useSensors,
  };
});

beforeEach(() => {
  hoistedMocks.dnd.useSensor.mockClear();
  hoistedMocks.dnd.useSensors.mockClear();
  hoistedMocks.apollo.useQuery.mockReset();
  hoistedMocks.apollo.useMutation.mockReset();
  hoistedMocks.apollo.useMutation.mockImplementation(buildDefaultUseMutationMock);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.unstubAllEnvs();
});

export const boardQueryResult: BoardPageQueryData = {
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
      {
        id: 'team-2',
        key: 'SON',
        name: 'Sonata',
        states: {
          nodes: [
            { id: 'son-backlog', name: 'Backlog' },
            { id: 'son-ready', name: 'Ready' },
            { id: 'son-progress', name: 'In Progress' },
            { id: 'son-review', name: 'In Review' },
            { id: 'son-done', name: 'Done' },
            { id: 'son-canceled', name: 'Canceled' },
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
  issueLabels: {
    nodes: [
      { id: 'label-task', name: 'task' },
      { id: 'label-bug', name: 'Bug' },
      { id: 'label-feature', name: 'Feature' },
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
        children: { nodes: [] },
        parent: null,
        comments: { nodes: [] },
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
        children: { nodes: [] },
        parent: {
          id: 'issue-1',
          identifier: 'INV-1',
          title: 'Backlog item',
        },
        comments: { nodes: [] },
      },
      {
        id: 'issue-3',
        identifier: 'SON-1',
        title: 'Sonata backlog item',
        description: 'Sonata description',
        createdAt: '2026-04-02T10:00:00.000Z',
        updatedAt: '2026-04-02T10:00:00.000Z',
        state: { id: 'son-backlog', name: 'Backlog' },
        team: { id: 'team-2', key: 'SON' },
        labels: { nodes: [{ id: 'label-feature', name: 'Feature' }] },
        assignee: null,
        children: { nodes: [] },
        parent: null,
        comments: { nodes: [] },
      },
    ],
  },
};

export function renderApp(AppComponent: ComponentType, queryState: {
  data?: BoardPageQueryData;
  error?: Error;
  loading?: boolean;
} = {
  data: boardQueryResult,
  loading: false,
}, initialEntries: string[] = ['/']): RenderResult {
  apolloMocks.useQuery.mockImplementation((_, options) => {
    if (options?.variables && 'id' in options.variables) {
      const issueId = String(options.variables.id);
      return {
        data: {
          issue: queryState.data?.issues.nodes.find((issue) => issue.id === issueId) ?? null,
          users: queryState.data?.users ?? { nodes: [] },
          issueLabels: queryState.data?.issueLabels ?? { nodes: [] },
        },
        error: queryState.error,
        loading: queryState.loading ?? false,
      };
    }

    return {
      data: queryState.data,
      error: queryState.error,
      loading: queryState.loading ?? false,
    };
  });

  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AppComponent />
    </MemoryRouter>,
  );
}

export function getIssue(issueId: string): IssueSummary {
  return boardQueryResult.issues.nodes.find((issue) => issue.id === issueId) as IssueSummary;
}

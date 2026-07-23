import type { ComponentType, ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';

import { App } from '../App';
import type {
  AccessPageQueryData,
  BoardPageQueryData,
  CommentDeleteMutationData,
  CommentCreateMutationData,
  IssueDeleteMutationData,
  IssueCreateMutationData,
  IssueSummary,
  TeamMembershipRemoveMutationData,
  TeamMembershipUpsertMutationData,
  TeamUpdateAccessMutationData,
  IssueUpdateMutationData,
} from '../board/types';
export type {
  AccessPageQueryData,
  BoardPageQueryData,
  CommentDeleteMutationData,
  CommentCreateMutationData,
  IssueDeleteMutationData,
  IssueCreateMutationData,
  IssueSummary,
  TeamMembershipRemoveMutationData,
  TeamMembershipUpsertMutationData,
  TeamUpdateAccessMutationData,
  IssueUpdateMutationData,
};

type ApolloMockSet = {
  useMutation: ReturnType<typeof vi.fn>;
  useQuery: ReturnType<typeof vi.fn>;
};

type DndMockSet = {
  lastContextProps: Record<string, unknown> | null;
  useSensor: ReturnType<typeof vi.fn>;
  useSensors: ReturnType<typeof vi.fn>;
};

function getDocumentSource(document: unknown): string {
  if (typeof document === 'string') {
    return document;
  }

  if (document && typeof document === 'object') {
    const locSource = (document as { loc?: { source?: { body?: string } } }).loc?.source?.body;

    if (typeof locSource === 'string') {
      return locSource;
    }
  }

  return String(document);
}

const hoistedApolloMocks = vi.hoisted<ApolloMockSet>(() => ({
  useQuery: vi.fn(),
  useMutation: vi.fn((document) => {
    const source = getDocumentSource(document);

    if (source.includes('mutation CommentCreate')) {
      return [vi.fn().mockResolvedValue({ data: { commentCreate: { success: true, comment: null } } })];
    }

    if (source.includes('mutation CommentDelete')) {
      return [vi.fn().mockResolvedValue({ data: { commentDelete: { success: true, commentId: 'comment-1' } } })];
    }

    if (source.includes('mutation IssueDelete')) {
      return [vi.fn().mockResolvedValue({ data: { issueDelete: { success: true, issueId: 'issue-1' } } })];
    }

    if (source.includes('mutation TeamUpdateAccess')) {
      return [vi.fn().mockResolvedValue({ data: { teamUpdateAccess: { success: true, team: null } } })];
    }

    if (source.includes('mutation TeamMembershipUpsert')) {
      return [vi.fn().mockResolvedValue({ data: { teamMembershipUpsert: { success: true, membership: null } } })];
    }

    if (source.includes('mutation TeamMembershipRemove')) {
      return [vi.fn().mockResolvedValue({ data: { teamMembershipRemove: { success: true, membershipId: 'membership-1' } } })];
    }

    if (source.includes('mutation FileUpload')) {
      return [vi.fn().mockResolvedValue({ data: { fileUpload: { success: true, attachment: null } } })];
    }

    return [vi.fn()];
  }),
}));
export const apolloMocks: ApolloMockSet = hoistedApolloMocks;

vi.mock('@apollo/client/react', async () => {
  const actual = await vi.importActual<typeof import('@apollo/client/react')>('@apollo/client/react');

  return {
    ...actual,
    useQuery: hoistedApolloMocks.useQuery,
    useMutation: hoistedApolloMocks.useMutation,
  };
});

const hoistedDndMocks = vi.hoisted<DndMockSet>(() => ({
  lastContextProps: null,
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));
export const dndMocks: DndMockSet = hoistedDndMocks;

vi.mock('@dnd-kit/core', async () => {
  const actual = await vi.importActual<typeof import('@dnd-kit/core')>('@dnd-kit/core');

  return {
    ...actual,
    DndContext: ({ children, ...props }: { children: ReactNode }) => {
      hoistedDndMocks.lastContextProps = props;
      return <div>{children}</div>;
    },
    DragOverlay: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    useSensor: hoistedDndMocks.useSensor,
    useSensors: hoistedDndMocks.useSensors,
  };
});

beforeEach(() => {
  const storage = new Map<string, string>();

  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      removeItem: (key: string) => {
        storage.delete(key);
      },
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      get length() {
        return storage.size;
      },
    },
  });
  dndMocks.lastContextProps = null;
  dndMocks.useSensor.mockClear();
  dndMocks.useSensors.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          authMode: 'none',
          authenticated: false,
          googleOAuthConfigured: false,
          viewer: null,
        }),
        {
          headers: {
            'content-type': 'application/json; charset=utf-8',
          },
          status: 401,
        },
      ),
    ),
  );
  apolloMocks.useQuery.mockReset();
  apolloMocks.useMutation.mockReset();
  apolloMocks.useMutation.mockImplementation((document) => {
    const source = getDocumentSource(document);

    if (source.includes('mutation CommentCreate')) {
      return [vi.fn().mockResolvedValue({ data: { commentCreate: { success: true, comment: null } } })];
    }

    if (source.includes('mutation CommentDelete')) {
      return [vi.fn().mockResolvedValue({ data: { commentDelete: { success: true, commentId: 'comment-1' } } })];
    }

    if (source.includes('mutation IssueDelete')) {
      return [vi.fn().mockResolvedValue({ data: { issueDelete: { success: true, issueId: 'issue-1' } } })];
    }

    if (source.includes('mutation TeamUpdateAccess')) {
      return [vi.fn().mockResolvedValue({ data: { teamUpdateAccess: { success: true, team: null } } })];
    }

    if (source.includes('mutation TeamMembershipUpsert')) {
      return [vi.fn().mockResolvedValue({ data: { teamMembershipUpsert: { success: true, membership: null } } })];
    }

    if (source.includes('mutation TeamMembershipRemove')) {
      return [vi.fn().mockResolvedValue({ data: { teamMembershipRemove: { success: true, membershipId: 'membership-1' } } })];
    }

    if (source.includes('mutation FileUpload')) {
      return [vi.fn().mockResolvedValue({ data: { fileUpload: { success: true, attachment: null } } })];
    }

    return [vi.fn()];
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
});

export function mockSessionState(
  state: {
    authMode?: 'none' | 'session' | 'token';
    authenticated?: boolean;
    googleOAuthConfigured?: boolean;
    viewer?: { email: string; globalRole: 'ADMIN' | 'USER'; id: string; name: string } | null;
  },
) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          authMode: state.authMode ?? 'none',
          authenticated: state.authenticated ?? false,
          googleOAuthConfigured: state.googleOAuthConfigured ?? false,
          viewer: state.viewer ?? null,
        }),
        {
          headers: {
            'content-type': 'application/json; charset=utf-8',
          },
          status: state.authenticated ? 200 : 401,
        },
      ),
    ),
  );
}

export const boardQueryResult: BoardPageQueryData = {
  teams: {
    nodes: [
      {
        id: 'team-1',
        key: 'INV',
        name: 'Involute',
        states: {
          nodes: [
            { id: 'state-backlog', name: 'Backlog', type: 'BACKLOG', position: 0 },
            { id: 'state-ready', name: 'Ready', type: 'UNSTARTED', position: 1 },
            { id: 'state-progress', name: 'In Progress', type: 'STARTED', position: 2 },
            { id: 'state-review', name: 'In Review', type: 'STARTED', position: 3 },
            { id: 'state-done', name: 'Done', type: 'COMPLETED', position: 4 },
            { id: 'state-canceled', name: 'Canceled', type: 'CANCELED', position: 5 },
          ],
        },
      },
      {
        id: 'team-2',
        key: 'SON',
        name: 'Sonata',
        states: {
          nodes: [
            { id: 'son-backlog', name: 'Backlog', type: 'BACKLOG', position: 0 },
            { id: 'son-ready', name: 'Ready', type: 'UNSTARTED', position: 1 },
            { id: 'son-progress', name: 'In Progress', type: 'STARTED', position: 2 },
            { id: 'son-review', name: 'In Review', type: 'STARTED', position: 3 },
            { id: 'son-done', name: 'Done', type: 'COMPLETED', position: 4 },
            { id: 'son-canceled', name: 'Canceled', type: 'CANCELED', position: 5 },
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
        priority: 0,
        createdAt: '2026-04-02T10:00:00.000Z',
        updatedAt: '2026-04-02T10:00:00.000Z',
        state: { id: 'state-backlog', name: 'Backlog', type: 'BACKLOG', position: 0 },
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
        priority: 0,
        createdAt: '2026-04-02T10:00:00.000Z',
        updatedAt: '2026-04-02T10:00:00.000Z',
        state: { id: 'state-ready', name: 'Ready', type: 'UNSTARTED', position: 1 },
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
        priority: 0,
        createdAt: '2026-04-02T10:00:00.000Z',
        updatedAt: '2026-04-02T10:00:00.000Z',
        state: { id: 'son-backlog', name: 'Backlog', type: 'BACKLOG', position: 0 },
        team: { id: 'team-2', key: 'SON' },
        labels: { nodes: [{ id: 'label-feature', name: 'Feature' }] },
        assignee: null,
        children: { nodes: [] },
        parent: null,
        comments: { nodes: [] },
      },
    ],
    pageInfo: {
      endCursor: null,
      hasNextPage: false,
    },
  },
};

export const accessQueryResult: AccessPageQueryData = {
  viewer: {
    email: 'admin@involute.local',
    globalRole: 'ADMIN',
    id: 'user-1',
    name: 'Admin',
  },
  teams: {
    nodes: [
      {
        ...boardQueryResult.teams.nodes[0]!,
        memberships: {
          nodes: [
            {
              id: 'membership-1',
              role: 'OWNER',
              user: {
                email: 'admin@involute.local',
                globalRole: 'ADMIN',
                id: 'user-1',
                name: 'Admin',
              },
            },
          ],
        },
        visibility: 'PRIVATE',
      },
      {
        ...boardQueryResult.teams.nodes[1]!,
        memberships: {
          nodes: [],
        },
        visibility: 'PUBLIC',
      },
    ],
  },
};

type QueryState = {
  accessData?: AccessPageQueryData;
  data?: BoardPageQueryData;
  error?: Error;
  fetchMore?: ReturnType<typeof vi.fn>;
  loading?: boolean;
};

export function renderApp(
  componentOrQueryState: ComponentType | QueryState = {
    data: boardQueryResult,
    loading: false,
  },
  queryStateOrInitialEntries: QueryState | string[] = ['/'],
  maybeInitialEntries: string[] = ['/'],
): ReturnType<typeof render> {
  const AppComponent = typeof componentOrQueryState === 'function' ? componentOrQueryState : App;
  const queryState =
    typeof componentOrQueryState === 'function'
      ? ((Array.isArray(queryStateOrInitialEntries)
          ? { data: boardQueryResult, loading: false }
          : queryStateOrInitialEntries) as QueryState)
      : componentOrQueryState;
  const initialEntries = Array.isArray(queryStateOrInitialEntries)
    ? queryStateOrInitialEntries
    : maybeInitialEntries;

  apolloMocks.useQuery.mockImplementation((_, options) => {
    const source = getDocumentSource(_);

    if (source.includes('query AccessPage')) {
      return {
        data: queryState.accessData ?? accessQueryResult,
        error: queryState.error,
        loading: queryState.loading ?? false,
      };
    }

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
      fetchMore: queryState.fetchMore ?? vi.fn().mockResolvedValue(undefined),
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
  const issue = boardQueryResult.issues.nodes.find((candidate) => candidate.id === issueId);

  if (!issue) {
    throw new Error(`Issue with id ${issueId} not found`);
  }

  return issue;
}

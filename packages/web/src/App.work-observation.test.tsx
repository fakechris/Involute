import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { apolloMocks, boardQueryResult, renderApp } from './test/app-test-helpers';
import type { CandidatesPageQueryData, WorkContextPageQueryData, WorkGraphPageQueryData } from './work/types';

function documentSource(document: unknown): string {
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

const candidateQuery: CandidatesPageQueryData = {
  teams: {
    nodes: boardQueryResult.teams.nodes.map((team) => ({
      ...team,
      memberships: team.id === 'team-1'
        ? {
            nodes: [
              {
                id: 'membership-1',
                user: { id: 'user-1', name: 'Admin', email: 'admin@involute.local', actorKind: 'HUMAN' },
              },
            ],
          }
        : { nodes: [] },
    })),
  },
  issues: {
    nodes: [
      {
        id: 'issue-c',
        identifier: 'INV-9',
        title: 'Parser should ignore aborted turns',
        description: 'Discovered during a failed run',
        commitmentStatus: 'CANDIDATE',
        kind: 'ISSUE',
        revision: 1,
        outcome: 'Aborted turns are omitted',
        scope: 'parser',
        constraints: null,
        acceptance: null,
        verification: 'unit tests',
        repository: 'fakechris/involute',
        createdAt: '2026-08-31T10:00:00.000Z',
        team: { id: 'team-1', key: 'INV' },
        assignee: null,
        state: { id: 'state-backlog', name: 'Backlog', type: 'BACKLOG', position: 0 },
      },
    ],
    pageInfo: { endCursor: null, hasNextPage: false },
  },
};

const graphQuery: WorkGraphPageQueryData = {
  issues: {
    nodes: [
      {
        id: 'issue-1',
        identifier: 'INV-1',
        title: 'Parent epic',
        commitmentStatus: 'COMMITTED',
        state: { name: 'Ready' },
        links: {
          nodes: [
            {
              id: 'link-contains',
              type: 'CONTAINS',
              from: { id: 'issue-1', identifier: 'INV-1', title: 'Parent epic', commitmentStatus: 'COMMITTED' },
              to: { id: 'issue-2', identifier: 'INV-2', title: 'Child task', commitmentStatus: 'COMMITTED' },
            },
          ],
        },
      },
      {
        id: 'issue-2',
        identifier: 'INV-2',
        title: 'Child task',
        commitmentStatus: 'COMMITTED',
        state: { name: 'Ready' },
        links: {
          nodes: [
            {
              id: 'link-contains',
              type: 'CONTAINS',
              from: { id: 'issue-1', identifier: 'INV-1', title: 'Parent epic', commitmentStatus: 'COMMITTED' },
              to: { id: 'issue-2', identifier: 'INV-2', title: 'Child task', commitmentStatus: 'COMMITTED' },
            },
            {
              id: 'link-blocks',
              type: 'BLOCKS',
              from: { id: 'issue-3', identifier: 'INV-3', title: 'Blocker', commitmentStatus: 'COMMITTED' },
              to: { id: 'issue-2', identifier: 'INV-2', title: 'Child task', commitmentStatus: 'COMMITTED' },
            },
          ],
        },
      },
      {
        id: 'issue-3',
        identifier: 'INV-3',
        title: 'Blocker',
        commitmentStatus: 'COMMITTED',
        state: { name: 'In Progress' },
        links: {
          nodes: [
            {
              id: 'link-blocks',
              type: 'BLOCKS',
              from: { id: 'issue-3', identifier: 'INV-3', title: 'Blocker', commitmentStatus: 'COMMITTED' },
              to: { id: 'issue-2', identifier: 'INV-2', title: 'Child task', commitmentStatus: 'COMMITTED' },
            },
          ],
        },
      },
    ],
    pageInfo: { endCursor: null, hasNextPage: false },
  },
};

const workContextQuery: WorkContextPageQueryData = {
  workContext: {
    work: {
      id: 'issue-2',
      identifier: 'INV-2',
      title: 'Child task',
      description: 'Ready description',
      kind: 'ISSUE',
      commitmentStatus: 'COMMITTED',
      revision: 3,
      outcome: 'Ready queue excludes blocked work',
      scope: 'kernel',
      constraints: 'Do not mark Done from a run',
      acceptance: 'readyWork omits INV-2 while blocked',
      verification: 'context-service tests',
      repository: 'fakechris/involute',
      state: { id: 'state-review', name: 'In Review', type: 'REVIEW', position: 3 },
      team: { id: 'team-1', key: 'INV', name: 'Involute' },
      assignee: { id: 'user-1', name: 'Admin', email: 'admin@involute.local' },
    },
    ancestors: [{ id: 'issue-1', identifier: 'INV-1', title: 'Parent epic' }],
    blockedBy: [{ id: 'issue-3', identifier: 'INV-3', title: 'Blocker' }],
    blocks: [],
    claim: {
      actor: { id: 'agent-1', name: 'Codex', email: 'codex@involute.local' },
      leaseUntil: '2026-08-31T18:00:00.000Z',
      createdAt: '2026-08-31T16:00:00.000Z',
    },
    runs: [
      {
        id: 'run-1',
        publicId: 'RUN-1',
        actorId: 'agent-1',
        claimId: 'claim-1',
        baseRevision: 2,
        status: 'COMPLETED',
        phase: 'implement',
        summary: 'Patch landed, waiting for review',
        externalUrl: 'https://example.test/pr/1',
        startedAt: '2026-08-31T16:00:00.000Z',
        endedAt: '2026-08-31T16:20:00.000Z',
      },
    ],
    evidence: [
      {
        id: 'ev-1',
        actorId: 'agent-1',
        runId: 'run-1',
        kind: 'PR',
        url: 'https://example.test/pr/1',
        summary: 'Implementation PR',
        createdAt: '2026-08-31T16:21:00.000Z',
      },
    ],
    reviewDecisions: [],
    audits: [
      {
        id: 'audit-1',
        revision: 3,
        actorKind: 'AGENT',
        actor: { id: 'agent-1', name: 'Codex', email: 'codex@involute.local' },
        surface: 'mcp',
        reason: 'run completed',
        createdAt: '2026-08-31T16:21:00.000Z',
      },
    ],
  },
};

describe('K6 observation UI', () => {
  it('requests committed work only on the board', async () => {
    renderApp({ data: boardQueryResult, loading: false }, ['/']);

    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();
    expect(apolloMocks.useQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        variables: {
          first: 200,
          filter: {
            commitmentStatus: 'COMMITTED',
          },
        },
      }),
    );
  });

  it('reviews candidates with commit and reject actions', async () => {
    const commit = vi.fn().mockResolvedValue({
      data: {
        workCommit: {
          success: true,
          issue: { id: 'issue-c', identifier: 'INV-9', commitmentStatus: 'COMMITTED' },
        },
      },
    });
    const reject = vi.fn().mockResolvedValue({
      data: {
        workReject: {
          success: true,
          issue: { id: 'issue-c', identifier: 'INV-9', commitmentStatus: 'REJECTED' },
        },
      },
    });
    apolloMocks.useMutation.mockImplementation((document) => {
      const source = documentSource(document);
      if (source.includes('mutation WorkCommit')) {
        return [commit];
      }
      if (source.includes('mutation WorkReject')) {
        return [reject];
      }
      return [vi.fn()];
    });

    renderApp({ data: boardQueryResult, candidatesData: candidateQuery, loading: false }, ['/candidates']);

    expect(await screen.findByRole('heading', { name: 'Candidates' })).toBeInTheDocument();
    expect(screen.getByText('INV-9')).toBeInTheDocument();
    expect(screen.getByText('Parser should ignore aborted turns')).toBeInTheDocument();
    expect(screen.getByText('Aborted turns are omitted')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Acceptance for INV-9'), {
      target: { value: 'aborted turns are omitted from extracted issues' },
    });
    fireEvent.change(screen.getByLabelText('Owner for INV-9'), {
      target: { value: 'user-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));

    await waitFor(() => expect(commit).toHaveBeenCalled());
    expect(commit.mock.calls[0]?.[0]).toEqual({
      variables: {
        id: 'issue-c',
        input: {
          expectedRevision: 1,
          acceptance: 'aborted turns are omitted from extracted issues',
          assigneeId: 'user-1',
        },
      },
    });

    fireEvent.change(screen.getByLabelText('Reject reason for INV-9'), {
      target: { value: 'duplicate of INV-2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(reject).toHaveBeenCalled());
    expect(reject.mock.calls[0]?.[0]).toEqual({
      variables: {
        id: 'issue-c',
        input: {
          expectedRevision: 1,
          reason: 'duplicate of INV-2',
        },
      },
    });
  });

  it('renders contains and blocks on the graph page', async () => {
    renderApp({ data: boardQueryResult, graphData: graphQuery, loading: false }, ['/graph']);

    expect(await screen.findByRole('heading', { name: 'Graph' })).toBeInTheDocument();
    const contains = screen.getByRole('region', { name: 'Contains' });
    expect(within(contains).getByRole('button', { name: 'INV-1' })).toBeInTheDocument();
    expect(within(contains).getByRole('button', { name: 'INV-2' })).toBeInTheDocument();

    const blocks = screen.getByRole('region', { name: 'Blocks' });
    expect(within(blocks).getByRole('button', { name: 'INV-3' })).toBeInTheDocument();
    expect(within(blocks).getByText('blocks')).toBeInTheDocument();
  });

  it('shows contract, runs, evidence, and audits on the work context page', async () => {
    const review = vi.fn().mockResolvedValue({
      data: {
        workReview: {
          success: true,
          issue: { id: 'issue-2', identifier: 'INV-2', revision: 4 },
          decision: { id: 'decision-1', decision: 'ACCEPTED' },
        },
      },
    });
    apolloMocks.useMutation.mockImplementation((document) => {
      return documentSource(document).includes('mutation WorkReview') ? [review] : [vi.fn()];
    });
    renderApp(
      { data: boardQueryResult, workContextData: workContextQuery, loading: false },
      ['/work/issue-2'],
    );

    expect(await screen.findByText('INV-2')).toBeInTheDocument();
    expect(screen.getByText('Child task')).toBeInTheDocument();
    expect(screen.getByText('Ready queue excludes blocked work')).toBeInTheDocument();
    expect(screen.getByText('RUN-1')).toBeInTheDocument();
    expect(screen.getByText('Patch landed, waiting for review')).toBeInTheDocument();
    expect(screen.getByText('Implementation PR')).toBeInTheDocument();
    expect(screen.getByText('run completed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Issue editor' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(review).toHaveBeenCalledWith({
      variables: {
        id: 'issue-2',
        input: { decision: 'ACCEPTED', expectedRevision: 3 },
      },
    }));
  });

  it('loads the next candidate page only from the advertised cursor', async () => {
    const fetchMore = vi.fn().mockResolvedValue(undefined);
    renderApp({
      data: boardQueryResult,
      candidatesData: {
        ...candidateQuery,
        issues: {
          ...candidateQuery.issues,
          pageInfo: { endCursor: 'candidate-cursor', hasNextPage: true },
        },
      },
      fetchMore,
      loading: false,
    }, ['/candidates']);

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(fetchMore).toHaveBeenCalledWith(expect.objectContaining({
      variables: { after: 'candidate-cursor' },
      updateQuery: expect.any(Function),
    })));
  });

  it('shows retry controls when candidate pagination fails', async () => {
    const fetchMore = vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(undefined);
    renderApp({
      data: boardQueryResult,
      candidatesData: {
        ...candidateQuery,
        issues: {
          ...candidateQuery.issues,
          pageInfo: { endCursor: 'candidate-cursor', hasNextPage: true },
        },
      },
      fetchMore,
      loading: false,
    }, ['/candidates']);

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load more candidates.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading more' }));
    await waitFor(() => expect(fetchMore).toHaveBeenCalledTimes(2));
  });

  it('shows retry controls when graph pagination fails', async () => {
    const fetchMore = vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(undefined);
    renderApp({
      data: boardQueryResult,
      fetchMore,
      graphData: {
        ...graphQuery,
        issues: {
          ...graphQuery.issues,
          pageInfo: { endCursor: 'graph-cursor', hasNextPage: true },
        },
      },
      loading: false,
    }, ['/graph']);

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load more graph nodes.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading more' }));
    await waitFor(() => expect(fetchMore).toHaveBeenCalledTimes(2));
  });

  it('does not report a failed context query as missing work', async () => {
    renderApp({ data: boardQueryResult, error: new Error('network down'), loading: false }, ['/work/issue-2']);
    expect(await screen.findByRole('heading', { name: 'Could not load work context' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Work not found' })).not.toBeInTheDocument();
  });

  it('opens candidates and graph from keyboard shortcuts', async () => {
    renderApp({ data: boardQueryResult, candidatesData: candidateQuery, graphData: graphQuery, loading: false }, ['/']);

    expect(await screen.findByRole('heading', { name: 'All issues' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.keyDown(window, { key: 'c' });
    expect(await screen.findByRole('heading', { name: 'Candidates' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.keyDown(window, { key: 'r' });
    expect(await screen.findByRole('heading', { name: 'Graph' })).toBeInTheDocument();
  });
});

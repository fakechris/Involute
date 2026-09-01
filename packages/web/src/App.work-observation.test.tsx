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
  teams: boardQueryResult.teams,
  users: {
    nodes: [
      { id: 'user-1', name: 'Admin', email: 'admin@involute.local', actorKind: 'HUMAN' },
      { id: 'agent-1', name: 'Codex', email: 'codex@involute.local', actorKind: 'AGENT' },
    ],
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
      state: { id: 'state-review', name: 'In Review', type: 'STARTED', position: 3 },
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
        kind: 'PR',
        url: 'https://example.test/pr/1',
        summary: 'Implementation PR',
        createdAt: '2026-08-31T16:21:00.000Z',
      },
    ],
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

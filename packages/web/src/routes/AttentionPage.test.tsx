import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NeedsYouNavLink } from '../components/NeedsYouNavLink';
import { AttentionPage, formatWait, orderPack, packSummary, suggestedDecisions } from './AttentionPage';
import type { AttentionItemNode, CandidateWork } from '../work/types';

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function work(id: string, identifier: string, extra: Partial<CandidateWork> = {}): CandidateWork {
  return {
    acceptance: 'It works.',
    assignee: { actorKind: 'HUMAN', email: 'owner@test', id: 'user-1', name: 'Owner' },
    commitmentStatus: 'COMMITTED',
    createdAt: ago(HOUR),
    id,
    identifier,
    kind: 'ISSUE',
    labels: { nodes: [] },
    parent: { id: 'milestone-1', identifier: 'INV-1', kind: 'MILESTONE', title: 'Milestone' },
    priority: 0,
    repository: 'fakechris/Involute',
    revision: 3,
    state: { id: 'state-review', name: 'In Review', position: 3, type: 'REVIEW' },
    team: { id: 'team-1', key: 'INV' },
    title: `Title of ${identifier}`,
    ...extra,
  } as CandidateWork;
}

function node(kind: AttentionItemNode['kind'], subjectId: string, w: CandidateWork | null, since: string, extra: Partial<AttentionItemNode> = {}): AttentionItemNode {
  return {
    actions: kind === 'WORK_REVIEW' ? ['ACCEPT', 'RETURN'] : kind === 'CANDIDATE_COMMIT' ? ['COMMIT', 'REJECT'] : kind === 'CONTRACT_AMENDMENT' ? ['ACCEPT', 'REJECT'] : ['REPLY'],
    group: { id: 'milestone-1', identifier: 'INV-1', kind: 'MILESTONE', title: 'Milestone' },
    groupKey: 'milestone-1',
    id: `${kind}:${subjectId}`,
    kind,
    reason: `reason for ${subjectId}`,
    since,
    subjectId,
    work: w,
    ...extra,
  };
}

let nodes: AttentionItemNode[] = [];
let total = 0;
const mockRefetch = vi.fn().mockResolvedValue(undefined);
const mutations: Record<string, ReturnType<typeof vi.fn>> = {};
function mutation(name: string) {
  mutations[name] ??= vi.fn();
  return mutations[name]!;
}

function operationName(doc: { definitions: Array<{ name?: { value: string } }> }): string {
  return doc.definitions.find((definition) => definition.name)?.name?.value ?? '';
}

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn((doc: { definitions: Array<{ name?: { value: string } }> }) => {
    const name = operationName(doc);
    if (name === 'AttentionPage') {
      return {
        data: {
          attention: { nodes, pageInfo: { endCursor: null, hasNextPage: false } },
          attentionSummary: { byKind: [], total: nodes.length },
          teams: {
            nodes: [{
              id: 'team-1',
              key: 'INV',
              memberships: { nodes: [{ id: 'm1', user: { actorKind: 'HUMAN', email: 'owner@test', id: 'user-1', name: 'Owner' } }] },
              states: { nodes: [{ id: 'state-ready', name: 'Ready', type: 'UNSTARTED' }] },
            }],
          },
        },
        error: undefined,
        loading: false,
        refetch: mockRefetch,
      };
    }
    if (name === 'AttentionSummary') return { data: { attentionSummary: { total } }, loading: false };
    if (name === 'WorkContextPage') {
      return {
        data: {
          workContext: {
            ancestors: [],
            audits: [],
            blockedBy: [],
            blocks: [],
            claim: null,
            evidence: [],
            reviewDecisions: [],
            runs: [],
            work: {
              ...work('w-amend', 'INV-30'),
              agentRequests: [],
              pendingContractAmendment: {
                changes: [{ after: 'new rule', before: 'old rule', field: 'acceptance' }],
                createdAt: ago(HOUR),
                id: 'amend-1',
                proposedBy: { email: 'mia@agents', id: 'agent-1', name: 'Mia' },
                proposedByClaimant: false,
                reason: 'The rule changed.',
                stale: false,
              },
            },
          },
        },
        loading: false,
        refetch: vi.fn().mockResolvedValue(undefined),
      };
    }
    return { data: undefined, loading: false, refetch: vi.fn() };
  }),
  useMutation: vi.fn((doc: { definitions: Array<{ name?: { value: string } }> }) => [mutation(operationName(doc)), { loading: false }]),
}));

vi.mock('../lib/session', () => ({
  fetchSessionState: vi.fn().mockResolvedValue({ authenticated: true, authMode: 'session', googleOAuthConfigured: false, viewer: { email: 'owner@test', globalRole: 'ADMIN', id: 'user-1', name: 'Owner' } }),
}));

function renderPage() {
  return render(<MemoryRouter><AttentionPage /></MemoryRouter>);
}

function press(key: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
  });
}

afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mutations)) delete mutations[key];
  mutation('WorkReview').mockResolvedValue({ data: { workReview: { decision: { decision: 'ACCEPTED', id: 'd1' }, issue: { id: 'w-review', identifier: 'INV-20', revision: 4 }, success: true } } });
  mutation('WorkCommit').mockResolvedValue({ data: { workCommit: { issue: { id: 'x', identifier: 'x', revision: 2 }, success: true } } });
  nodes = [
    node('WORK_REVIEW', 'w-review', work('w-review', 'INV-20'), ago(30 * HOUR)),
    node('CONTRACT_AMENDMENT', 'amend-1', work('w-amend', 'INV-30'), ago(2 * HOUR)),
    node('CANDIDATE_COMMIT', 'c-1', work('c-1', 'INV-41', { commitmentStatus: 'CANDIDATE', revision: 1 }), ago(5 * HOUR)),
    node('CANDIDATE_COMMIT', 'c-2', work('c-2', 'INV-42', { commitmentStatus: 'CANDIDATE', revision: 1 }), ago(4 * HOUR)),
    node('CANDIDATE_COMMIT', 'c-3', work('c-3', 'INV-43', { commitmentStatus: 'CANDIDATE', revision: 1 }), ago(3 * HOUR)),
  ];
});

describe('Needs you (INV-1092)', () => {
  it('lists decisions by kind with counts, the oldest wait and their group, and opens the first one', () => {
    renderPage();
    expect(screen.getByText('5 waiting on your decision')).toBeInTheDocument();
    // Contract changes come before finished work, then candidates.
    const sections = screen.getAllByRole('region').filter((region) => region.className.includes('attention-section'));
    expect(sections.map((section) => section.getAttribute('aria-label'))).toEqual(['Contract changes', 'Accept work', 'Commit candidates']);
    const candidates = screen.getByRole('region', { name: 'Commit candidates' });
    expect(within(candidates).getByText('3')).toBeInTheDocument();
    expect(within(candidates).getByText('oldest 5h')).toBeInTheDocument();
    expect(within(candidates).getByText('INV-1 Milestone')).toBeInTheDocument();
    // The first item's decision is open on the right: the contract change, with its diff and buttons.
    const decision = screen.getByLabelText('Decision');
    expect(within(decision).getByText('The rule changed.')).toBeInTheDocument();
    expect(within(decision).getByRole('button', { name: /Accept change/ })).toBeInTheDocument();
  });

  it('J moves to finished work; A asks once, then accepts it as the review mutation', async () => {
    renderPage();
    press('j');
    const decision = screen.getByLabelText('Decision');
    expect(within(decision).getByRole('region', { name: 'Human review' })).toBeInTheDocument();

    press('a');
    expect(screen.getByRole('status')).toHaveTextContent('Press A again to accept INV-20. It cannot be undone.');
    expect(mutations.WorkReview).not.toHaveBeenCalled();

    press('a');
    await waitFor(() => expect(mutations.WorkReview).toHaveBeenCalledWith({ variables: { id: 'w-review', input: { decision: 'ACCEPTED', expectedRevision: 3 } } }));
    expect(mockRefetch).toHaveBeenCalled();
  });

  it('A on a candidate commits it at once through its card (commit can be undone)', async () => {
    renderPage();
    press('j');
    press('j');
    expect(within(screen.getByLabelText('Decision')).getByLabelText('INV-41 candidate')).toBeInTheDocument();
    press('a');
    await waitFor(() => expect(mutations.WorkCommit).toHaveBeenCalledTimes(1));
    expect(mutations.WorkCommit!.mock.calls[0]![0].variables.id).toBe('c-1');
  });

  it('commits a batch and reports each refusal by item', async () => {
    mutation('WorkCommit')
      .mockResolvedValueOnce({ data: { workCommit: { issue: { id: 'c-1', identifier: 'INV-41', revision: 2 }, success: true } } })
      .mockResolvedValueOnce({ data: { workCommit: { issue: null, message: 'Committing needs acceptance criteria.', success: false } } })
      .mockResolvedValueOnce({ data: { workCommit: { issue: { id: 'c-3', identifier: 'INV-43', revision: 2 }, success: true } } });
    renderPage();
    for (const id of ['INV-41', 'INV-42', 'INV-43']) fireEvent.click(screen.getByLabelText(`Select ${id}`));
    fireEvent.click(screen.getByRole('button', { name: 'Accept or commit 3' }));

    await waitFor(() => expect(mutations.WorkCommit).toHaveBeenCalledTimes(3));
    const results = await screen.findByRole('status', { name: 'Batch results' });
    expect(within(results).getByText('Committing needs acceptance criteria.')).toBeInTheDocument();
    expect(within(results).getAllByText('done')).toHaveLength(2);
    // Whoever decides from the queue keeps the existing human owner.
    expect(mutations.WorkCommit!.mock.calls[0]![0].variables.input).toEqual({ assigneeId: 'user-1', expectedRevision: 1 });
  });

  it('never batches a decision that needs a reason or a stale contract change', async () => {
    nodes = [
      node('AGENT_REQUEST', 'req-1', work('w-ask', 'INV-50'), ago(HOUR)),
      node('CONTRACT_AMENDMENT', 'amend-stale', work('w-stale', 'INV-51'), ago(HOUR), { actions: ['REJECT'] }),
    ];
    renderPage();
    fireEvent.click(screen.getByLabelText('Select INV-50'));
    expect(screen.getByText('1 of these need a decision one at a time; declining or returning needs a reason.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Accept or commit/ })).toBeNull();

    fireEvent.click(screen.getByLabelText('Select INV-51'));
    fireEvent.click(screen.getByRole('button', { name: 'Accept or commit 1' }));
    const results = await screen.findByRole('status', { name: 'Batch results' });
    expect(within(results).getByText(/out of date/)).toBeInTheDocument();
  });

  it('after a decision the next item takes the focus, not the top of the list', () => {
    const view = renderPage();
    press('j');
    press('j');
    press('j');
    const list = () => within(screen.getByLabelText('Waiting on your decision'));
    expect(list().getByText('INV-42').closest('li')).toHaveAttribute('aria-current', 'true');
    nodes = nodes.filter((entry) => entry.subjectId !== 'c-2');
    view.rerender(<MemoryRouter><AttentionPage /></MemoryRouter>);
    expect(list().getByText('INV-43').closest('li')).toHaveAttribute('aria-current', 'true');
  });

  it('says nothing is waiting and points to Activity when the list is empty', () => {
    nodes = [];
    renderPage();
    expect(screen.getByText('Nothing is waiting on your decision')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Activity' })).toHaveAttribute('href', '/inbox');
  });

  it('formats waits in minutes, hours and days', () => {
    const now = Date.parse('2026-10-10T12:00:00Z');
    expect(formatWait('2026-10-10T11:59:30Z', now)).toBe('1m');
    expect(formatWait('2026-10-10T09:00:00Z', now)).toBe('3h');
    expect(formatWait('2026-10-07T12:00:00Z', now)).toBe('3d');
  });
});

describe('Needs you by work tree (INV-1094)', () => {
  beforeEach(() => window.localStorage.clear());

  it('puts each work tree in one pack with a one-line summary, and remembers the choice', () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'By work tree' }));
    const pack = screen.getByRole('region', { name: 'INV-1 Milestone' });
    expect(within(pack).getByText('1 contract change, 1 finished item to accept, 3 candidates to commit')).toBeInTheDocument();
    expect(window.localStorage.getItem('involute.todo.view')).toBe('tree');
  });

  it('leads a pack with what just became ready and marks what waits and what is overdue', () => {
    nodes = [
      node('CANDIDATE_COMMIT', 'c-1', work('c-1', 'INV-41', { commitmentStatus: 'CANDIDATE' }), ago(5 * HOUR), { waitingOn: [{ id: 'c-2', identifier: 'INV-42', title: 'x' }] }),
      node('CANDIDATE_COMMIT', 'c-2', work('c-2', 'INV-42', { commitmentStatus: 'CANDIDATE' }), ago(4 * HOUR)),
      node('CONTRACT_AMENDMENT', 'amend-1', work('w-amend', 'INV-30'), ago(HOUR), { unblocked: true }),
      node('WORK_REVIEW', 'w-review', work('w-review', 'INV-20'), ago(100 * HOUR), { overdue: true }),
    ];
    expect(orderPack(nodes).map((entry) => entry.work?.identifier)).toEqual(['INV-30', 'INV-20', 'INV-42', 'INV-41']);
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'By work tree' }));
    expect(screen.getByText('Waiting on INV-42')).toBeInTheDocument();
    expect(screen.getByText('What blocked it is done')).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
  });

  it('offers the pack\'s suggested decisions only after showing the list, and stops at the first refusal', async () => {
    mutation('ContractAmendmentAccept').mockResolvedValue({ data: { contractAmendmentAccept: { success: true } } });
    mutation('WorkCommit')
      .mockResolvedValueOnce({ data: { workCommit: { issue: null, message: 'Choose a parent first.', success: false } } })
      .mockResolvedValue({ data: { workCommit: { issue: { id: 'x', identifier: 'x', revision: 2 }, success: true } } });
    // Review and anything waiting on unfinished work are never in the pack's button.
    expect(suggestedDecisions(nodes).map((entry) => entry.kind)).toEqual(['CONTRACT_AMENDMENT', 'CANDIDATE_COMMIT', 'CANDIDATE_COMMIT', 'CANDIDATE_COMMIT']);
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'By work tree' }));
    fireEvent.click(screen.getByRole('button', { name: 'Do the suggested decisions (4)' }));
    const confirm = screen.getByRole('dialog', { name: 'Confirm decisions for INV-1 Milestone' });
    expect(within(confirm).getAllByRole('listitem')).toHaveLength(4);
    expect(mutations.ContractAmendmentAccept).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm 4 decisions' }));
    const results = await screen.findByRole('status', { name: 'Batch results' });
    expect(within(results).getByText('Choose a parent first.')).toBeInTheDocument();
    // The pack runs in its own order (longest wait first): the first commit is refused, the other three are left.
    expect(within(results).getAllByText('Not done: stopped at the refusal above.')).toHaveLength(3);
    expect(mutations.WorkCommit).toHaveBeenCalledTimes(1);
  });

  it('summarises a pack in section order', () => {
    expect(packSummary([node('OPS', 'o', null, ago(HOUR)), node('CANDIDATE_COMMIT', 'c', null, ago(HOUR)), node('CANDIDATE_COMMIT', 'd', null, ago(HOUR))])).toBe('2 candidates to commit, 1 operations item');
  });
});

describe('Needs you in the sidebar', () => {
  it('shows the count with its label and hides it at zero', () => {
    total = 4;
    const view = render(<MemoryRouter><NeedsYouNavLink authenticated className={() => 'link'} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /Needs you/ })).toHaveAttribute('href', '/todo');
    expect(screen.getByLabelText('4 waiting on your decision')).toHaveTextContent('4');
    total = 0;
    view.rerender(<MemoryRouter><NeedsYouNavLink authenticated className={() => 'link'} /></MemoryRouter>);
    expect(screen.queryByLabelText(/waiting on your decision/)).toBeNull();
  });
});

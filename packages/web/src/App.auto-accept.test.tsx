import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';

// INV-1075: an auto-accepted bug says so on its page and can be sent back to Review.
const team = boardQueryResult.teams.nodes[0]!;
const done = team.states.nodes.find((state) => state.type === 'COMPLETED') ?? { id: 'state-done', name: 'Done', type: 'COMPLETED' as const, position: 9 };
const review = { id: 'state-review', name: 'In Review', type: 'REVIEW' as const, position: 3 };
const states = { nodes: [...team.states.nodes.filter((state) => state.type !== 'REVIEW'), review, ...(team.states.nodes.some((s) => s.type === 'COMPLETED') ? [] : [done])] };

const data = {
  ...boardQueryResult,
  issues: {
    ...boardQueryResult.issues,
    nodes: boardQueryResult.issues.nodes.map((issue) =>
      issue.id === 'issue-1'
        ? {
            ...issue,
            state: done,
            team: { ...issue.team, name: team.name, states },
            autoAccept: { outcome: 'ACCEPTED', accepted: true, createdAt: '2026-10-09T10:00:00.000Z', reasons: ['Auto-accepted: GitHub confirms PR #12 merged; 2 CI check(s) green.'] },
          }
        : issue,
    ),
  },
};

describe('auto-accepted bug (INV-1075)', () => {
  it('says why it was accepted and returns it to Review on request', async () => {
    const update = vi.fn().mockResolvedValue({ data: { issueUpdate: { success: true, message: null, issue: { ...data.issues.nodes[0], state: review, revision: 2 } } } });
    apolloMocks.useMutation.mockImplementation((document: { loc?: { source: { body: string } } }) =>
      (document?.loc?.source.body ?? '').includes('mutation IssueUpdate') ? [update] : [vi.fn()]);
    renderApp(App, { data, loading: false }, ['/issue/issue-1']);
    const note = await screen.findByRole('note', { name: 'Auto-accepted' });
    expect(note).toHaveTextContent('PR #12 merged');
    fireEvent.click(screen.getByRole('button', { name: 'Return to Review' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ variables: { id: 'issue-1', input: { stateId: 'state-review', expectedRevision: 1 } } }));
  });
});

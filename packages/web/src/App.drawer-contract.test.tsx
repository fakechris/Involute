import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { IssueSummary } from './board/types';
import { apolloMocks, boardQueryResult, renderApp } from './test/app-test-helpers';

// INV-836: the board's issue drawer had no acceptance field at all, only a
// small "Contract" link to another page, while the description's own
// "验收标准" section looked like the thing to edit. A committed item with
// no acceptance cannot be claimed, and only a person can add it.

const committedWithoutAcceptance = {
  ...(boardQueryResult.issues.nodes[0] as IssueSummary),
  commitmentStatus: 'COMMITTED',
  acceptance: null,
  verification: null,
} as IssueSummary;

const data = {
  ...boardQueryResult,
  issues: { ...boardQueryResult.issues, nodes: [committedWithoutAcceptance, ...boardQueryResult.issues.nodes.slice(1)] },
};

function mockIssueUpdate() {
  const updateIssue = vi.fn().mockResolvedValue({
    data: { issueUpdate: { success: true, message: null, issue: { ...committedWithoutAcceptance, acceptance: 'Saving works.' } } },
  });
  apolloMocks.useMutation.mockImplementation((document: { loc?: { source: { body: string } } }) => {
    const body = document?.loc?.source.body ?? String(document);
    return [body.includes('mutation IssueUpdate') ? updateIssue : vi.fn()];
  });
  return updateIssue;
}

describe('the board drawer carries the contract (INV-836)', () => {
  it('shows every contract field, says why missing acceptance matters, and saves it from the drawer', async () => {
    const updateIssue = mockIssueUpdate();
    renderApp({ data, loading: false }, [`/?issue=${committedWithoutAcceptance.identifier}`]);

    const contract = await screen.findByRole('region', { name: 'Contract' });
    expect(within(contract).getByText('Acceptance')).toBeInTheDocument();
    expect(within(contract).getByText(/nobody can claim this work/)).toBeInTheDocument();

    fireEvent.click(within(contract).getByRole('button', { name: 'Add acceptance' }));
    fireEvent.change(within(contract).getByLabelText('Contract Acceptance'), { target: { value: 'Saving works.' } });
    fireEvent.click(within(contract).getByRole('button', { name: 'Save contract' }));

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith({
        variables: {
          id: committedWithoutAcceptance.id,
          input: expect.objectContaining({ acceptance: 'Saving works.' }),
        },
      });
    });
  });
});

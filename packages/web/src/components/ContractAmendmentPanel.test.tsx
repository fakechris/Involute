import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContractAmendmentSummary } from '../board/types';
import { ContractAmendmentPanel, useContractAmendmentDecisions } from './ContractAmendmentPanel';

const mockAccept = vi.fn();
const mockReject = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useMutation: vi.fn((document: { definitions: Array<{ name?: { value: string } }> }) =>
    document.definitions[0]?.name?.value === 'ContractAmendmentAccept' ? [mockAccept, { loading: false }] : [mockReject, { loading: false }]),
}));

const amendment: ContractAmendmentSummary = {
  id: 'amend-1',
  reason: 'The contract predates the research-out-of-repo rule.',
  stale: false,
  proposedByClaimant: true,
  createdAt: '2026-09-29T05:00:00.000Z',
  proposedBy: { id: 'agent-1', name: 'Claude Code', email: null },
  changes: [
    { field: 'acceptance', before: 'docs/research committed', after: 'notes in research/' },
    { field: 'verification', before: 'docs-lint exits 0', after: null },
  ],
};

afterEach(() => cleanup());
beforeEach(() => vi.clearAllMocks());

describe('ContractAmendmentPanel (INV-869)', () => {
  it('shows each field before and after, the reason, and that the proposer holds the claim', () => {
    render(<ContractAmendmentPanel amendment={amendment} onAccept={vi.fn()} onReject={vi.fn()} />);

    expect(screen.getByRole('region', { name: 'Proposed contract change' })).toBeInTheDocument();
    expect(screen.getByLabelText('Acceptance now')).toHaveTextContent('docs/research committed');
    expect(screen.getByLabelText('Acceptance proposed')).toHaveTextContent('notes in research/');
    expect(screen.getByLabelText('Verification proposed')).toHaveTextContent('(cleared)');
    expect(screen.getByText(/research-out-of-repo rule/)).toBeInTheDocument();
    expect(screen.getByText(/holds the claim on this work/)).toBeInTheDocument();
  });

  it('accepts in one click', async () => {
    const onAccept = vi.fn().mockResolvedValue(null);
    render(<ContractAmendmentPanel amendment={amendment} onAccept={onAccept} onReject={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Accept change' }));
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith('amend-1'));
  });

  it('rejecting asks for a note first', async () => {
    const onReject = vi.fn().mockResolvedValue(null);
    render(<ContractAmendmentPanel amendment={amendment} onAccept={vi.fn()} onReject={onReject} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reject…' }));
    const confirm = screen.getByRole('button', { name: 'Reject change' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Rejection note'), { target: { value: '  the rule still holds ' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(onReject).toHaveBeenCalledWith('amend-1', 'the rule still holds'));
  });

  it('a stale proposal cannot be accepted and says why; a refusal is shown', async () => {
    const onReject = vi.fn().mockResolvedValue('This amendment was already decided or replaced by a newer one.');
    render(<ContractAmendmentPanel amendment={{ ...amendment, stale: true }} onAccept={vi.fn()} onReject={onReject} />);

    expect(screen.getByRole('button', { name: 'Accept change' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('The contract changed since this was proposed');

    fireEvent.click(screen.getByRole('button', { name: 'Reject…' }));
    fireEvent.change(screen.getByLabelText('Rejection note'), { target: { value: 'outdated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject change' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already decided');
  });
});

describe('useContractAmendmentDecisions', () => {
  it('runs the mutation, refreshes on success, and returns the refusal otherwise', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    mockAccept.mockResolvedValueOnce({ data: { contractAmendmentAccept: { success: true, message: null } } });
    mockReject.mockResolvedValueOnce({ data: { contractAmendmentReject: { success: false, message: 'Rejecting an amendment needs a note, so the agent learns why.' } } });
    const { result } = renderHook(() => useContractAmendmentDecisions(refresh));

    await expect(result.current.accept('amend-1')).resolves.toBeNull();
    expect(mockAccept).toHaveBeenCalledWith({ variables: { input: { amendmentId: 'amend-1' } } });
    expect(refresh).toHaveBeenCalledTimes(1);

    await expect(result.current.reject('amend-1', '')).resolves.toMatch(/needs a note/);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

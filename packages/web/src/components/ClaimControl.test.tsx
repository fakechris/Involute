import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaimControl } from './ClaimControl';

const mockRelease = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useMutation: vi.fn(() => [mockRelease, { loading: false }]),
}));

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  mockRelease.mockResolvedValue({ data: { workClaimRelease: { success: true, message: null } } });
});

const claim = { executionId: 'worker-session-a', leaseUntil: '2026-09-27T12:00:00.000Z', actor: { id: 'agent-1', name: 'Bot', email: null } };

describe('claim holder and release (INV-789)', () => {
  it('shows who holds the work and releases it with a reason', async () => {
    render(<ClaimControl workId="work-1" claim={claim} />);
    expect(screen.getByText('Bot')).toBeInTheDocument();
    expect(screen.getByText(/worker-session-a/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Release claim' }));
    const release = screen.getByRole('button', { name: 'Release' });
    expect(release).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Why release this claim'), { target: { value: 'Stuck for a day' } });
    fireEvent.click(release);
    await waitFor(() => expect(mockRelease).toHaveBeenCalledWith({ variables: { workId: 'work-1', reason: 'Stuck for a day' } }));
    expect(await screen.findByRole('button', { name: 'Release claim' })).toBeInTheDocument();
  });

  it('shows the refusal reason and says when nobody holds the work', async () => {
    mockRelease.mockResolvedValueOnce({ data: { workClaimRelease: { success: false, message: 'This work has no claim to release.' } } });
    const { rerender } = render(<ClaimControl workId="work-1" claim={claim} />);
    fireEvent.click(screen.getByRole('button', { name: 'Release claim' }));
    fireEvent.change(screen.getByLabelText('Why release this claim'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This work has no claim to release.');
    rerender(<ClaimControl workId="work-1" claim={null} />);
    expect(screen.getByText('Unclaimed')).toBeInTheDocument();
  });
});

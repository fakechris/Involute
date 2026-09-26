import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BugTriageTab } from './BugTriageTab';

const mockUpdate = vi.fn();
const mockRefetch = vi.fn().mockResolvedValue(undefined);

const teamData = {
  teams: {
    nodes: [
      {
        id: 'team-1',
        key: 'INV',
        name: 'Involute',
        memberships: {
          nodes: [
            { id: 'm1', user: { id: 'u-ana', name: 'Ana', email: 'ana@x', actorKind: 'HUMAN' } },
            { id: 'm2', user: { id: 'u-bo', name: 'Bo', email: 'bo@x', actorKind: 'HUMAN' } },
            { id: 'm3', user: { id: 'u-bot', name: 'Bot', email: 'bot@x', actorKind: 'AGENT' } },
          ],
        },
        triageRotation: { startsAt: '2026-09-21T00:00:00.000Z', users: [{ id: 'u-ana', name: 'Ana', email: 'ana@x' }] },
        currentTriager: { id: 'u-ana', name: 'Ana', email: 'ana@x' },
      },
    ],
  },
};

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn(() => ({ data: teamData, loading: false, error: undefined, refetch: mockRefetch })),
  useMutation: vi.fn(() => [mockUpdate, { loading: false }]),
}));

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockResolvedValue({ data: { teamTriageRotationUpdate: { success: true, message: null } } });
});

describe('bug triage rotation settings (INV-750)', () => {
  it('shows who is on duty and saves the rotation in order', async () => {
    render(<BugTriageTab />);
    expect(screen.getByText('Ana', { selector: 'strong' })).toBeInTheDocument();
    const add = screen.getByLabelText('Add to rotation');
    // Agents are not offered.
    expect(within(add).queryByRole('option', { name: 'Bot' })).not.toBeInTheDocument();
    fireEvent.change(add, { target: { value: 'u-bo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move Bo up' }));
    expect(within(screen.getByRole('list', { name: 'Rotation order' })).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('Week 1: Bo'),
      expect.stringContaining('Week 2: Ana'),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Save rotation' }));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({
        variables: { input: { teamId: 'team-1', userIds: ['u-bo', 'u-ana'], startsAt: expect.any(String) } },
      }),
    );
    expect(await screen.findByText('Rotation saved.')).toBeInTheDocument();
  });

  it('shows the server reason when the rotation is refused', async () => {
    mockUpdate.mockResolvedValueOnce({
      data: { teamTriageRotationUpdate: { success: false, message: 'A triage rotation lists human members of the team and a valid start date.' } },
    });
    render(<BugTriageTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Save rotation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('human members of the team');
  });
});

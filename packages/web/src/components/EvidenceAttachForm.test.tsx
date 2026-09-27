import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EvidenceAttachForm } from './EvidenceAttachForm';

const mockAttach = vi.fn();
vi.mock('@apollo/client/react', () => ({ useMutation: vi.fn(() => [mockAttach, { loading: false }]) }));

afterEach(() => cleanup());

describe('attaching evidence by hand (INV-796)', () => {
  it('records a merged PR on the work, without a run', async () => {
    mockAttach.mockResolvedValue({ data: { evidenceAttach: { success: true } } });
    render(<EvidenceAttachForm workId="work-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Attach evidence' }));
    fireEvent.change(screen.getByLabelText('Evidence URL'), { target: { value: 'https://github.com/acme/app/pull/64' } });
    fireEvent.change(screen.getByLabelText('Evidence summary'), { target: { value: 'Found by the audit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() =>
      expect(mockAttach).toHaveBeenCalledWith({
        variables: { input: { workId: 'work-1', kind: 'pr', url: 'https://github.com/acme/app/pull/64', summary: 'Found by the audit' } },
      }),
    );
    expect(await screen.findByRole('button', { name: 'Attach evidence' })).toBeInTheDocument();
  });

  it('shows why it was refused', async () => {
    mockAttach.mockResolvedValue({ data: { evidenceAttach: { success: false, message: 'Work item not found.' } } });
    render(<EvidenceAttachForm workId="work-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Attach evidence' }));
    fireEvent.change(screen.getByLabelText('Evidence URL'), { target: { value: 'https://x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Work item not found.');
  });
});

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMutation } from '@apollo/client/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EvidenceAttachForm } from './EvidenceAttachForm';

const mockAttach = vi.fn();
const mockUpload = vi.fn();
vi.mock('@apollo/client/react', () => ({ useMutation: vi.fn(() => [mockAttach, { loading: false }]) }));

afterEach(() => {
  cleanup();
  mockAttach.mockReset();
  mockUpload.mockReset();
  vi.mocked(useMutation).mockReset();
  vi.mocked(useMutation).mockImplementation(() => [mockAttach, { loading: false }] as never);
});

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

  it('uploads a screenshot file and submits its address', async () => {
    vi.mocked(useMutation).mockImplementation((document) => {
      const body = (document as { loc?: { source?: { body?: string } } } | undefined)?.loc?.source?.body ?? '';
      return [body.includes('fileUpload') ? mockUpload : mockAttach, { loading: false }] as never;
    });
    mockUpload.mockResolvedValue({ data: { fileUpload: { success: true, message: null, attachment: { id: 'shot', url: '/uploads/shot.png', filename: 'shot.png' } } } });
    mockAttach.mockResolvedValue({ data: { evidenceAttach: { success: true } } });
    const { container } = render(<EvidenceAttachForm workId="work-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Attach evidence' }));
    fireEvent.change(screen.getByLabelText('Evidence kind'), { target: { value: 'screenshot' } });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['hi'], 'shot.png', { type: 'image/png' })] } });
    await waitFor(() => expect(mockUpload).toHaveBeenCalledWith({
      variables: { input: { filename: 'shot.png', mimeType: 'image/png', content: 'aGk=', issueId: 'work-1' } },
    }));
    expect(screen.getByLabelText('Evidence URL')).toHaveValue('/uploads/shot.png');
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(mockAttach).toHaveBeenCalledWith({
      variables: { input: { workId: 'work-1', kind: 'screenshot', url: '/uploads/shot.png', summary: null } },
    }));
  });
});

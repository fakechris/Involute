import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkFiles } from './WorkFiles';

const runUpload = vi.fn();
vi.mock('@apollo/client/react', () => ({ useMutation: () => [runUpload, { loading: false }] }));

afterEach(() => {
  cleanup();
  runUpload.mockReset();
});

describe('WorkFiles', () => {
  it('uploads a chosen file onto the work', async () => {
    runUpload.mockResolvedValue({ data: { fileUpload: { success: true, message: null, attachment: { id: 'a', url: '/uploads/shot.png', filename: 'shot.png' } } } });
    const onChanged = vi.fn();
    const { container } = render(<WorkFiles workId="issue-1" files={[]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add file' }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['hi'], 'shot.png', { type: 'image/png' })] } });
    await waitFor(() => expect(runUpload).toHaveBeenCalledWith({
      variables: { input: { filename: 'shot.png', mimeType: 'image/png', content: 'aGk=', issueId: 'issue-1' } },
    }));
    expect(onChanged).toHaveBeenCalled();
  });
});

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RichTextEditor } from './RichTextEditor';

// INV-1015: the attachment upload entry point (fileUpload) has a click test.
const runFileUpload = vi.fn().mockResolvedValue({ data: { fileUpload: { success: true, attachment: { url: 'https://files.example.com/note.txt', filename: 'note.txt' } } } });
vi.mock('@apollo/client/react', () => ({ useMutation: () => [runFileUpload], useQuery: () => ({ data: undefined }) }));

afterEach(() => { cleanup(); runFileUpload.mockClear(); });

describe('RichTextEditor attachments', () => {
  it('uploads a chosen file through fileUpload and marks the text while it uploads', async () => {
    const onChange = vi.fn();
    const { container } = render(<RichTextEditor value="" onChange={onChange} ariaLabel="Comment" />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { files: [new File(['hi'], 'note.txt', { type: 'text/plain' })] } });

    await waitFor(() => {
      expect(runFileUpload).toHaveBeenCalledWith({ variables: { input: { filename: 'note.txt', mimeType: 'text/plain', content: 'aGk=' } } });
    });
    // The controlled value is the caller's: here it only gets the placeholder (the link replaces it once the parent re-renders).
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining('[Uploading note.txt…]'));
  });
});

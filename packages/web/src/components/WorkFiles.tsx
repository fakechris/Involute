import { useRef, useState } from 'react';
import { useMutation } from '@apollo/client/react';
import { isRenderableImageUrl } from '@turnkeyai/involute-shared';

import { FILE_UPLOAD_MUTATION } from '../board/queries';
import type { FileUploadMutationData, FileUploadMutationVariables } from '../board/types';
import { extraImageHosts } from '../image-hosts';
import { InlineError } from './status';
import { Btn } from './Primitives';
import { MarkdownRenderer } from './MarkdownRenderer';
import { readFileAsBase64 } from './RichTextEditor';
import { ImageViewer } from './ImageViewer';
import { SafeImage } from './SafeImage';

export interface WorkFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url: string;
  textContent?: string | null;
  createdAt?: string;
}

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/;

function showThumb(file: WorkFile): boolean {
  if (file.mimeType === 'image/svg+xml') return false;
  if (IMAGE_MIME.test(file.mimeType)) return true;
  return isRenderableImageUrl(file.url, { extraHosts: extraImageHosts() });
}

function isMarkdown(file: WorkFile): boolean {
  return file.mimeType === 'text/markdown' || file.mimeType === 'text/x-markdown' || file.filename.toLowerCase().endsWith('.md');
}

/**
 * Private files on a work item: thumbnails for pictures, a preview for
 * markdown, and a way to add another file that is already attached to the work.
 */
export function WorkFiles({ workId, files, onChanged }: { workId: string; files: WorkFile[]; onChanged?: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<WorkFile | null>(null);
  const [runUpload, state] = useMutation<FileUploadMutationData, FileUploadMutationVariables>(FILE_UPLOAD_MUTATION);

  async function onPick(file: File) {
    setError(null);
    try {
      const content = await readFileAsBase64(file);
      const result = await runUpload({
        variables: {
          input: {
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
            content,
            issueId: workId,
          },
        },
      });
      const payload = result.data?.fileUpload;
      if (!payload?.success || !payload.attachment?.url) {
        setError(payload?.message ?? 'Could not add the file.');
        return;
      }
      onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add the file.');
    }
  }

  return (
    <div className="issue-panel__section">
      <h2>Files · {files.length}</h2>
      <ul className="issue-children" role="list" aria-label="Files">
        {files.map((file) => (
          <li key={file.id} role="listitem" className="issue-children__row">
            {showThumb(file) ? (
              <SafeImage src={file.url} alt={file.filename} className="work-files__thumb" onOpen={() => setViewing(file)} />
            ) : null}
            {showThumb(file) ? (
              <button type="button" className="image-file-name" onClick={() => setViewing(file)}>{file.filename}</button>
            ) : (
              <a href={file.url} target="_blank" rel="noreferrer">{file.filename}</a>
            )}
            <span className="observation-card__meta">{file.mimeType} · {Math.max(1, Math.round(file.size / 1024))} KB</span>
            {isMarkdown(file) && file.textContent ? (
              <details className="work-files__preview" open>
                <summary>Preview</summary>
                <MarkdownRenderer content={file.textContent} />
              </details>
            ) : null}
          </li>
        ))}
      </ul>
      <input
        ref={inputRef}
        type="file"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void onPick(file);
        }}
      />
      <Btn variant="ghost" disabled={state?.loading} onClick={() => inputRef.current?.click()}>Add file</Btn>
      {error ? <InlineError>{error}</InlineError> : null}
      {viewing ? <ImageViewer src={viewing.url} alt={viewing.filename} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}

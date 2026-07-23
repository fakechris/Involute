import { type DragEvent, type ClipboardEvent, useCallback, useRef, useState } from 'react';
import { useMutation } from '@apollo/client/react';

import { FILE_UPLOAD_MUTATION } from '../board/queries';
import type { FileUploadMutationData, FileUploadMutationVariables } from '../board/types';
import { IcoLink } from './Icons';
import { Btn, Kbd } from './Primitives';

interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  submitLabel?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1] ?? '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function wrapSelection(
  textarea: HTMLTextAreaElement,
  before: string,
  after: string,
  placeholder: string,
): string {
  const { selectionStart, selectionEnd, value } = textarea;
  const selected = value.slice(selectionStart, selectionEnd);
  const replacement = selected || placeholder;
  const newValue =
    value.slice(0, selectionStart) + before + replacement + after + value.slice(selectionEnd);

  // Schedule cursor position after React re-render
  requestAnimationFrame(() => {
    textarea.focus();
    if (selected) {
      textarea.setSelectionRange(
        selectionStart + before.length,
        selectionStart + before.length + replacement.length,
      );
    } else {
      textarea.setSelectionRange(
        selectionStart + before.length,
        selectionStart + before.length + placeholder.length,
      );
    }
  });

  return newValue;
}

function insertAtCursor(textarea: HTMLTextAreaElement, text: string): string {
  const { selectionStart, value } = textarea;
  const newValue = value.slice(0, selectionStart) + text + value.slice(selectionStart);

  requestAnimationFrame(() => {
    textarea.focus();
    const pos = selectionStart + text.length;
    textarea.setSelectionRange(pos, pos);
  });

  return newValue;
}

export function RichTextEditor({
  value,
  onChange,
  onSubmit,
  placeholder = 'Leave a comment…',
  submitLabel = 'Comment',
  disabled = false,
  ariaLabel,
}: RichTextEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const linkInputRef = useRef<HTMLInputElement>(null);

  const [runFileUpload] = useMutation<FileUploadMutationData, FileUploadMutationVariables>(
    FILE_UPLOAD_MUTATION,
  );

  const uploadFile = useCallback(
    async (file: File) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      setUploadingCount((c) => c + 1);
      const uploadPlaceholder = `[Uploading ${file.name}…]`;
      onChange(insertAtCursor(textarea, uploadPlaceholder));

      try {
        const base64Content = await readFileAsBase64(file);
        const result = await runFileUpload({
          variables: {
            input: {
              filename: file.name,
              mimeType: file.type,
              content: base64Content,
            },
          },
        });

        const uploadResult = result.data?.fileUpload;
        if (!uploadResult?.success || !uploadResult.attachment?.url) {
          throw new Error('Upload failed');
        }
        const attachment = uploadResult.attachment;

        const isImage = IMAGE_MIME_TYPES.has(file.type);
        const markdownLink = isImage
          ? `![${attachment.filename}](${attachment.url})`
          : `[${attachment.filename}](${attachment.url})`;

        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          if (!ta) return;
          const currentVal = ta.value;
          const updated = currentVal.replace(uploadPlaceholder, markdownLink);
          onChange(updated);
        });
      } catch {
        // Remove placeholder on error
        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          if (!ta) return;
          const currentVal = ta.value;
          const updated = currentVal.replace(uploadPlaceholder, `[Upload failed: ${file.name}]`);
          onChange(updated);
        });
      } finally {
        setUploadingCount((c) => c - 1);
      }
    },
    [onChange, runFileUpload],
  );

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      Array.from(files).forEach((file) => {
        void uploadFile(file);
      });
    },
    [uploadFile],
  );

  function handleBold() {
    const textarea = textareaRef.current;
    if (!textarea) return;
    onChange(wrapSelection(textarea, '**', '**', 'bold text'));
  }

  function handleItalic() {
    const textarea = textareaRef.current;
    if (!textarea) return;
    onChange(wrapSelection(textarea, '*', '*', 'italic text'));
  }

  function handleCode() {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { selectionStart, selectionEnd, value: val } = textarea;
    const selected = val.slice(selectionStart, selectionEnd);
    const isMultiline = selected.includes('\n');

    if (isMultiline) {
      onChange(wrapSelection(textarea, '```\n', '\n```', 'code'));
    } else {
      onChange(wrapSelection(textarea, '`', '`', 'code'));
    }
  }

  function handleLinkInsert() {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const url = linkUrl.trim();
    if (!url) return;

    const { selectionStart, selectionEnd, value: val } = textarea;
    const selected = val.slice(selectionStart, selectionEnd);
    const text = selected || 'link text';
    const markdown = `[${text}](${url})`;
    const newValue = val.slice(0, selectionStart) + markdown + val.slice(selectionEnd);
    onChange(newValue);
    setLinkPopoverOpen(false);
    setLinkUrl('');

    requestAnimationFrame(() => {
      textarea.focus();
      const pos = selectionStart + markdown.length;
      textarea.setSelectionRange(pos, pos);
    });
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      handleFiles(files);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit?.();
    }
  }

  return (
    <div
      className={`rich-text-editor${isDragOver ? ' rich-text-editor--dragover' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <textarea
        ref={textareaRef}
        className="rich-text-textarea"
        aria-label={ariaLabel ?? placeholder}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
      />
      <div className="rich-text-toolbar">
        <button
          type="button"
          title="Bold (**text**)"
          disabled={disabled}
          onClick={handleBold}
          style={{ fontWeight: 700 }}
        >
          B
        </button>
        <button
          type="button"
          title="Italic (*text*)"
          disabled={disabled}
          onClick={handleItalic}
          style={{ fontStyle: 'italic' }}
        >
          I
        </button>
        <button
          type="button"
          title="Code (`code`)"
          disabled={disabled}
          onClick={handleCode}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
        >
          {'</>'}
        </button>
        <span style={{ position: 'relative' }}>
          <button
            type="button"
            title="Insert link"
            disabled={disabled}
            onClick={() => {
              setLinkPopoverOpen(!linkPopoverOpen);
              requestAnimationFrame(() => linkInputRef.current?.focus());
            }}
          >
            <IcoLink size={12} />
          </button>
          {linkPopoverOpen ? (
            <div className="rich-text-link-popover">
              <input
                ref={linkInputRef}
                type="url"
                placeholder="https://…"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleLinkInsert();
                  }
                  if (e.key === 'Escape') {
                    setLinkPopoverOpen(false);
                    setLinkUrl('');
                  }
                }}
              />
              <Btn variant="subtle" size="sm" onClick={handleLinkInsert}>
                Insert
              </Btn>
            </div>
          ) : null}
        </span>
        <button
          type="button"
          title="Attach file"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          📎
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          accept="image/jpeg,image/png,image/gif,image/webp,*/*"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              handleFiles(e.target.files);
              e.target.value = '';
            }
          }}
        />
        <div style={{ flex: 1 }} />
        {uploadingCount > 0 ? (
          <span className="upload-indicator">
            ↑ Uploading {uploadingCount} file{uploadingCount > 1 ? 's' : ''}…
          </span>
        ) : null}
        <span style={{ fontSize: 10, color: 'var(--fg-dim)', marginRight: 4 }}>
          <Kbd keys={['⌘', '↵']} /> to submit
        </span>
        <button
          type="button"
          className="rich-text-submit"
          disabled={disabled || !value.trim()}
          onClick={() => onSubmit?.()}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            height: 24, padding: '0 10px', fontSize: 12, fontWeight: 500,
            borderRadius: 'var(--r-2)', border: '1px solid transparent', cursor: 'pointer',
            whiteSpace: 'nowrap',
            ...(value.trim()
              ? { background: 'var(--accent)', color: 'var(--accent-fg)', borderColor: 'var(--accent-border)' }
              : { background: 'transparent', color: 'var(--fg-muted)', borderColor: 'var(--border)' }),
            ...(disabled || !value.trim() ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
          }}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

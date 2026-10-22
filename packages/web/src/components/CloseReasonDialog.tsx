import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { Field, Select, TextArea } from './controls';
import { DialogShell } from './DialogShell';
import { Btn } from './Primitives';

/** Why work was closed without being done (INV-1118); mirrors the server enum. */
export type WorkResolution = 'COMPLETED' | 'WONT_DO' | 'INVALID' | 'DUPLICATE' | 'CANNOT_REPRODUCE' | 'OBSOLETE';

export const RESOLUTION_OPTIONS: Array<{ value: WorkResolution; label: string }> = [
  { value: 'WONT_DO', label: "Won't do" },
  { value: 'INVALID', label: 'Invalid (not a real problem)' },
  { value: 'DUPLICATE', label: 'Duplicate' },
  { value: 'CANNOT_REPRODUCE', label: 'Cannot reproduce' },
  { value: 'OBSOLETE', label: 'Obsolete' },
  { value: 'COMPLETED', label: 'Already done elsewhere' },
];

export function resolutionLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return RESOLUTION_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export interface CloseReason {
  resolution: WorkResolution;
  reason: string | null;
}

/** A resolution picker; empty until a person chooses, so nothing is closed by default. */
export function ResolutionSelect({ value, onChange, ariaLabel, disabled, size }: {
  value: WorkResolution | '';
  onChange: (value: WorkResolution | '') => void;
  ariaLabel: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}) {
  return (
    <Select aria-label={ariaLabel} value={value} disabled={disabled} size={size} onChange={(event) => onChange(event.target.value as WorkResolution | '')}>
      <option value="">Choose why…</option>
      {RESOLUTION_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </Select>
  );
}

export function isBugIssue(issue: { labels?: { nodes: Array<{ name: string }> } | null }): boolean {
  return (issue.labels?.nodes ?? []).some((label) => label.name.trim().toLowerCase() === 'bug');
}

interface PendingRequest {
  title: string;
  needsReason: boolean;
  resolve: (value: CloseReason | null) => void;
}

function CloseReasonDialog({ request, onDone }: { request: PendingRequest; onDone: (value: CloseReason | null) => void }) {
  const [resolution, setResolution] = useState<WorkResolution | ''>('');
  const [reason, setReason] = useState('');
  const missing = !resolution ? 'Choose why it is closed.' : request.needsReason && !reason.trim() ? 'A bug is never closed without a reason (zero-bug).' : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (missing || !resolution) return;
    onDone({ resolution, reason: reason.trim() || null });
  }

  return (
    <DialogShell
      variant="modal"
      title={request.title}
      eyebrow="Close without doing it"
      ariaLabel="Close reason"
      backdropLabel="Keep it open"
      onClose={() => onDone(null)}
      onSubmit={submit}
      footer={
        <>
          {missing ? <p className="observation-card__meta dialog-shell__footer-start">{missing}</p> : null}
          <Btn variant="subtle" size="md" onClick={() => onDone(null)}>Keep open</Btn>
          <Btn type="submit" variant="accent" size="md" disabled={Boolean(missing)}>Cancel work</Btn>
        </>
      }
    >
      <Field label="Resolution">
        <ResolutionSelect ariaLabel="Resolution" value={resolution} onChange={setResolution} />
      </Field>
      <Field label={`Reason${request.needsReason ? '' : ' (optional)'}`}>
        <TextArea aria-label="Close reason text" value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
    </DialogShell>
  );
}

/**
 * Moving work to a Canceled state asks why first (INV-1118): a resolution, and
 * for a bug a reason. `askCloseReason` resolves with the answer, or null when
 * the person keeps the work open; render `closeReasonDialog` once.
 */
export function useCloseReason(): {
  askCloseReason: (options: { title: string; needsReason: boolean }) => Promise<CloseReason | null>;
  closeReasonDialog: ReactNode;
} {
  const [request, setRequest] = useState<PendingRequest | null>(null);
  const requestRef = useRef<PendingRequest | null>(null);

  const askCloseReason = useCallback((options: { title: string; needsReason: boolean }) => new Promise<CloseReason | null>((resolve) => {
    // A second ask while one is open answers the first with "keep open".
    requestRef.current?.resolve(null);
    const next = { ...options, resolve };
    requestRef.current = next;
    setRequest(next);
  }), []);

  const finish = useCallback((value: CloseReason | null) => {
    requestRef.current?.resolve(value);
    requestRef.current = null;
    setRequest(null);
  }, []);

  return {
    askCloseReason,
    closeReasonDialog: request ? <CloseReasonDialog key={request.title} request={request} onDone={finish} /> : null,
  };
}

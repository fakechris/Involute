import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { emptyPeekSession, openPeek, type PeekSaveRequest, type PeekSession } from '../board/issue-peek-edit';
import { IssuePeek, type PeekSaveResult } from './IssuePeek';

const issue = {
  id: 'a',
  identifier: 'INV-1',
  title: 'Alpha',
  revision: 3,
  description: 'alpha',
  priority: 2,
  state: { id: 'ready', name: 'Ready', type: 'UNSTARTED' },
  assignee: null as { id: string; name?: string | null } | null,
  labels: { nodes: [] as Array<{ id: string; name: string }> },
};

const states = [
  { id: 'ready', name: 'Ready', type: 'UNSTARTED' },
  { id: 'done', name: 'Done', type: 'COMPLETED' },
  { id: 'canceled', name: 'Canceled', type: 'CANCELED' },
];

function Harness({
  saveDescription,
  saveField = vi.fn(async () => ({ revision: 4, description: 'alpha' })),
  canWrite = true,
  onClose = () => {},
}: {
  saveDescription: (request: PeekSaveRequest) => Promise<PeekSaveResult>;
  saveField?: (patch: { stateId?: string; assigneeId?: string | null }) => Promise<{ revision: number; description: string } | { message: string }>;
  canWrite?: boolean;
  onClose?: () => void;
}) {
  const ref = useRef<PeekSession>(openPeek(emptyPeekSession(), { id: 'a', identifier: 'INV-1', description: 'alpha', revision: 3 }));
  const [session, setSession] = useState(ref.current);
  function onSession(update: PeekSession | ((current: PeekSession) => PeekSession)) {
    const next = typeof update === 'function' ? update(ref.current) : update;
    if (next === ref.current) return;
    ref.current = next;
    setSession(next);
  }
  return (
    <IssuePeek
      issue={issue}
      parent={null}
      session={session}
      onSession={onSession}
      canWrite={canWrite}
      ready
      states={states}
      users={[{ id: 'u', name: 'Ada' }]}
      returnTo={null}
      asideNote={null}
      saveDescription={saveDescription}
      saveField={saveField}
      onFollow={() => {}}
      onBack={() => {}}
      onOpenAside={() => {}}
      onClose={onClose}
    />
  );
}

afterEach(() => cleanup());

describe('IssuePeek', () => {
  it('saves only from the Save button, and Escape closes without saving', async () => {
    const saveDescription = vi.fn(async () => ({ ok: true as const, revision: 4, description: 'edited' }));
    const onClose = vi.fn();
    render(<Harness saveDescription={saveDescription} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }));
    const box = screen.getByRole('textbox', { name: 'Description' });
    fireEvent.change(box, { target: { value: 'edited' } });
    fireEvent.blur(box);
    expect(saveDescription).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(saveDescription).not.toHaveBeenCalled();
  });

  it('cancel puts the saved text back', () => {
    const saveDescription = vi.fn();
    render(<Harness saveDescription={saveDescription} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'gone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Description' })).not.toBeInTheDocument();
    expect(saveDescription).not.toHaveBeenCalled();
  });

  it('keeps the draft beside the server copy after a conflict', async () => {
    const saveDescription = vi.fn()
      .mockResolvedValueOnce({
        ok: false as const,
        conflict: true,
        message: 'Work revision does not match expected_revision.',
        server: { description: 'theirs', revision: 8 },
      })
      .mockResolvedValueOnce({ ok: true as const, revision: 9, description: 'mine' });
    render(<Harness saveDescription={saveDescription} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('theirs')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('mine');
    expect(screen.queryByText(/Draft kept/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply my draft' }));
    await waitFor(() => expect(saveDescription).toHaveBeenLastCalledWith({
      issueId: 'a',
      text: 'mine',
      expectedRevision: 8,
      generation: 2,
    }));
  });

  it('leaves status and description read-only without write access, and hides Canceled', () => {
    render(<Harness saveDescription={vi.fn()} canWrite={false} />);
    expect(screen.queryByRole('button', { name: 'Edit description' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Assignee' })).toBeDisabled();
    expect(screen.queryByRole('option', { name: 'Canceled' })).not.toBeInTheDocument();
    expect(screen.getByText('Read only')).toBeInTheDocument();
  });
});

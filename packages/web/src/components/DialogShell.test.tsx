import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Btn } from './Primitives';
import { DialogShell } from './DialogShell';

afterEach(cleanup);

function Harness({ onSubmit }: { onSubmit?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>open</button>
      {open ? (
        <DialogShell
          variant="modal"
          title="Create milestone"
          eyebrow="Cycles"
          onClose={() => setOpen(false)}
          onSubmit={(event) => { event.preventDefault(); onSubmit?.(); }}
          footer={<><Btn variant="subtle" size="md" onClick={() => setOpen(false)}>Cancel</Btn><Btn variant="accent" size="md" type="submit">Save</Btn></>}
        >
          <input aria-label="Name" />
          <input aria-label="Target" />
        </DialogShell>
      ) : null}
    </>
  );
}

describe('DialogShell (INV-1313)', () => {
  it('is a named modal dialog that focuses its first field and returns focus on close', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'open' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Create milestone' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveClass('dialog-shell--modal');
    expect(screen.getByText('Cycles')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('closes on Escape and from the backdrop', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close Create milestone' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('submits the body and footer as one form', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab inside the dialog', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    const save = screen.getByRole('button', { name: 'Save' });
    save.focus();
    fireEvent.keyDown(save, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close' }), { key: 'Tab', shiftKey: true });
    expect(save).toHaveFocus();
  });
});

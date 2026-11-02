import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { resolutionLabel, supersededPrefill, useCloseReason, type CloseReason } from './CloseReasonDialog';

function Harness({ needsReason, prefill }: { needsReason: boolean; prefill?: Partial<CloseReason> | undefined }) {
  const { askCloseReason, closeReasonDialog } = useCloseReason();
  const [answer, setAnswer] = useState<CloseReason | null | undefined>(undefined);
  return (
    <>
      <button type="button" onClick={() => void askCloseReason({ title: 'Cancel INV-9', needsReason, ...(prefill ? { prefill } : {}) }).then(setAnswer)}>ask</button>
      <output data-testid="answer">{answer === undefined ? 'pending' : JSON.stringify(answer)}</output>
      {closeReasonDialog}
    </>
  );
}

describe('close reason dialog (INV-1118)', () => {
  afterEach(cleanup);

  it('asks a bug for a reason as well as a resolution', async () => {
    render(<Harness needsReason />);
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    const submit = screen.getByRole('button', { name: 'Cancel work' });
    expect(screen.getByText('Choose why it is closed.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: 'CANNOT_REPRODUCE' } });
    expect(submit).toBeDisabled();
    expect(screen.getByText(/never closed without a reason/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Close reason text'), { target: { value: '  Fine on three machines ' } });
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByTestId('answer')).toHaveTextContent('{"resolution":"CANNOT_REPRODUCE","reason":"Fine on three machines"}'));
    expect(screen.queryByRole('dialog', { name: 'Close reason' })).not.toBeInTheDocument();
  });

  it('answers null when the person keeps the work open', async () => {
    render(<Harness needsReason={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep open' }));
    await waitFor(() => expect(screen.getByTestId('answer')).toHaveTextContent('null'));
  });

  it('labels resolutions for people', () => {
    expect(resolutionLabel('WONT_DO')).toBe("Won't do");
    expect(resolutionLabel(null)).toBeNull();
  });

  it('arrives prefilled for an item another one replaced, so the person only confirms (INV-1498)', async () => {
    const prefill = supersededPrefill({ kind: 'DECISION', supersededBy: { identifier: 'INV-1497', title: '决定：取代 INV-571' } });
    expect(prefill).toEqual({ resolution: 'OBSOLETE', reason: 'Superseded by INV-1497: 决定：取代 INV-571' });
    expect(supersededPrefill({ kind: 'ISSUE', supersededBy: { identifier: 'INV-2', title: 'Same thing' } })?.resolution).toBe('DUPLICATE');
    expect(supersededPrefill({ kind: 'DECISION', supersededBy: null })).toBeUndefined();
    render(<Harness needsReason={false} prefill={prefill} />);
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    expect(screen.getByLabelText('Resolution')).toHaveValue('OBSOLETE');
    expect(screen.getByLabelText('Close reason text')).toHaveValue('Superseded by INV-1497: 决定：取代 INV-571');
    const submit = screen.getByRole('button', { name: 'Cancel work' });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByTestId('answer')).toHaveTextContent('"resolution":"OBSOLETE"'));
    expect(screen.getByTestId('answer')).toHaveTextContent('Superseded by INV-1497');
  });
});

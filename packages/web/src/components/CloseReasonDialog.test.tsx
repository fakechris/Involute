import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { resolutionLabel, useCloseReason, type CloseReason } from './CloseReasonDialog';

function Harness({ needsReason }: { needsReason: boolean }) {
  const { askCloseReason, closeReasonDialog } = useCloseReason();
  const [answer, setAnswer] = useState<CloseReason | null | undefined>(undefined);
  return (
    <>
      <button type="button" onClick={() => void askCloseReason({ title: 'Cancel INV-9', needsReason }).then(setAnswer)}>ask</button>
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
});

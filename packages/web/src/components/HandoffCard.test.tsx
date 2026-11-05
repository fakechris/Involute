import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { HandoffCard } from './HandoffCard';

afterEach(cleanup);

// INV-1583: the hand-off card a delegation carries, one rendering everywhere.
describe('HandoffCard', () => {
  it('shows where to start, what to read, how far to go and what done means', () => {
    render(
      <HandoffCard
        handoff={{ baseCommit: 'abc1234', inputs: ['https://example.test/spec', 'INV-12'], allowedActions: ['read', 'edit', 'pr'], acceptance: 'Tests pass.', exceededActions: [] }}
      />,
    );
    const card = screen.getByLabelText('Hand-off card');
    expect(card).toHaveTextContent('Base commit');
    expect(card).toHaveTextContent('abc1234');
    expect(screen.getByRole('link', { name: 'https://example.test/spec' })).toHaveAttribute('href', 'https://example.test/spec');
    expect(card).toHaveTextContent('INV-12');
    expect(card).toHaveTextContent(/Allowed\s*read, edit, pr/);
    expect(card).toHaveTextContent(/Acceptance\s*Tests pass\./);
    expect(card).not.toHaveTextContent('Went beyond');
  });

  it('says what the executor reported beyond the card, and renders nothing without a card', () => {
    render(<HandoffCard handoff={{ baseCommit: null, inputs: [], allowedActions: ['read'], acceptance: null, exceededActions: ['push', 'pr'] }} />);
    expect(screen.getByLabelText('Hand-off card')).toHaveTextContent(/Went beyond\s*push, pr — reported without being allowed/);
    cleanup();
    const { container } = render(<HandoffCard handoff={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

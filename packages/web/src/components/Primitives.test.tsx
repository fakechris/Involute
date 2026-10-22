import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Btn, PriorityIcon } from './Primitives';

afterEach(cleanup);

describe('Btn (INV-1313)', () => {
  it('is class-based on the ui-action family, with primary as an alias of accent', () => {
    render(<Btn variant="primary" size="md">Save</Btn>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveClass('ui-action', 'ui-action--accent', 'ui-action--md');
    expect(button).not.toHaveAttribute('style');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('defaults to a small ghost button and supports icon-only, submit and danger', () => {
    render(
      <>
        <Btn icon={<svg aria-hidden="true" />} aria-label="More" />
        <Btn type="submit" variant="danger">Delete</Btn>
      </>,
    );
    expect(screen.getByRole('button', { name: 'More' })).toHaveClass('ui-action--ghost', 'ui-action--sm', 'ui-action--icon');
    const danger = screen.getByRole('button', { name: 'Delete' });
    expect(danger).toHaveClass('ui-action--danger');
    expect(danger).toHaveAttribute('type', 'submit');
  });

  it('is disabled and busy while loading', () => {
    const onClick = vi.fn();
    render(<Btn loading onClick={onClick}>Saving</Btn>);
    const button = screen.getByRole('button', { name: 'Saving' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('marks the active ghost button as pressed', () => {
    render(<Btn active>Board</Btn>);
    expect(screen.getByRole('button', { name: 'Board', pressed: true })).toHaveClass('is-active');
  });
});

describe('PriorityIcon', () => {
  it('takes its colour from the --prio tokens', () => {
    const { container } = render(<PriorityIcon level={1} />);
    expect((container.firstChild as HTMLElement).style.color).toBe('var(--prio-urgent)');
  });
});

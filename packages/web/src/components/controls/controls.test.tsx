import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Checkbox, Field, Select, TextArea, TextInput } from './index';

afterEach(cleanup);

describe('Field and the shared controls (INV-1313)', () => {
  it('wires the label, hint and error to the control inside', () => {
    render(
      <Field label="Found in" hint="The deploy you saw it on." error="A commit SHA: 7 to 40 hex characters.">
        <TextInput value="zz" onChange={() => undefined} />
      </Field>,
    );
    const input = screen.getByLabelText('Found in');
    expect(input).toHaveClass('control', 'control-input');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('The deploy you saw it on. A commit SHA: 7 to 40 hex characters.');
    expect(screen.getByRole('alert')).toHaveTextContent('A commit SHA');
  });

  it('keeps an explicit id and the control’s own aria-label', () => {
    render(
      <Field label="Priority" htmlFor="prio">
        <Select aria-label="Bug priority" value="2" onChange={() => undefined}>
          <option value="1">Urgent</option>
          <option value="2">High</option>
        </Select>
      </Field>,
    );
    const select = screen.getByRole('combobox', { name: 'Bug priority' });
    expect(select).toHaveAttribute('id', 'prio');
    expect(screen.getByText('Priority')).toHaveAttribute('for', 'prio');
    expect(select).toHaveClass('control', 'control-select');
    expect(select).not.toHaveAttribute('aria-invalid');
  });

  it('renders the ghost and small variants as classes, never inline styles', () => {
    render(
      <>
        <Select aria-label="State" variant="ghost" defaultValue="a"><option value="a">A</option></Select>
        <TextInput aria-label="Search" size="sm" />
        <TextArea aria-label="Notes" />
      </>,
    );
    const ghost = screen.getByRole('combobox', { name: 'State' });
    expect(ghost).toHaveClass('control--ghost');
    expect(ghost).not.toHaveAttribute('style');
    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveClass('control--sm');
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveClass('control-textarea');
  });

  it('passes native behaviour through', () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="Team" value="" onChange={(event) => onChange(event.target.value)} disabled={false}>
        <option value="">Choose</option>
        <option value="INV">Involute</option>
      </Select>,
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Team' }), { target: { value: 'INV' } });
    expect(onChange).toHaveBeenCalledWith('INV');
  });

  it('labels a checkbox by its row and toggles it', () => {
    const onChange = vi.fn();
    render(<Checkbox label="Create more" checked={false} onChange={(event) => onChange(event.target.checked)} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Create more' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('lays out a settings row with the label aside', () => {
    const { container } = render(
      <Field label="Full name" hint="Shown on your issues." layout="aside">
        <TextInput defaultValue="Ada" />
      </Field>,
    );
    expect(container.querySelector('.field--aside .field__aside')).toHaveTextContent('Full nameShown on your issues.');
    expect(screen.getByLabelText('Full name')).toHaveValue('Ada');
  });
});

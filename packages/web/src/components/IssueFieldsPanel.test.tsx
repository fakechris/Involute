import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { FieldDefinitionSummary } from '../board/types';
import { IssueFieldsPanel } from './IssueFieldsPanel';

// INV-1503: one control per field type; each saves { key: value } or null to clear.
const option = (value: string) => ({ value, label: value.toUpperCase(), archived: null });
const definitions: FieldDefinitionSummary[] = [
  { key: 'points', label: 'Points', type: 'NUMBER', required: false, options: [] },
  { key: 'flag', label: 'Flag', type: 'BOOLEAN', required: false, options: [] },
  { key: 'due', label: 'Due', type: 'DATE', required: false, options: [] },
  { key: 'tags', label: 'Tags', type: 'MULTI_ENUM', required: false, options: [option('a'), option('b'), { value: 'old', label: 'Old', archived: true }] },
  { key: 'reviewer', label: 'Reviewer', type: 'USER_REF', required: false, options: [] },
  { key: 'spec', label: 'Spec', type: 'URL', required: false, options: [] },
];

describe('IssueFieldsPanel', () => {
  it('saves each type in its own shape and hides archived options that are not set', () => {
    const onUpdate = vi.fn();
    render(<IssueFieldsPanel definitions={definitions} attributes={{ tags: ['a'], spec: 'https://example.com/spec' }} people={[{ id: 'u1', name: 'Ada' }]} onUpdate={onUpdate} />);

    const points = screen.getByRole('spinbutton', { name: 'Points' });
    fireEvent.change(points, { target: { value: '5' } });
    fireEvent.keyDown(points, { key: 'Enter' });
    expect(onUpdate).toHaveBeenLastCalledWith({ attributes: { points: 5 } });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Flag' }));
    expect(onUpdate).toHaveBeenLastCalledWith({ attributes: { flag: true } });

    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-11-30' } });
    expect(onUpdate).toHaveBeenLastCalledWith({ attributes: { due: '2026-11-30T00:00:00.000Z' } });

    expect(screen.queryByRole('checkbox', { name: 'Old' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'B' }));
    expect(onUpdate).toHaveBeenLastCalledWith({ attributes: { tags: ['a', 'b'] } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'A' }));
    expect(onUpdate).toHaveBeenLastCalledWith({ attributes: { tags: null } });

    fireEvent.change(screen.getByRole('combobox', { name: 'Reviewer' }), { target: { value: 'u1' } });
    expect(onUpdate).toHaveBeenLastCalledWith({ attributes: { reviewer: 'u1' } });

    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', 'https://example.com/spec');
  });

  it('renders nothing without definitions', () => {
    const { container } = render(<IssueFieldsPanel definitions={[]} attributes={{}} onUpdate={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

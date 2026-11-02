import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminFieldsTab, TeamFieldsSection, parseOptions } from './FieldsTab';
import type { FieldDefinitionRow, FieldSettingsData } from './settings-queries';

// INV-1504: Administration → Fields and Team settings → Fields (docs/field-definitions.md §7).

function row(overrides: Partial<FieldDefinitionRow>): FieldDefinitionRow {
  return {
    id: overrides.key ?? 'id', key: 'risk', label: 'Risk', description: null, type: 'ENUM',
    options: [{ value: 'low', label: 'Low', archived: null }, { value: 'high', label: 'High', archived: null }],
    appliesTo: { kinds: ['ISSUE'], types: ['any'] }, required: false, defaultValue: null, searchable: false, active: true, version: 1,
    previousKey: null, lastWrittenAt: '2026-10-30T00:00:00.000Z', usageCount: 4, stale: false, indexJob: null, indexProcessed: 0, ...overrides,
  };
}

let fieldData: FieldSettingsData;
const projects = { issues: { nodes: [{ id: 'project-1', identifier: 'INV-79', title: 'Involute', commitmentStatus: 'COMMITTED' }] } };
const mocks = { set: vi.fn(), deactivate: vi.fn(), rename: vi.fn(), refetch: vi.fn().mockResolvedValue(undefined), queryVariables: [] as unknown[] };

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn((doc: { definitions: Array<{ name?: { value: string } }> }, options?: { variables?: unknown }) => {
    const name = doc.definitions.find((definition) => definition.name)?.name?.value ?? '';
    if (name === 'FieldProjects') return { data: projects, loading: false, error: undefined, refetch: vi.fn() };
    mocks.queryVariables.push(options?.variables);
    return { data: fieldData, loading: false, error: undefined, refetch: mocks.refetch };
  }),
  useMutation: vi.fn((doc: { definitions: Array<{ name?: { value: string } }> }) => {
    const name = doc.definitions.find((definition) => definition.name)?.name?.value ?? '';
    const run = name === 'FieldDefinitionDeactivate' ? mocks.deactivate : name === 'FieldDefinitionRename' ? mocks.rename : mocks.set;
    return [run, { loading: false }];
  }),
}));

afterEach(() => cleanup());

beforeEach(() => {
  fieldData = {
    fieldLimits: { activePerScope: 30, enumOptions: 50, staleDays: 90 },
    fieldDefinitions: [
      row({ key: 'risk', searchable: true, indexJob: 'BACKFILL', indexProcessed: 120 }),
      row({ key: 'legacy', label: 'Legacy', type: 'TEXT', options: [], usageCount: 0, lastWrittenAt: null, stale: true }),
      row({ key: 'old_tier', label: 'Old tier', type: 'TEXT', options: [], active: false }),
    ],
  };
  mocks.set.mockReset().mockResolvedValue({ data: { fieldDefinitionSet: { success: true, message: null, definition: { id: 'x', key: 'k', version: 1 } } } });
  mocks.deactivate.mockReset().mockResolvedValue({ data: { fieldDefinitionDeactivate: { success: true, message: null } } });
  mocks.rename.mockReset().mockResolvedValue({ data: { fieldDefinitionRename: { success: true, message: null } } });
  mocks.queryVariables = [];
});

describe('Administration → Fields', () => {
  it('lists fields with usage, index progress, quota, retired and stale ones', () => {
    render(<AdminFieldsTab />);
    expect(mocks.queryVariables[0]).toEqual({ scope: 'WORKSPACE', scopeId: 'workspace' });
    expect(screen.getByLabelText('Field quota')).toHaveTextContent('2 of 30 active fields used');
    const table = screen.getByRole('table', { name: 'Field definitions' });
    const risk = within(table).getByText('risk').closest('tr')!;
    expect(risk).toHaveTextContent('Indexing… 120 items so far');
    expect(risk).toHaveTextContent('4');
    expect(within(table).getByText('old_tier').closest('tr')).toHaveTextContent('Retired');
    expect(screen.getByRole('note', { name: 'Cleanup' })).toHaveTextContent('Not written for 90 days: Legacy');
  });

  it('creates a list field with options, Kind × Type and searchable, carrying the reason', async () => {
    render(<AdminFieldsTab />);
    fireEvent.change(screen.getByLabelText('Reason for the field change'), { target: { value: 'track tiers' } });
    fireEvent.click(screen.getByRole('button', { name: 'New field' }));
    fireEvent.change(screen.getByLabelText('Field key'), { target: { value: 'customer_tier' } });
    fireEvent.change(screen.getByLabelText('Field label'), { target: { value: 'Customer tier' } });
    fireEvent.change(screen.getByLabelText('Field type'), { target: { value: 'ENUM' } });
    fireEvent.change(screen.getByLabelText('Field options'), { target: { value: 'gold | Gold\nsilver' } });
    expect(screen.getByText(/2 of 50 used/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Any Type'));
    fireEvent.click(screen.getByLabelText('Type bug'));
    fireEvent.click(screen.getByLabelText('Searchable'));
    fireEvent.click(screen.getByRole('button', { name: 'Save field' }));
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith({ variables: { input: expect.objectContaining({
      scope: 'WORKSPACE', scopeId: 'workspace', key: 'customer_tier', label: 'Customer tier', type: 'ENUM',
      options: [{ value: 'gold', label: 'Gold' }, { value: 'silver', label: 'silver' }],
      appliesTo: { kinds: ['ISSUE'], types: ['bug'] }, searchable: true, required: false, reason: 'track tiers',
    }) } }));
    expect(await screen.findByText('Field customer_tier saved.')).toBeInTheDocument();
  });

  it('edits keeping key and type, deactivates and renames with the reason, and reactivates a retired field', async () => {
    render(<AdminFieldsTab />);
    // Without a reason nothing destructive is possible.
    expect(screen.getByRole('button', { name: 'Deactivate legacy' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for the field change'), { target: { value: 'tidy up' } });

    fireEvent.click(screen.getByRole('button', { name: 'Edit risk' }));
    expect(screen.getByLabelText('Field key')).toBeDisabled();
    expect(screen.getByLabelText('Field type')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Required'));
    fireEvent.click(screen.getByRole('button', { name: 'Save field' }));
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith({ variables: { input: expect.objectContaining({ key: 'risk', type: 'ENUM', required: true, searchable: true }) } }));

    fireEvent.change(screen.getByLabelText('Reason for the field change'), { target: { value: 'tidy up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate legacy' }));
    await waitFor(() => expect(mocks.deactivate).toHaveBeenCalledWith({ variables: { input: { scope: 'WORKSPACE', scopeId: 'workspace', key: 'legacy', reason: 'tidy up' } } }));

    fireEvent.change(screen.getByLabelText('Reason for the field change'), { target: { value: 'clearer name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename risk' }));
    fireEvent.change(screen.getByLabelText('New key'), { target: { value: 'delivery_risk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename key' }));
    await waitFor(() => expect(mocks.rename).toHaveBeenCalledWith({ variables: { input: { scope: 'WORKSPACE', scopeId: 'workspace', from: 'risk', to: 'delivery_risk', reason: 'clearer name' } } }));

    fireEvent.change(screen.getByLabelText('Reason for the field change'), { target: { value: 'needed again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate old_tier' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save field' }));
    await waitFor(() => expect(mocks.set).toHaveBeenLastCalledWith({ variables: { input: expect.objectContaining({ key: 'old_tier', reason: 'needed again' }) } }));
  });

  it('shows the server refusal and blocks new fields at the limit', async () => {
    mocks.set.mockResolvedValue({ data: { fieldDefinitionSet: { success: false, message: 'Field "x": nope.' } } });
    fieldData = { ...fieldData, fieldLimits: { ...fieldData.fieldLimits, activePerScope: 2 } };
    render(<AdminFieldsTab />);
    expect(screen.getByRole('button', { name: 'Limit of 2 reached' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reactivate old_tier' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for the field change'), { target: { value: 'r' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit legacy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save field' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Field "x": nope.');
  });
});

describe('Team settings → Fields', () => {
  it('defines fields on the team or on one of its projects', () => {
    render(<TeamFieldsSection teamId="team-1" teamKey="INV" />);
    expect(mocks.queryVariables.at(-1)).toEqual({ scope: 'TEAM', scopeId: 'team-1' });
    fireEvent.change(screen.getByLabelText('Fields of'), { target: { value: 'project-1' } });
    expect(mocks.queryVariables.at(-1)).toEqual({ scope: 'PROJECT', scopeId: 'project-1' });
  });
});

describe('parseOptions', () => {
  it('reads value | Label lines', () => {
    expect(parseOptions(' a | Alpha \n\nb\n')).toEqual([{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'b' }]);
  });

  it('keeps an archived option archived through an edit (INV-1524)', () => {
    expect(parseOptions('a | Alpha\nold | Old | archived')).toEqual([{ value: 'a', label: 'Alpha' }, { value: 'old', label: 'Old', archived: true }]);
  });
});

describe('editing a list field with an archived option (INV-1524)', () => {
  it('saves the archived flag back unchanged', async () => {
    fieldData = { ...fieldData, fieldDefinitions: [row({ key: 'tier', options: [{ value: 'gold', label: 'Gold', archived: null }, { value: 'old', label: 'Old', archived: true }] })] };
    render(<AdminFieldsTab />);
    fireEvent.change(screen.getByLabelText('Reason for the field change'), { target: { value: 'relabel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit tier' }));
    expect(screen.getByLabelText('Field options')).toHaveValue('gold | Gold\nold | Old | archived');
    fireEvent.click(screen.getByRole('button', { name: 'Save field' }));
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith({ variables: { input: expect.objectContaining({ options: [{ value: 'gold', label: 'Gold' }, { value: 'old', label: 'Old', archived: true }] }) } }));
  });
});

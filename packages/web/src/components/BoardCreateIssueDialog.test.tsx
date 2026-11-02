import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FieldDefinitionSummary } from '../board/types';
import { BoardCreateIssueDialog } from './BoardCreateIssueDialog';
import type { FieldValues } from './DialogFields';

// INV-1505: the create dialog shows the fields that apply to the chosen Kind and place.
const queries: unknown[] = [];
let definitions: FieldDefinitionSummary[] = [];
let loading = false;

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn((document: unknown, options?: { variables?: unknown; skip?: boolean }) => {
    if (JSON.stringify(document).includes('ApplicableFields') && !options?.skip) {
      queries.push(options?.variables);
      return loading ? { data: undefined, previousData: { applicableFieldDefinitions: definitions }, loading: true } : { data: { applicableFieldDefinitions: definitions }, loading: false };
    }
    return { data: undefined, loading: false };
  }),
  useMutation: vi.fn(() => [vi.fn(), { loading: false }]),
}));
vi.mock('./RichTextEditor', () => ({ RichTextEditor: () => null }));
vi.mock('./PlacementPicker', () => ({ PlacementPicker: () => null }));

afterEach(() => cleanup());

function Harness({ onSubmit }: { onSubmit: () => void }) {
  const [attributes, setAttributes] = useState<FieldValues>({ gone: 'x' });
  return (
    <BoardCreateIssueDialog
      createDescription=""
      createTitle="New thing"
      isOpen
      isSaving={false}
      selectedTeam={{ id: 'team-1', key: 'INV', name: 'Involute' } as never}
      teams={[]}
      projects={[]}
      placement={{ parentId: 'project-1', repository: 'fakechris/Involute' } as never}
      placementSource={null}
      createMore={false}
      createKind="ISSUE"
      onCreateKindChange={vi.fn()}
      errorMessage={null}
      onPlacementChange={vi.fn()}
      onCreateMoreChange={vi.fn()}
      onClose={vi.fn()}
      onDescriptionChange={vi.fn()}
      onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
      onTeamChange={vi.fn()}
      onTitleChange={vi.fn()}
      attributes={attributes}
      onAttributesChange={setAttributes}
    />
  );
}

describe('BoardCreateIssueDialog fields (INV-1505)', () => {
  it('asks for the fields of the chosen Kind and place, blocks Create until required ones are set, and drops values that no longer apply', () => {
    definitions = [{ key: 'customer', label: 'Customer', description: null, type: 'TEXT', required: true, searchable: false, options: [] }];
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    expect(queries.at(-1)).toEqual({ teamId: 'team-1', parentId: 'project-1', kind: 'ISSUE', type: null });
    const create = screen.getByRole('button', { name: 'Create issue' });
    expect(create).toBeDisabled();
    const customer = screen.getByRole('textbox', { name: 'Customer' });
    fireEvent.change(customer, { target: { value: 'Acme' } });
    fireEvent.blur(customer);
    expect(create).toBeEnabled();
  });

  it('shows nothing when no field applies', () => {
    definitions = [];
    render(<Harness onSubmit={vi.fn()} />);
    expect(screen.queryByText('Fields')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create issue' })).toBeEnabled();
  });

  it('keeps entered values while the fields for a new place load, and a required field with a default does not block (INV-1524)', () => {
    definitions = [{ key: 'gone', label: 'Gone', description: null, type: 'TEXT', required: true, searchable: false, options: [], defaultValue: 'n/a' }];
    loading = true;
    const { rerender } = render(<Harness onSubmit={vi.fn()} />);
    // Loading: nothing pruned, Create waits for the answer.
    expect(screen.getByRole('button', { name: 'Create issue' })).toBeDisabled();
    loading = false;
    rerender(<Harness onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Create issue' })).toBeEnabled();
    // The value typed before the reload is still there.
    expect(screen.getByRole('textbox', { name: 'Gone' })).toHaveValue('x');
    loading = false;
  });
});

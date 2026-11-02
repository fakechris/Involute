import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FieldDefinitionSummary } from '../board/types';
import { BoardCreateIssueDialog } from './BoardCreateIssueDialog';
import type { FieldValues } from './DialogFields';

// INV-1505: the create dialog shows the fields that apply to the chosen Kind and place.
const queries: unknown[] = [];
let definitions: FieldDefinitionSummary[] = [];

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn((document: unknown, options?: { variables?: unknown; skip?: boolean }) => {
    if (JSON.stringify(document).includes('ApplicableFields') && !options?.skip) {
      queries.push(options?.variables);
      return { data: { applicableFieldDefinitions: definitions }, loading: false };
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
});

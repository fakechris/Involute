/**
 * Fields on the issue page (INV-1503, docs/field-definitions.md §8): one row
 * per field definition that applies to this item's Kind × Type, with the
 * control its type needs. The server validates every value and says why it
 * refused; required fields are marked, because committing refuses without them.
 */
import { useEffect, useState } from 'react';

import type { FieldDefinitionSummary, FieldValue } from '../board/types';
import { Checkbox, Select, TextInput } from './controls';

export type FieldsUpdate = { attributes: Record<string, FieldValue | null> };

interface Person { id: string; name: string | null; email?: string | null }

function isEmpty(value: FieldValue | null | undefined): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/** A text-like value saved when the input loses focus or Enter is pressed. */
function DraftInput({
  label, value, type, disabled, onSave,
}: { label: string; value: string; type: 'text' | 'number' | 'url'; disabled?: boolean | undefined; onSave: (next: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = () => { if (draft !== value) onSave(draft); };
  return (
    <TextInput
      type={type}
      size="sm"
      aria-label={label}
      className="control-grow"
      disabled={disabled}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') commit(); }}
    />
  );
}

function FieldControl({
  definition, value, people, disabled, onSave,
}: { definition: FieldDefinitionSummary; value: FieldValue | undefined; people: Person[]; disabled?: boolean | undefined; onSave: (next: FieldValue | null) => void }) {
  const label = definition.label;
  switch (definition.type) {
    case 'BOOLEAN':
      return <Checkbox aria-label={label} label="" checked={value === true} disabled={disabled} onChange={(event) => onSave(event.target.checked)} />;
    case 'ENUM':
      return (
        <Select aria-label={label} variant="ghost" size="sm" value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(event) => onSave(event.target.value || null)}>
          <option value="">—</option>
          {definition.options.filter((option) => !option.archived || option.value === value).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </Select>
      );
    case 'MULTI_ENUM': {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div role="group" aria-label={label} className="issue-fields__multi">
          {definition.options.filter((option) => !option.archived || selected.includes(option.value)).map((option) => (
            <Checkbox
              key={option.value}
              label={option.label}
              checked={selected.includes(option.value)}
              disabled={disabled}
              onChange={(event) => {
                const next = event.target.checked ? [...selected, option.value] : selected.filter((entry) => entry !== option.value);
                onSave(next.length ? next : null);
              }}
            />
          ))}
        </div>
      );
    }
    case 'USER_REF':
      return (
        <Select aria-label={label} variant="ghost" size="sm" value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(event) => onSave(event.target.value || null)}>
          <option value="">Nobody</option>
          {people.map((person) => <option key={person.id} value={person.id}>{person.name ?? person.email ?? person.id}</option>)}
        </Select>
      );
    case 'DATE':
      return (
        <TextInput
          type="date"
          size="sm"
          aria-label={label}
          className="control-grow"
          disabled={disabled}
          value={typeof value === 'string' ? value.slice(0, 10) : ''}
          onChange={(event) => onSave(event.target.value ? new Date(`${event.target.value}T00:00:00.000Z`).toISOString() : null)}
        />
      );
    case 'NUMBER':
      return (
        <DraftInput label={label} type="number" disabled={disabled} value={typeof value === 'number' ? String(value) : ''}
          onSave={(next) => onSave(next.trim() === '' ? null : Number(next))} />
      );
    case 'WORK_REF':
      return (
        <span className="issue-fields__ref">
          <DraftInput label={label} type="text" disabled={disabled} value={typeof value === 'string' ? value : ''} onSave={(next) => onSave(next.trim() || null)} />
          {typeof value === 'string' && value ? <a href={`/issue/${encodeURIComponent(value)}`}>Open</a> : null}
        </span>
      );
    case 'URL':
      return (
        <span className="issue-fields__ref">
          <DraftInput label={label} type="url" disabled={disabled} value={typeof value === 'string' ? value : ''} onSave={(next) => onSave(next.trim() || null)} />
          {typeof value === 'string' && value ? <a href={value} target="_blank" rel="noreferrer">Open</a> : null}
        </span>
      );
    default:
      return <DraftInput label={label} type="text" disabled={disabled} value={typeof value === 'string' ? value : ''} onSave={(next) => onSave(next === '' ? null : next)} />;
  }
}

export function IssueFieldsPanel({
  definitions, attributes, people = [], disabled, onUpdate,
}: {
  definitions: FieldDefinitionSummary[];
  attributes: Record<string, FieldValue> | null | undefined;
  people?: Person[] | undefined;
  disabled?: boolean | undefined;
  onUpdate: (update: FieldsUpdate) => void;
}) {
  if (!definitions.length) return null;
  const values = attributes ?? {};
  return (
    <div className="issue-fields" aria-label="Fields">
      {definitions.map((definition) => {
        const missing = definition.required && isEmpty(values[definition.key]);
        return (
          <div key={definition.key} className="issue-fields__row" title={definition.description ?? undefined}>
            <span className="issue-fields__label">
              {definition.label}
              {definition.required ? <span className={missing ? 'issue-fields__required issue-fields__required--missing' : 'issue-fields__required'} aria-label="required"> *</span> : null}
            </span>
            <FieldControl
              definition={definition}
              value={values[definition.key]}
              people={people}
              disabled={disabled}
              onSave={(next) => onUpdate({ attributes: { [definition.key]: next } })}
            />
          </div>
        );
      })}
    </div>
  );
}

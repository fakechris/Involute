/**
 * Field definitions inside the create / Report bug / commit dialogs (INV-1505,
 * docs/field-definitions.md §8): the fields that apply to the chosen team,
 * place, Kind and Type, with required ones marked. The server refuses a
 * committed item without them; the dialog says so before it is sent.
 */
import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';

import type { FieldDefinitionSummary, FieldValue } from '../board/types';
import { IssueFieldsPanel } from './IssueFieldsPanel';

export const APPLICABLE_FIELDS_QUERY = gql`
  query ApplicableFields($teamId: String!, $parentId: String, $kind: WorkKind!, $type: String) {
    applicableFieldDefinitions(teamId: $teamId, parentId: $parentId, kind: $kind, type: $type) {
      key label description type required searchable
      options { value label archived }
    }
  }
`;

export type FieldValues = Record<string, FieldValue>;

export function useApplicableFields(teamId: string | null | undefined, parentId: string | null | undefined, kind: string, type: string | null): FieldDefinitionSummary[] {
  const { data } = useQuery<{ applicableFieldDefinitions: FieldDefinitionSummary[] }, { teamId: string; parentId: string | null; kind: string; type: string | null }>(APPLICABLE_FIELDS_QUERY, {
    variables: { teamId: teamId ?? '', parentId: parentId ?? null, kind, type },
    skip: !teamId,
  });
  return Array.isArray(data?.applicableFieldDefinitions) ? data.applicableFieldDefinitions : [];
}

/** Labels of required fields that are still empty. */
export function missingRequiredFields(definitions: FieldDefinitionSummary[], values: FieldValues): string[] {
  return definitions
    .filter((definition) => definition.required)
    .filter((definition) => {
      const value = values[definition.key];
      return value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
    })
    .map((definition) => definition.label);
}

/** Only the values of fields that still apply, so a Type change does not send a stale key. */
export function applicableValues(definitions: FieldDefinitionSummary[], values: FieldValues): FieldValues {
  const keys = new Set(definitions.map((definition) => definition.key));
  return Object.fromEntries(Object.entries(values).filter(([key]) => keys.has(key)));
}

export function DialogFields({
  definitions, values, onChange, disabled, people,
}: {
  definitions: FieldDefinitionSummary[];
  values: FieldValues;
  onChange: (values: FieldValues) => void;
  disabled?: boolean | undefined;
  people?: Array<{ id: string; name: string | null; email?: string | null }> | undefined;
}) {
  if (!definitions.length) return null;
  const missing = missingRequiredFields(definitions, values);
  return (
    <div className="field">
      <span className="field__label">Fields</span>
      <IssueFieldsPanel
        definitions={definitions}
        attributes={values}
        people={people}
        disabled={disabled}
        onUpdate={(update) => {
          const next: FieldValues = { ...values };
          for (const [key, value] of Object.entries(update.attributes)) {
            if (value === null) delete next[key];
            else next[key] = value;
          }
          onChange(next);
        }}
      />
      {missing.length ? <span className="field__hint" role="note">Required before it is committed: {missing.join(', ')}.</span> : null}
    </div>
  );
}

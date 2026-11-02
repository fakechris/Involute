import { useMutation, useQuery } from '@apollo/client/react';
import { useState } from 'react';

import { Btn } from '../components/Primitives';
import { SettingsSectionHeader } from '../components/SettingsShell';
import { Checkbox, Field, Select, TextArea, TextInput } from '../components/controls';
import { Badge } from '../components/status';
import {
  FIELD_DEFINITION_DEACTIVATE_MUTATION,
  FIELD_DEFINITION_RENAME_MUTATION,
  FIELD_DEFINITION_SET_MUTATION,
  FIELD_PROJECTS_QUERY,
  FIELD_SETTINGS_QUERY,
  WORKSPACE_SETTINGS_SCOPE_ID,
  type AutonomyScope,
  type FieldDefinitionRow,
  type FieldSettingsData,
  type FieldType,
  type Refusable,
  type WorkKindName,
} from './settings-queries';
import { NoticeLine, attempt, type Notice } from './WorkspaceSettingsTabs';

// Fields settings (INV-1504, docs/field-definitions.md §7, decision INV-1501):
// Administration → Fields for the workspace (Admin), Team settings → Fields for
// a team or one of its projects (Owner). A field is configuration, not a
// column; values stay on items when a field is retired, and a key is renamed
// only with a reason.

const TYPES: Array<{ type: FieldType; label: string }> = [
  { type: 'TEXT', label: 'Text' },
  { type: 'NUMBER', label: 'Number' },
  { type: 'BOOLEAN', label: 'Yes / no' },
  { type: 'DATE', label: 'Date' },
  { type: 'ENUM', label: 'One of a list' },
  { type: 'MULTI_ENUM', label: 'Several of a list' },
  { type: 'WORK_REF', label: 'Work item' },
  { type: 'USER_REF', label: 'Person' },
  { type: 'URL', label: 'Link' },
];
const KINDS: WorkKindName[] = ['ISSUE', 'EPIC', 'MILESTONE', 'DECISION', 'PROJECT'];
const ITEM_TYPES = ['bug', 'feature', 'improvement', 'research', 'incident'];
const typeLabel = (type: FieldType) => TYPES.find((entry) => entry.type === type)?.label ?? type;

type Scope = { scope: AutonomyScope; scopeId: string };
type SetInput = {
  scope: AutonomyScope; scopeId: string; key: string; label: string; description?: string | null; type: FieldType;
  options?: Array<{ value: string; label: string }> | null; appliesTo: { kinds: WorkKindName[]; types?: string[] | null };
  required: boolean; defaultValue?: unknown; searchable: boolean; reason: string;
};

interface Draft {
  key: string;
  label: string;
  description: string;
  type: FieldType;
  options: string;
  kinds: WorkKindName[];
  anyType: boolean;
  types: string[];
  required: boolean;
  defaultValue: string;
  searchable: boolean;
}

const EMPTY_DRAFT: Draft = { key: '', label: '', description: '', type: 'TEXT', options: '', kinds: ['ISSUE'], anyType: true, types: [], required: false, defaultValue: '', searchable: false };

function draftFrom(row: FieldDefinitionRow): Draft {
  const anyType = row.appliesTo.types.includes('any');
  return {
    key: row.key,
    label: row.label,
    description: row.description ?? '',
    type: row.type,
    options: row.options.map((option) => (option.label && option.label !== option.value ? `${option.value} | ${option.label}` : option.value)).join('\n'),
    kinds: row.appliesTo.kinds,
    anyType,
    types: anyType ? [] : row.appliesTo.types,
    required: row.required,
    defaultValue: row.defaultValue === null || row.defaultValue === undefined ? '' : Array.isArray(row.defaultValue) ? row.defaultValue.join(', ') : String(row.defaultValue),
    searchable: row.searchable,
  };
}

/** `value | Label` per line; the label defaults to the value. */
export function parseOptions(text: string): Array<{ value: string; label: string }> {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [value, ...label] = line.split('|');
    const trimmed = value!.trim();
    return { value: trimmed, label: label.join('|').trim() || trimmed };
  });
}

function parseDefault(type: FieldType, text: string): unknown {
  const value = text.trim();
  if (!value) return null;
  if (type === 'NUMBER') return Number(value);
  if (type === 'BOOLEAN') return value === 'true';
  if (type === 'MULTI_ENUM') return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return value;
}

function indexStatus(row: FieldDefinitionRow): string {
  if (row.indexJob === 'BACKFILL') return `Indexing… ${row.indexProcessed} items so far`;
  if (row.indexJob === 'CLEANUP') return `Removing index… ${row.indexProcessed} items so far`;
  return row.searchable ? 'Searchable' : '—';
}

export function AdminFieldsTab() {
  return (
    <FieldsManager
      scope="WORKSPACE"
      scopeId={WORKSPACE_SETTINGS_SCOPE_ID}
      title="Fields"
      intro="Fields every team's work can carry. Prefer a team field: a workspace field shows up everywhere it applies. Each scope holds at most the limit below; raising it is a decision, not a setting."
    />
  );
}

export function TeamFieldsSection({ teamId, teamKey }: { teamId: string; teamKey: string }) {
  const projects = useQuery<{ issues: { nodes: Array<{ id: string; identifier: string; title: string; commitmentStatus: string }> } }, { teamKey: string }>(FIELD_PROJECTS_QUERY, { variables: { teamKey } });
  const [target, setTarget] = useState<string>('team');
  const committed = (projects.data?.issues.nodes ?? []).filter((project) => project.commitmentStatus === 'COMMITTED');
  const scope: Scope = target === 'team' ? { scope: 'TEAM', scopeId: teamId } : { scope: 'PROJECT', scopeId: target };
  return (
    <div>
      <Field label="Fields of" hint="The team's own fields apply to all its work; a project's fields apply under that project and win on a key clash." layout="aside">
        <Select aria-label="Fields of" value={target} onChange={(event) => setTarget(event.target.value)}>
          <option value="team">This team</option>
          {committed.map((project) => <option key={project.id} value={project.id}>{project.identifier} {project.title}</option>)}
        </Select>
      </Field>
      <FieldsManager
        key={`${scope.scope}:${scope.scopeId}`}
        scope={scope.scope}
        scopeId={scope.scopeId}
        title="Fields"
        intro="Fields this team's work carries, per Kind and Type. Agents read them with work_catalog(kind: fields) and write values; only owners define them."
      />
    </div>
  );
}

export function FieldsManager({ scope, scopeId, title, intro }: Scope & { title: string; intro: string }) {
  const { data, loading, error, refetch } = useQuery<FieldSettingsData, Scope>(FIELD_SETTINGS_QUERY, { variables: { scope, scopeId }, pollInterval: 0 });
  const [runSet] = useMutation<{ fieldDefinitionSet: Refusable<object> }, { input: SetInput }>(FIELD_DEFINITION_SET_MUTATION);
  const [runDeactivate] = useMutation<{ fieldDefinitionDeactivate: Refusable<object> }, { input: Scope & { key: string; reason: string } }>(FIELD_DEFINITION_DEACTIVATE_MUTATION);
  const [runRename] = useMutation<{ fieldDefinitionRename: Refusable<object> }, { input: Scope & { from: string; to: string; reason: string } }>(FIELD_DEFINITION_RENAME_MUTATION);
  const [notice, setNotice] = useState<Notice>(null);
  const [reason, setReason] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);

  if (error) return <p role="alert">Could not load fields: {error.message}</p>;
  if (loading || !data) return <p role="status">Loading…</p>;

  const limits = data.fieldLimits;
  const rows = data.fieldDefinitions;
  const active = rows.filter((row) => row.active);
  const retired = rows.filter((row) => !row.active);
  const stale = active.filter((row) => row.stale);
  const editingRow = editing ? rows.find((row) => row.key === editing) ?? null : null;
  const done = (ok: boolean) => { if (ok) { setReason(''); setDraft(null); setEditing(null); setRenaming(null); void refetch(); } };

  function save() {
    if (!draft) return;
    const options = draft.type === 'ENUM' || draft.type === 'MULTI_ENUM' ? parseOptions(draft.options) : null;
    const input: SetInput = {
      scope, scopeId,
      key: draft.key.trim(),
      label: draft.label.trim(),
      description: draft.description.trim() || null,
      type: draft.type,
      options,
      appliesTo: { kinds: draft.kinds, types: draft.anyType ? null : draft.types },
      required: draft.required,
      defaultValue: parseDefault(draft.type, draft.defaultValue),
      searchable: draft.searchable,
      reason,
    };
    void attempt(() => runSet({ variables: { input } }), (d) => d.fieldDefinitionSet, `Field ${input.key} saved.`, setNotice).then(done);
  }

  function deactivate(key: string) {
    void attempt(() => runDeactivate({ variables: { input: { scope, scopeId, key, reason } } }), (d) => d.fieldDefinitionDeactivate, `Field ${key} retired; its values stay on the items.`, setNotice).then(done);
  }

  function rename() {
    if (!renaming) return;
    void attempt(() => runRename({ variables: { input: { scope, scopeId, from: renaming.from, to: renaming.to.trim(), reason } } }), (d) => d.fieldDefinitionRename, `Renamed ${renaming.from} to ${renaming.to.trim()}; values moved.`, setNotice).then(done);
  }

  const atLimit = active.length >= limits.activePerScope;

  return (
    <section aria-label={title}>
      <SettingsSectionHeader title={title}>{intro}</SettingsSectionHeader>
      <NoticeLine notice={notice} />
      <p className="field__hint" role="status" aria-label="Field quota">
        {active.length} of {limits.activePerScope} active fields used; lists hold up to {limits.enumOptions} options.
      </p>
      <Field label="Reason" hint="Required for every change; kept in the change history." layout="aside">
        <TextInput aria-label="Reason for the field change" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why this change" />
      </Field>

      {rows.length ? (
        <table className="fields-table" aria-label="Field definitions">
          <thead>
            <tr><th>Field</th><th>Type</th><th>Applies to</th><th>Items</th><th>Last written</th><th>Index</th><th aria-label="Actions" /></tr>
          </thead>
          <tbody>
            {[...active, ...retired].map((row) => (
              <tr key={row.key} className={row.active ? undefined : 'fields-table__retired'}>
                <td>
                  <strong>{row.label}</strong>{row.required ? <Badge tone="accent">Required</Badge> : null}{!row.active ? <Badge>Retired</Badge> : null}{row.stale ? <Badge tone="warn">Unused 90 days</Badge> : null}
                  <div className="fields-table__key">{row.key}{row.previousKey ? ` (was ${row.previousKey})` : ''}</div>
                </td>
                <td>{typeLabel(row.type)}{row.options.length ? ` · ${row.options.length} options` : ''}</td>
                <td>{row.appliesTo.kinds.join(', ')} · {row.appliesTo.types.includes('any') ? 'any Type' : row.appliesTo.types.join(', ')}</td>
                <td>{row.usageCount}</td>
                <td>{row.lastWrittenAt ? new Date(row.lastWrittenAt).toLocaleDateString() : 'never'}</td>
                <td>{indexStatus(row)}</td>
                <td className="fields-table__actions">
                  {row.active ? (
                    <>
                      <Btn size="sm" variant="ghost" aria-label={`Edit ${row.key}`} onClick={() => { setEditing(row.key); setDraft(draftFrom(row)); setRenaming(null); }}>Edit</Btn>
                      <Btn size="sm" variant="ghost" aria-label={`Rename ${row.key}`} onClick={() => { setRenaming({ from: row.key, to: '' }); setDraft(null); }}>Rename</Btn>
                      <Btn size="sm" variant="ghost" aria-label={`Deactivate ${row.key}`} disabled={!reason.trim()} onClick={() => deactivate(row.key)}>Deactivate</Btn>
                    </>
                  ) : (
                    <Btn size="sm" variant="ghost" aria-label={`Reactivate ${row.key}`} disabled={atLimit} onClick={() => { setEditing(row.key); setDraft(draftFrom(row)); setRenaming(null); }}>Reactivate</Btn>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="field__hint">No fields yet.</p>}

      {stale.length ? (
        <p className="field__hint" role="note" aria-label="Cleanup">
          Not written for {limits.staleDays} days: {stale.map((row) => row.label).join(', ')}. Retire what nobody uses; the values stay on the items.
        </p>
      ) : null}

      {renaming ? (
        <div className="inline-form" aria-label="Rename field">
          <span>Rename <code>{renaming.from}</code> to</span>
          <TextInput aria-label="New key" value={renaming.to} onChange={(event) => setRenaming({ ...renaming, to: event.target.value })} placeholder="new_key" />
          <Btn size="sm" variant="accent" disabled={!reason.trim() || !renaming.to.trim()} onClick={rename}>Rename key</Btn>
          <Btn size="sm" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Btn>
        </div>
      ) : null}

      {draft ? (
        <FieldForm
          draft={draft}
          editing={Boolean(editingRow)}
          usageCount={editingRow?.usageCount ?? 0}
          enumLimit={limits.enumOptions}
          onChange={setDraft}
          onCancel={() => { setDraft(null); setEditing(null); }}
          onSave={save}
          canSave={Boolean(reason.trim())}
        />
      ) : (
        <Btn size="md" disabled={atLimit} onClick={() => { setDraft(EMPTY_DRAFT); setEditing(null); setRenaming(null); }}>
          {atLimit ? `Limit of ${limits.activePerScope} reached` : 'New field'}
        </Btn>
      )}
    </section>
  );
}

function FieldForm({
  draft, editing, usageCount, enumLimit, onChange, onCancel, onSave, canSave,
}: { draft: Draft; editing: boolean; usageCount: number; enumLimit: number; onChange: (draft: Draft) => void; onCancel: () => void; onSave: () => void; canSave: boolean }) {
  const hasOptions = draft.type === 'ENUM' || draft.type === 'MULTI_ENUM';
  const optionCount = parseOptions(draft.options).length;
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  return (
    <fieldset className="settings-fieldset" aria-label="Field form">
      <legend className="field__label">{editing ? `Edit ${draft.key}` : 'New field'}</legend>
      <div className="form-stack">
        <Field label="Key" hint="snake_case; how agents and IQL name it. Rename it later with a reason." layout="aside">
          <TextInput aria-label="Field key" value={draft.key} disabled={editing} onChange={(event) => set({ key: event.target.value })} placeholder="customer_tier" />
        </Field>
        <Field label="Label" layout="aside">
          <TextInput aria-label="Field label" value={draft.label} onChange={(event) => set({ label: event.target.value })} />
        </Field>
        <Field label="Description" layout="aside">
          <TextInput aria-label="Field description" value={draft.description} onChange={(event) => set({ description: event.target.value })} />
        </Field>
        <Field label="Type" hint={editing ? 'A type cannot change: stored values would no longer fit.' : undefined} layout="aside">
          <Select aria-label="Field type" value={draft.type} disabled={editing} onChange={(event) => set({ type: event.target.value as FieldType })}>
            {TYPES.map((entry) => <option key={entry.type} value={entry.type}>{entry.label}</option>)}
          </Select>
        </Field>
        {hasOptions ? (
          <Field label="Options" hint={`One per line, "value | Label". ${optionCount} of ${enumLimit} used.`}>
            <TextArea aria-label="Field options" rows={4} value={draft.options} onChange={(event) => set({ options: event.target.value })} />
          </Field>
        ) : null}
        <fieldset className="settings-fieldset">
          <legend className="field__label">Applies to</legend>
          <div className="checkbox-group">
            {KINDS.map((kind) => (
              <Checkbox key={kind} label={kind} aria-label={`Kind ${kind}`} checked={draft.kinds.includes(kind)}
                onChange={(event) => set({ kinds: event.target.checked ? [...draft.kinds, kind] : draft.kinds.filter((entry) => entry !== kind) })} />
            ))}
          </div>
          <div className="checkbox-group">
            <Checkbox label="Any Type" aria-label="Any Type" checked={draft.anyType} onChange={(event) => set({ anyType: event.target.checked })} />
            {!draft.anyType ? ITEM_TYPES.map((type) => (
              <Checkbox key={type} label={type} aria-label={`Type ${type}`} checked={draft.types.includes(type)}
                onChange={(event) => set({ types: event.target.checked ? [...draft.types, type] : draft.types.filter((entry) => entry !== type) })} />
            )) : null}
          </div>
        </fieldset>
        <Checkbox label="Required: committing refuses work without it" aria-label="Required" checked={draft.required} onChange={(event) => set({ required: event.target.checked })} />
        <Field label="Default" hint="Fills a required field nobody set. Lists: option values, comma-separated." layout="aside">
          <TextInput aria-label="Field default" value={draft.defaultValue} onChange={(event) => set({ defaultValue: event.target.value })} />
        </Field>
        <Checkbox
          label={`Searchable: indexed for ranges, sorting and grouping${editing ? ` (${usageCount} items carry a value; existing values are indexed in the background)` : ''}`}
          aria-label="Searchable"
          checked={draft.searchable}
          onChange={(event) => set({ searchable: event.target.checked })}
        />
        <div className="inline-form">
          <Btn variant="accent" size="md" disabled={!canSave} onClick={onSave}>Save field</Btn>
          <Btn variant="ghost" size="md" onClick={onCancel}>Cancel</Btn>
        </div>
      </div>
    </fieldset>
  );
}

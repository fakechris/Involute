import { useEffect, useRef, useState } from 'react';

export type ContractFieldKey = 'outcome' | 'scope' | 'constraints' | 'acceptance' | 'verification';

export type ContractValues = Partial<Record<ContractFieldKey, string | null>>;

export const CONTRACT_FIELDS: Array<{ key: ContractFieldKey; label: string; hint: string }> = [
  { key: 'outcome', label: 'Outcome', hint: 'What is true when this is done' },
  { key: 'scope', label: 'Scope', hint: 'What is in and out' },
  { key: 'constraints', label: 'Constraints', hint: 'Rules the work must respect' },
  { key: 'acceptance', label: 'Acceptance', hint: 'How a reviewer decides it is done' },
  { key: 'verification', label: 'Verification', hint: 'Commands or checks that prove it' },
];

/** Only the fields that changed; a blank field is sent as null. */
export function changedContractFields(current: ContractValues, draft: Record<ContractFieldKey, string>): ContractValues {
  const changes: ContractValues = {};
  for (const { key } of CONTRACT_FIELDS) {
    const next = draft[key].trim();
    if (next !== (current[key] ?? '').trim()) {
      changes[key] = next === '' ? null : next;
    }
  }
  return changes;
}

function draftFrom(values: ContractValues): Record<ContractFieldKey, string> {
  return {
    outcome: values.outcome ?? '',
    scope: values.scope ?? '',
    constraints: values.constraints ?? '',
    acceptance: values.acceptance ?? '',
    verification: values.verification ?? '',
  };
}

/**
 * The work contract (INV-786). Committed contracts are human-owned: agents are
 * refused, so this is where a human rewrites them.
 */
export function ContractSection({
  values,
  committed,
  saving,
  onSave,
}: {
  values: ContractValues;
  committed: boolean;
  saving: boolean;
  onSave: (changes: ContractValues) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => draftFrom(values));
  const [error, setError] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);

  // Links to "/issue/:id#contract" (Work context, the board drawer) land here.
  useEffect(() => {
    if (window.location.hash === '#contract') sectionRef.current?.scrollIntoView?.({ block: 'start' });
  }, []);

  useEffect(() => {
    if (!editing) setDraft(draftFrom(values));
  }, [editing, values.outcome, values.scope, values.constraints, values.acceptance, values.verification]);

  async function save() {
    const changes = changedContractFields(values, draft);
    if (Object.keys(changes).length === 0) {
      setEditing(false);
      return;
    }
    if (committed && 'acceptance' in changes && !changes.acceptance) {
      setError('Committed work needs acceptance criteria.');
      return;
    }
    setError(null);
    try {
      await onSave(changes);
      setEditing(false);
    } catch {
      // The caller reports why the save was refused.
    }
  }

  return (
    <section ref={sectionRef} className="issue-panel__section contract-section" id="contract" aria-label="Contract">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Contract</h2>
        <div style={{ flex: 1 }} />
        {editing ? null : (
          <button type="button" className="ui-action ui-action--subtle" onClick={() => setEditing(true)}>
            Edit contract
          </button>
        )}
      </div>
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {committed ? (
            <p className="issue-panel__inline-hint" style={{ margin: 0 }}>
              Agents can't change a committed contract; your edit is recorded in the audit trail. Runs started earlier were
              checked against the old contract.
            </p>
          ) : null}
          {CONTRACT_FIELDS.map(({ key, label, hint }) => (
            <label key={key} className="observation-field">
              <span>
                {label}
                {committed && key === 'acceptance' ? ' *' : ''}
              </span>
              <textarea
                aria-label={`Contract ${label}`}
                placeholder={hint}
                value={draft[key]}
                rows={key === 'acceptance' || key === 'scope' ? 3 : 2}
                disabled={saving}
                onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
              />
            </label>
          ))}
          {error ? (
            <p role="alert" className="issue-panel__inline-hint" style={{ margin: 0, color: 'var(--danger, #d14343)' }}>
              {error}
            </p>
          ) : null}
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="ui-action ui-action--primary" disabled={saving} onClick={() => void save()}>
              Save contract
            </button>
            <button
              type="button"
              className="ui-action ui-action--subtle"
              disabled={saving}
              onClick={() => {
                setDraft(draftFrom(values));
                setError(null);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <dl className="observation-contract observation-contract--stack" style={{ marginTop: 8 }}>
          {CONTRACT_FIELDS.map(({ key, label }) => (
            <div key={key} className="observation-contract__item">
              <dt>{label}</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{values[key]?.trim() ? values[key] : '—'}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

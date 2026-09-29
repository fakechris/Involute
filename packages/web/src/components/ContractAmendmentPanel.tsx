import { useMutation } from '@apollo/client/react';
import { useState } from 'react';

import { CONTRACT_AMENDMENT_ACCEPT_MUTATION, CONTRACT_AMENDMENT_REJECT_MUTATION } from '../board/queries';
import type { ContractAmendmentSummary } from '../board/types';

type AmendedField = ContractAmendmentSummary['changes'][number]['field'];

const FIELD_LABELS: Record<AmendedField, string> = {
  acceptance: 'Acceptance',
  constraints: 'Constraints',
  outcome: 'Outcome',
  scope: 'Scope',
  verification: 'Verification',
};

function labelOf(field: AmendedField): string {
  return FIELD_LABELS[field] ?? field;
}

type Decision = { success: boolean; message?: string | null };

/**
 * Accept / reject for an agent's proposed contract change (INV-869). Each
 * returns why the server refused, or null after it succeeded and `refresh` ran.
 */
export function useContractAmendmentDecisions(refresh: () => Promise<unknown>) {
  const [runAccept] = useMutation<{ contractAmendmentAccept: Decision }, { input: { amendmentId: string; note?: string | null } }>(
    CONTRACT_AMENDMENT_ACCEPT_MUTATION,
  );
  const [runReject] = useMutation<{ contractAmendmentReject: Decision }, { input: { amendmentId: string; note: string } }>(
    CONTRACT_AMENDMENT_REJECT_MUTATION,
  );

  async function decide(run: () => Promise<Decision | undefined>): Promise<string | null> {
    try {
      const result = await run();
      if (!result?.success) return result?.message ?? 'Could not save the decision.';
      await refresh();
      return null;
    } catch {
      return 'Could not save the decision.';
    }
  }

  return {
    accept: (amendmentId: string) =>
      decide(async () => (await runAccept({ variables: { input: { amendmentId } } })).data?.contractAmendmentAccept),
    reject: (amendmentId: string, note: string) =>
      decide(async () => (await runReject({ variables: { input: { amendmentId, note } } })).data?.contractAmendmentReject),
  };
}


/**
 * An agent's proposed change to the committed contract (INV-869): what each
 * field says now and would say, why, and two buttons. Accepting applies it as
 * the person's own edit; rejecting needs a note the agent will read.
 */
export function ContractAmendmentPanel({
  amendment,
  onAccept,
  onReject,
}: {
  amendment: ContractAmendmentSummary;
  onAccept: (id: string) => Promise<string | null>;
  onReject: (id: string, note: string) => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const proposer = amendment.proposedBy.name ?? amendment.proposedBy.email ?? 'An agent';

  async function decide(run: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    const refused = await run();
    setBusy(false);
    if (refused) setError(refused);
  }

  return (
    <div role="region" aria-label="Proposed contract change" className="contract-amendment" style={{ marginTop: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 'var(--r-2)', background: 'var(--bg-hover)' }}>
      <p style={{ margin: 0, fontWeight: 600 }}>{proposer} proposes a change to this contract</p>
      {amendment.proposedByClaimant ? (
        <p className="issue-panel__inline-hint" style={{ margin: '4px 0 0' }}>
          {proposer} holds the claim on this work, so this changes the terms its own work will be judged by.
        </p>
      ) : null}
      <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>
        <span style={{ color: 'var(--fg-muted)' }}>Reason: </span>
        {amendment.reason}
      </p>
      <dl className="observation-contract observation-contract--stack" style={{ margin: '8px 0 0' }}>
        {amendment.changes.map((change) => (
          <div key={change.field} className="observation-contract__item">
            <dt>{labelOf(change.field)}</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>
              <del aria-label={`${labelOf(change.field)} now`}>{change.before ?? '—'}</del>
              <br />
              <ins aria-label={`${labelOf(change.field)} proposed`}>{change.after ?? '— (cleared)'}</ins>
            </dd>
          </div>
        ))}
      </dl>
      {amendment.stale ? (
        <p role="status" className="issue-panel__inline-hint" style={{ margin: '6px 0 0' }}>
          The contract changed since this was proposed. Compare it with the contract below, then edit the contract
          yourself or reject this change.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="issue-panel__inline-hint" style={{ margin: '6px 0 0', color: 'var(--danger, #d14343)' }}>
          {error}
        </p>
      ) : null}
      {rejecting ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          <label className="observation-field">
            <span>Why not (the agent reads this)</span>
            <textarea aria-label="Rejection note" rows={2} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} />
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="ui-action ui-action--primary"
              disabled={busy || !note.trim()}
              onClick={() => void decide(() => onReject(amendment.id, note.trim()))}
            >
              Reject change
            </button>
            <button type="button" className="ui-action ui-action--subtle" disabled={busy} onClick={() => setRejecting(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button
            type="button"
            className="ui-action ui-action--primary"
            disabled={busy || amendment.stale}
            onClick={() => void decide(() => onAccept(amendment.id))}
          >
            Accept change
          </button>
          <button type="button" className="ui-action ui-action--subtle" disabled={busy} onClick={() => setRejecting(true)}>
            Reject…
          </button>
        </div>
      )}
    </div>
  );
}

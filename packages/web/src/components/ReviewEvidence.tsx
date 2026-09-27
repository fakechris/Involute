import { useState } from 'react';
import { useMutation } from '@apollo/client/react';

import { EVIDENCE_RETRACT_MUTATION } from '../work/queries';
import type { WorkEvidenceSummary, WorkRunSummary } from '../work/types';

/**
 * What a reviewer needs before accepting (INV-790): what each run was bound to
 * — commit, pull request, and whether the contract changed since — and what
 * the server observed about each piece of evidence.
 */
export function RunBinding({ run, contractDigest }: { run: WorkRunSummary; contractDigest?: string | null }) {
  const prUrl = run.repository && run.pullRequestNumber ? `https://github.com/${run.repository}/pull/${run.pullRequestNumber}` : null;
  const stale = Boolean(run.contractRevision && contractDigest && run.contractRevision !== contractDigest);
  return (
    <span className="review-binding">
      {run.commitSha ? (
        <span className="mono" title={run.commitSha}>
          commit {run.commitSha.slice(0, 7)}
        </span>
      ) : (
        <span className="observation-card__meta">no commit bound</span>
      )}
      {prUrl ? (
        <a href={prUrl} target="_blank" rel="noreferrer">
          PR #{run.pullRequestNumber}
        </a>
      ) : null}
      {run.contractRevision ? (
        stale ? (
          <span className="review-binding__stale" title="The scope, constraints, repository or acceptance changed after this run started.">
            contract changed since this run
          </span>
        ) : (
          <span className="observation-card__meta">current contract</span>
        )
      ) : null}
    </span>
  );
}

const STATUS_CLASS: Record<string, string> = {
  VERIFIED: 'review-verification--ok',
  FAILED: 'review-verification--bad',
  STALE: 'review-verification--warn',
};

export function EvidenceVerificationStatus({ evidence }: { evidence: WorkEvidenceSummary }) {
  // The server lists verifications newest first.
  const latest = (evidence.verifications ?? [])[0];
  if (!latest) return <span className="observation-card__meta">not verified</span>;
  return (
    <span
      className={`review-verification ${STATUS_CLASS[latest.status] ?? ''}`}
      title={`Checked ${new Date(latest.observedAt).toLocaleString()}${latest.failureCode ? ` — ${latest.failureCode}` : ''}`}
    >
      {latest.status.toLowerCase()}
      {latest.failureCode ? ` · ${latest.failureCode}` : ''} · checked {new Date(latest.observedAt).toLocaleString()}
    </span>
  );
}

/** A person marks evidence as wrongly attached, with a reason (evidenceRetract, INV-598). */
export function RetractEvidence({ evidence, onRetracted }: { evidence: WorkEvidenceSummary; onRetracted: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [runRetract, state] = useMutation<
    { evidenceRetract: { success: boolean; message?: string | null } },
    { input: { evidenceId: string; reason: string } }
  >(EVIDENCE_RETRACT_MUTATION);

  if (evidence.retractedAt) return null;
  if (!open) {
    return (
      <button type="button" className="ui-action" aria-label={`Retract evidence ${evidence.url}`} onClick={() => setOpen(true)}>
        Retract
      </button>
    );
  }

  async function submit() {
    setError(null);
    try {
      const result = await runRetract({ variables: { input: { evidenceId: evidence.id, reason: reason.trim() } } });
      if (!result.data?.evidenceRetract.success) {
        setError(result.data?.evidenceRetract.message ?? 'Could not retract this evidence.');
        return;
      }
    } catch {
      setError('Could not retract this evidence.');
      return;
    }
    setOpen(false);
    onRetracted();
  }

  return (
    <span className="review-retract">
      <input
        aria-label={`Why retract ${evidence.url}`}
        placeholder="Why is this evidence wrong?"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <button type="button" className="ui-action ui-action--accent" disabled={!reason.trim() || state?.loading} onClick={() => void submit()}>
        Confirm retract
      </button>
      <button type="button" className="ui-action" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error ? (
        <span role="alert" className="issue-relations__error">
          {error}
        </span>
      ) : null}
    </span>
  );
}

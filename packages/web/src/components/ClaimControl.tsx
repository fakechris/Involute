import { useState } from 'react';
import { useMutation } from '@apollo/client/react';

import { WORK_CLAIM_RELEASE_MUTATION } from '../board/queries';

export interface ClaimSummary {
  leaseUntil: string;
  executionId?: string | null;
  actor: { id: string; name?: string | null; email?: string | null };
}

/**
 * Who holds the work and until when, and — for a person — "Release claim"
 * with a reason (INV-789), so stuck work can be taken back before the lease
 * runs out. The holder and its owner are told; open runs are closed.
 */
export function ClaimControl({ workId, claim }: { workId: string; claim: ClaimSummary | null | undefined }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [runRelease, state] = useMutation<
    { workClaimRelease: { success: boolean; message?: string | null } },
    { workId: string; reason: string }
  >(WORK_CLAIM_RELEASE_MUTATION, { refetchQueries: ['BoardPage', 'IssuePage', 'WorkContextPage'] });

  if (!claim) return <span className="observation-empty">Unclaimed</span>;
  const holder = claim.actor.name ?? claim.actor.email ?? 'someone';

  async function release() {
    setError(null);
    try {
      const result = await runRelease({ variables: { workId, reason: reason.trim() } });
      if (!result.data?.workClaimRelease.success) {
        setError(result.data?.workClaimRelease.message ?? 'Could not release the claim.');
        return;
      }
      setOpen(false);
      setReason('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not release the claim.');
    }
  }

  return (
    <span className="claim-control">
      <span>
        Claimed by <strong>{holder}</strong> until {new Date(claim.leaseUntil).toLocaleString()}
      </span>
      {claim.executionId ? <span> · execution {claim.executionId}</span> : null}
      {open ? (
        <span className="review-retract">
          <input
            aria-label="Why release this claim"
            placeholder="Why take it back? The agent and its owner see this."
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button type="button" className="ui-action ui-action--accent" disabled={!reason.trim() || state?.loading} onClick={() => void release()}>
            Release
          </button>
          <button type="button" className="ui-action" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button type="button" className="ui-action" onClick={() => setOpen(true)}>
          Release claim
        </button>
      )}
      {error ? (
        <span role="alert" className="issue-relations__error">
          {error}
        </span>
      ) : null}
    </span>
  );
}

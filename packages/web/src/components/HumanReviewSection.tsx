import { useMutation } from '@apollo/client/react';
import { useState } from 'react';

import { Btn } from './Primitives';
import { WORK_REVIEW_MUTATION } from '../work/queries';
import type { WorkReviewMutationData, WorkReviewMutationVariables } from '../work/types';

/**
 * The human gate on finished work: accept it or send it back, with an
 * optional note. Shared by the work page and the Needs you queue (INV-1092),
 * so both make the same decision the same way.
 */
export function HumanReviewSection({
  work,
  onReviewed,
}: {
  work: { id: string; revision: number };
  onReviewed: () => unknown;
}) {
  const [reviewReason, setReviewReason] = useState('');
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewPending, setReviewPending] = useState<'ACCEPTED' | 'REJECTED' | null>(null);
  const [runReview] = useMutation<WorkReviewMutationData, WorkReviewMutationVariables>(WORK_REVIEW_MUTATION);

  async function handleReview(decision: 'ACCEPTED' | 'REJECTED') {
    setReviewError(null);
    setReviewPending(decision);
    try {
      const result = await runReview({
        variables: {
          id: work.id,
          input: {
            decision,
            expectedRevision: work.revision,
            ...(reviewReason.trim() ? { reason: reviewReason.trim() } : {}),
          },
        },
      });
      if (!result.data?.workReview.success || !result.data.workReview.issue) {
        setReviewError(result.data?.workReview.message ?? 'The review decision was not accepted. Refresh and check the current revision.');
        return;
      }
      setReviewReason('');
      await onReviewed();
    } catch {
      setReviewError('The review request failed. The work state was not assumed to have changed.');
    } finally {
      setReviewPending(null);
    }
  }

  return (
    <section className="work-context__section" aria-label="Human review">
      <h2>Human review</h2>
      <p>Only an explicit human decision can move this work out of review.</p>
      <label className="observation-field">
        <span>Reason</span>
        <input
          aria-label="Review reason"
          value={reviewReason}
          onChange={(event) => setReviewReason(event.target.value)}
          placeholder="Optional decision note"
        />
      </label>
      {reviewError ? <p className="observation-error" role="alert">{reviewError}</p> : null}
      <div className="observation-card__actions">
        <Btn variant="accent" disabled={reviewPending !== null} onClick={() => void handleReview('ACCEPTED')}>
          {reviewPending === 'ACCEPTED' ? 'Accepting…' : 'Accept'}
        </Btn>
        <Btn variant="danger" disabled={reviewPending !== null} onClick={() => void handleReview('REJECTED')}>
          {reviewPending === 'REJECTED' ? 'Rejecting…' : 'Reject'}
        </Btn>
      </div>
    </section>
  );
}

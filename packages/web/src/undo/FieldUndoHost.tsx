import { useMutation } from '@apollo/client/react';
import { useEffect, useRef } from 'react';

import { ISSUE_UPDATE_MUTATION } from '../board/queries';
import type { IssueSummary, IssueUpdateMutationData, IssueUpdateMutationVariables } from '../board/types';
import { registerFieldUndoApply, type FieldUndoApply } from './status-undo';

/** Pages listen for this to refresh the issues an undo/redo just rewrote. */
export const ISSUE_UNDO_APPLIED_EVENT = 'involute:issue-undo-applied';
export interface IssueUndoAppliedDetail {
  /** Issues now at the version the server returned (edited back, or restored). */
  issues: IssueSummary[];
  issueIds: string[];
  /** Issues an undo/redo deleted again (INV-840). */
  deletedIds?: string[];
}

/**
 * Reverses or repeats one field gesture from any page (INV-839): the same
 * issueUpdate the gesture used, with the revision it left behind, so a
 * concurrent edit shows up as a named conflict instead of a silent overwrite.
 */
export function FieldUndoHost() {
  const [runIssueUpdate] = useMutation<IssueUpdateMutationData, IssueUpdateMutationVariables>(ISSUE_UPDATE_MUTATION);
  const applyRef = useRef<FieldUndoApply>(async () => ({ applied: [], conflicts: [] }));
  applyRef.current = async (changes) => {
    const applied: Array<{ issueId: string; revision: number }> = [];
    const conflicts: string[] = [];
    const issues: IssueSummary[] = [];
    await Promise.all(changes.map(async (change) => {
      try {
        const result = await runIssueUpdate({ variables: { id: change.issueId, input: { ...change.patch, expectedRevision: change.expectedRevision } } });
        const issue = result.data?.issueUpdate.issue ?? null;
        if (!result.data?.issueUpdate.success || !issue) {
          conflicts.push(change.identifier);
          return;
        }
        applied.push({ issueId: issue.id, revision: issue.revision });
        issues.push(issue);
      } catch {
        conflicts.push(change.identifier);
      }
    }));
    window.dispatchEvent(new CustomEvent<IssueUndoAppliedDetail>(ISSUE_UNDO_APPLIED_EVENT, { detail: { issues, issueIds: changes.map((change) => change.issueId) } }));
    return { applied, conflicts };
  };
  useEffect(() => registerFieldUndoApply((changes) => applyRef.current(changes)), []);
  return null;
}

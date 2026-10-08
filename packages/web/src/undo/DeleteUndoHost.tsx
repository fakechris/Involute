import { useMutation } from '@apollo/client/react';
import { useEffect, useRef } from 'react';

import { ISSUE_DELETE_MUTATION, ISSUE_UNDELETE_MUTATION } from '../board/queries';
import type {
  IssueDeleteMutationData,
  IssueDeleteMutationVariables,
  IssueSummary,
  IssueUndeleteMutationData,
  IssueUndeleteMutationVariables,
} from '../board/types';
import { ISSUE_UNDO_APPLIED_EVENT, type IssueUndoAppliedDetail } from './FieldUndoHost';
import { registerDeleteUndoApply, type DeleteUndoApply } from './status-undo';

/**
 * Undo a deletion from any page (INV-840): issueUndelete puts the item back
 * under its original id; redo deletes it again. Pages hear the result on the
 * same event field edits use, with the restored issue or the deleted ids.
 */
export function DeleteUndoHost() {
  const [runUndelete] = useMutation<IssueUndeleteMutationData, IssueUndeleteMutationVariables>(ISSUE_UNDELETE_MUTATION);
  const [runDelete] = useMutation<IssueDeleteMutationData, IssueDeleteMutationVariables>(ISSUE_DELETE_MUTATION);
  const applyRef = useRef<DeleteUndoApply>(async () => ({ applied: [], conflicts: [] }));
  applyRef.current = async (items) => {
    const applied: string[] = [];
    const conflicts: string[] = [];
    const issues: IssueSummary[] = [];
    const deletedIds: string[] = [];
    for (const item of items) {
      try {
        if (item.phase === 'deleted') {
          const result = await runUndelete({ variables: { id: item.issueId } });
          const issue = result.data?.issueUndelete.issue ?? null;
          if (!result.data?.issueUndelete.success || !issue) {
            conflicts.push(item.identifier);
            continue;
          }
          issues.push(issue);
        } else {
          const result = await runDelete({ variables: { id: item.issueId } });
          if (!result.data?.issueDelete.success) {
            conflicts.push(item.identifier);
            continue;
          }
          deletedIds.push(item.issueId);
        }
        applied.push(item.issueId);
      } catch {
        conflicts.push(item.identifier);
      }
    }
    window.dispatchEvent(new CustomEvent<IssueUndoAppliedDetail>(ISSUE_UNDO_APPLIED_EVENT, {
      detail: { issues, issueIds: items.map((item) => item.issueId), deletedIds },
    }));
    return { applied, conflicts };
  };
  useEffect(() => registerDeleteUndoApply((items) => applyRef.current(items)), []);
  return null;
}

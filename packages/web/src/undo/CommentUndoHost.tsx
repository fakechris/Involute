import { useMutation } from '@apollo/client/react';
import { useEffect, useRef } from 'react';

import { COMMENT_CREATE_MUTATION, COMMENT_DELETE_MUTATION } from '../board/queries';
import type {
  CommentCreateMutationData,
  CommentCreateMutationVariables,
  CommentDeleteMutationData,
  CommentDeleteMutationVariables,
  CommentSummary,
} from '../board/types';
import { registerCommentUndoApply, type CommentUndoApply } from './status-undo';

/** Pages listen for this to add a re-posted comment or drop a deleted one from the issue they show. */
export const COMMENTS_CHANGED_EVENT = 'involute:comments-changed';
export interface CommentsChangedDetail {
  issueId: string;
  posted?: CommentSummary;
  deletedCommentId?: string;
}

/**
 * Undo a comment deletion from any page (INV-843). The row is gone, so undo
 * posts the same text again — a new comment with a new id — and redo deletes
 * that one.
 */
export function CommentUndoHost() {
  const [runCreate] = useMutation<CommentCreateMutationData, CommentCreateMutationVariables>(COMMENT_CREATE_MUTATION);
  const [runDelete] = useMutation<CommentDeleteMutationData, CommentDeleteMutationVariables>(COMMENT_DELETE_MUTATION);
  const applyRef = useRef<CommentUndoApply>(async () => ({ applied: [], conflicts: [] }));
  applyRef.current = async (items) => {
    const applied: Array<{ index: number; commentId: string | null }> = [];
    const conflicts: string[] = [];
    const retryable: number[] = [];
    for (const [index, item] of items.entries()) {
      try {
        if (item.phase === 'deleted') {
          const result = await runCreate({
            variables: { input: { issueId: item.issueId, body: item.body, ...(item.parentCommentId ? { parentCommentId: item.parentCommentId } : {}) } },
          });
          const comment = result.data?.commentCreate.comment ?? null;
          if (!result.data?.commentCreate.success || !comment) {
            conflicts.push(`comment on ${item.issueIdentifier}`);
            continue;
          }
          applied.push({ index, commentId: comment.id });
          window.dispatchEvent(new CustomEvent<CommentsChangedDetail>(COMMENTS_CHANGED_EVENT, { detail: { issueId: item.issueId, posted: comment } }));
        } else {
          if (!item.commentId) {
            conflicts.push(`comment on ${item.issueIdentifier}`);
            continue;
          }
          const result = await runDelete({ variables: { id: item.commentId } });
          if (!result.data?.commentDelete.success) {
            conflicts.push(`comment on ${item.issueIdentifier}`);
            continue;
          }
          applied.push({ index, commentId: null });
          window.dispatchEvent(new CustomEvent<CommentsChangedDetail>(COMMENTS_CHANGED_EVENT, { detail: { issueId: item.issueId, deletedCommentId: item.commentId } }));
        }
      } catch {
        retryable.push(index);
      }
    }
    return { applied, conflicts, retryable };
  };
  useEffect(() => registerCommentUndoApply((items) => applyRef.current(items)), []);
  return null;
}

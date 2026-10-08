import { useMutation } from '@apollo/client/react';
import { useEffect, useRef } from 'react';

import { WORK_LINK_DELETE_MUTATION } from '../board/queries';
import type {
  WorkLinkDeleteMutationData,
  WorkLinkDeleteMutationVariables,
  WorkLinkMutationData,
  WorkLinkMutationVariables,
} from '../board/types';
import { WORK_LINK_MUTATION } from '../work/queries';
import { registerLinkUndoApply, type LinkUndoApply } from './status-undo';

/** Relations sections listen for this to reload after an undo/redo changed their links. */
export const LINKS_CHANGED_EVENT = 'involute:links-changed';
export interface LinksChangedDetail {
  issueIds: string[];
}

/**
 * Undo a relation change from any page (INV-842): an added link is removed
 * by id; a removed link is added again with the same ends and type (it gets
 * a new id, which the redo entry then carries).
 */
export function LinkUndoHost() {
  const [runLink] = useMutation<WorkLinkMutationData, WorkLinkMutationVariables>(WORK_LINK_MUTATION, { refetchQueries: ['BoardPage'] });
  const [runUnlink] = useMutation<WorkLinkDeleteMutationData, WorkLinkDeleteMutationVariables>(WORK_LINK_DELETE_MUTATION, {
    refetchQueries: ['BoardPage'],
  });
  const applyRef = useRef<LinkUndoApply>(async () => ({ applied: [], conflicts: [] }));
  applyRef.current = async (items) => {
    const applied: Array<{ index: number; linkId: string | null }> = [];
    const conflicts: string[] = [];
    const retryable: number[] = [];
    for (const [index, item] of items.entries()) {
      try {
        if (item.phase === 'linked') {
          if (!item.linkId) {
            conflicts.push(item.summary);
            continue;
          }
          const result = await runUnlink({ variables: { id: item.linkId } });
          if (!result.data?.workLinkDelete.success) {
            conflicts.push(item.summary);
            continue;
          }
          applied.push({ index, linkId: null });
        } else {
          const result = await runLink({ variables: { fromId: item.fromId, toId: item.toId, type: item.type as WorkLinkMutationVariables['type'] } });
          const link = result.data?.workLink.link ?? null;
          if (!result.data?.workLink.success || !link) {
            conflicts.push(item.summary);
            continue;
          }
          applied.push({ index, linkId: link.id });
        }
      } catch {
        retryable.push(index);
      }
    }
    window.dispatchEvent(new CustomEvent<LinksChangedDetail>(LINKS_CHANGED_EVENT, {
      detail: { issueIds: [...new Set(items.flatMap((item) => item.issueIds))] },
    }));
    return { applied, conflicts, retryable };
  };
  useEffect(() => registerLinkUndoApply((items) => applyRef.current(items)), []);
  return null;
}

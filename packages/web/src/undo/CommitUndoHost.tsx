import { useMutation } from '@apollo/client/react';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { WORK_COMMIT_MUTATION, WORK_UNCOMMIT_MUTATION } from '../work/queries';
import type { WorkCommitMutationData, WorkCommitMutationVariables } from '../work/types';
import {
  registerCommitUndoApply,
  type CommitUndoItem,
} from './status-undo';

const SELECT_CANDIDATES = 'involute:select-candidates';

interface UncommitData {
  workUncommit: WorkCommitMutationData['workCommit'];
}

interface UncommitVariables {
  id: string;
  expectedRevision: number;
}

/** Undo commit — reverses one commit gesture from any page. */
export function CommitUndoHost() {
  const navigate = useNavigate();
  const [runUncommit] = useMutation<UncommitData, UncommitVariables>(WORK_UNCOMMIT_MUTATION);
  const [runCommit] = useMutation<WorkCommitMutationData, WorkCommitMutationVariables>(WORK_COMMIT_MUTATION);
  const applyRef = useRef<(items: CommitUndoItem[]) => Promise<{ applied: Array<{ issueId: string; revision: number }>; conflicts: string[] }>>(
    async () => ({ applied: [], conflicts: [] }),
  );

  applyRef.current = async (items) => {
    const applied: Array<{ issueId: string; revision: number }> = [];
    const conflicts: string[] = [];
    for (const item of items) {
      try {
        if (item.phase === 'committed') {
          const result = await runUncommit({
            variables: { id: item.issueId, expectedRevision: item.revision },
          });
          const issue = result.data?.workUncommit.issue;
          if (!result.data?.workUncommit.success || !issue?.revision) {
            conflicts.push(item.identifier);
            continue;
          }
          applied.push({ issueId: item.issueId, revision: issue.revision });
        } else {
          const result = await runCommit({
            variables: {
              id: item.issueId,
              input: {
                acceptance: item.acceptance,
                expectedRevision: item.revision,
                ...(item.assigneeId ? { assigneeId: item.assigneeId } : {}),
                ...(item.priority && item.priority >= 1 && item.priority <= 4 ? { priority: item.priority } : {}),
              },
            },
          });
          const issue = result.data?.workCommit.issue;
          if (!result.data?.workCommit.success || !issue?.revision) {
            conflicts.push(item.identifier);
            continue;
          }
          applied.push({ issueId: item.issueId, revision: issue.revision });
        }
      } catch {
        conflicts.push(item.identifier);
      }
    }
    if (applied.length > 0 || conflicts.length > 0) {
      window.dispatchEvent(new CustomEvent(SELECT_CANDIDATES, {
        detail: { ids: items.map((item) => item.issueId) },
      }));
      navigate('/candidates');
    }
    return { applied, conflicts };
  };

  useEffect(() => registerCommitUndoApply((items) => applyRef.current(items)), []);
  return null;
}

export function selectCandidatesEventName() {
  return SELECT_CANDIDATES;
}

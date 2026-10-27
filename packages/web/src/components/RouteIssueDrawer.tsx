import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@apollo/client/react';

import {
  COMMENT_CREATE_MUTATION,
  COMMENT_DELETE_MUTATION,
  ISSUE_DELETE_MUTATION,
  ISSUE_PAGE_QUERY,
  ISSUE_UPDATE_MUTATION,
} from '../board/queries';
import type {
  CommentCreateMutationData,
  CommentCreateMutationVariables,
  CommentDeleteMutationData,
  CommentDeleteMutationVariables,
  IssueDeleteMutationData,
  IssueDeleteMutationVariables,
  IssuePageQueryData,
  IssuePageQueryVariables,
  IssueSummary,
  IssueUpdateMutationData,
  IssueUpdateMutationVariables,
  TeamSummary,
} from '../board/types';
import { mergeIssueWithPreservedComments } from '../board/utils';
import { fieldChange } from '../undo/field-gesture';
import { recordCommentGesture, recordDeleteGesture, recordFieldGesture } from '../undo/status-undo';
import { isBugIssue, useCloseReason, type WorkResolution } from './CloseReasonDialog';
import type { ContractValues } from './ContractSection';
import { IssueDetailDrawer } from './IssueDetailDrawer';

const SAVE_ERROR = 'We could not save the issue changes. Please try again.';
const CONFLICT_ERROR = 'The issue changed while you were editing. The latest version was reloaded; review it and retry.';
const DELETE_ERROR = 'We could not delete the issue. Please try again.';
const COMMENT_DELETE_ERROR = 'We could not delete the comment. Please try again.';

class IssueUpdateRefused extends Error {
  constructor(readonly reason: string | null) {
    super(reason ?? 'Issue update refused');
  }
}

/**
 * The issue drawer for routes that do not load issues themselves (INV-1387):
 * fetches the issue by id or identifier and saves edits the way the issue
 * page does (optimistic, expected revision, one undo entry per save).
 */
export function RouteIssueDrawer({ issueRef, onClose }: { issueRef: string; onClose: () => void }) {
  const { data, refetch } = useQuery<IssuePageQueryData, IssuePageQueryVariables>(ISSUE_PAGE_QUERY, {
    variables: { id: issueRef },
  });
  const [runIssueUpdate] = useMutation<IssueUpdateMutationData, IssueUpdateMutationVariables>(ISSUE_UPDATE_MUTATION);
  const [runCommentCreate] = useMutation<CommentCreateMutationData, CommentCreateMutationVariables>(COMMENT_CREATE_MUTATION);
  const [runCommentDelete] = useMutation<CommentDeleteMutationData, CommentDeleteMutationVariables>(COMMENT_DELETE_MUTATION);
  const [runIssueDelete] = useMutation<IssueDeleteMutationData, IssueDeleteMutationVariables>(ISSUE_DELETE_MUTATION);
  const { askCloseReason, closeReasonDialog } = useCloseReason();

  const [localIssue, setLocalIssue] = useState<IssueSummary | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLocalIssue(data?.issue ?? null);
  }, [data?.issue]);

  const issue = localIssue ?? data?.issue ?? null;
  const users = data?.users.nodes ?? [];
  const labels = data?.issueLabels.nodes ?? [];

  const team = useMemo<TeamSummary | null>(() => {
    if (!issue) return null;
    return {
      id: issue.team.id,
      key: issue.team.key,
      name: issue.team.name ?? issue.team.key,
      states: issue.team.states ?? { nodes: [] },
    };
  }, [issue]);

  async function persistIssueUpdate(
    current: IssueSummary,
    input: IssueUpdateMutationVariables['input'],
    apply: (issue: IssueSummary) => IssueSummary,
  ): Promise<boolean> {
    const previous = localIssue;
    setError(null);
    setSaving(true);
    setLocalIssue(apply(current));
    try {
      const result = await runIssueUpdate({ variables: { id: current.id, input: { ...input, expectedRevision: current.revision } } });
      const saved = result.data?.issueUpdate.issue;
      if (!result.data?.issueUpdate.success || !saved) throw new IssueUpdateRefused(result.data?.issueUpdate.message ?? null);
      setLocalIssue((value) => (value ? mergeIssueWithPreservedComments(value, saved) : saved));
      const change = fieldChange(current, input, saved.revision, {
        stateName: (id) => team?.states.nodes.find((state) => state.id === id)?.name,
        userName: (id) => (id ? users.find((user) => user.id === id)?.name ?? undefined : undefined),
        labelNames: (ids) => labels.filter((label) => ids.includes(label.id)).map((label) => label.name),
      });
      if (change) recordFieldGesture([change]);
      return true;
    } catch (failure) {
      const reason = failure instanceof IssueUpdateRefused ? failure.reason : null;
      try {
        const refreshed = await refetch();
        setLocalIssue(refreshed.data?.issue ?? previous);
        setError(reason ?? CONFLICT_ERROR);
      } catch {
        setLocalIssue(previous);
        setError(reason ?? SAVE_ERROR);
      }
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function persistStateChange(current: IssueSummary, stateId: string) {
    const state = team?.states.nodes.find((item) => item.id === stateId) ?? null;
    if (!state || current.state.id === stateId) return;
    // Canceling asks why first (INV-1118), as on the issue page.
    let close: { resolution?: WorkResolution; reason?: string } = {};
    if (state.type === 'CANCELED' && current.state.type !== 'CANCELED') {
      const answer = await askCloseReason({ title: `Cancel ${current.identifier}`, needsReason: isBugIssue(current) });
      if (!answer) return;
      close = { resolution: answer.resolution, ...(answer.reason ? { reason: answer.reason } : {}) };
    }
    await persistIssueUpdate(current, { stateId, ...close }, (value) => ({ ...value, state }));
  }

  async function persistContractChange(current: IssueSummary, changes: ContractValues) {
    const saved = await persistIssueUpdate(current, changes, (value) => ({ ...value, ...changes }));
    if (!saved) throw new Error('Contract not saved');
  }

  async function persistLabelsChange(current: IssueSummary, labelIds: string[]) {
    const before = current.labels.nodes.map((label) => label.id).sort().join(',');
    if (before === [...labelIds].sort().join(',')) return;
    await persistIssueUpdate(current, { labelIds }, (value) => ({ ...value, labels: { nodes: labels.filter((label) => labelIds.includes(label.id)) } }));
  }

  async function persistAssigneeChange(current: IssueSummary, assigneeId: string | null) {
    if ((current.assignee?.id ?? null) === assigneeId) return;
    await persistIssueUpdate(current, { assigneeId }, (value) => ({
      ...value,
      assignee: assigneeId ? users.find((user) => user.id === assigneeId) ?? null : null,
    }));
  }

  async function persistCommentCreate(current: IssueSummary, body: string) {
    const trimmed = body.trim();
    if (!trimmed) return;
    setError(null);
    setSaving(true);
    try {
      const result = await runCommentCreate({ variables: { input: { issueId: current.id, body: trimmed } } });
      const comment = result.data?.commentCreate.comment;
      if (!result.data?.commentCreate.success || !comment) throw new Error('Comment mutation failed');
      setLocalIssue((value) =>
        value
          ? {
              ...value,
              comments: {
                nodes: [...value.comments.nodes, comment].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
              },
            }
          : value,
      );
    } catch (failure) {
      setError(SAVE_ERROR);
      throw failure;
    } finally {
      setSaving(false);
    }
  }

  async function persistCommentDelete(current: IssueSummary, commentId: string) {
    setError(null);
    setSaving(true);
    try {
      const result = await runCommentDelete({ variables: { id: commentId } });
      if (!result.data?.commentDelete.success || !result.data.commentDelete.commentId) throw new Error('Delete comment mutation failed');
      const deleted = current.comments.nodes.find((comment) => comment.id === commentId);
      setLocalIssue((value) => (value ? { ...value, comments: { nodes: value.comments.nodes.filter((comment) => comment.id !== commentId) } } : value));
      if (deleted) {
        recordCommentGesture([{ commentId, issueId: current.id, issueIdentifier: current.identifier, body: deleted.body, parentCommentId: null, phase: 'deleted' }]);
      }
    } catch {
      setError(COMMENT_DELETE_ERROR);
      throw new Error(COMMENT_DELETE_ERROR);
    } finally {
      setSaving(false);
    }
  }

  async function persistIssueDelete(current: IssueSummary) {
    setError(null);
    setSaving(true);
    try {
      const result = await runIssueDelete({ variables: { id: current.id } });
      if (!result.data?.issueDelete.success || !result.data.issueDelete.issueId) throw new Error('Delete issue mutation failed');
      recordDeleteGesture([{ issueId: current.id, identifier: current.identifier, phase: 'deleted' }]);
      onClose();
    } catch {
      setError(DELETE_ERROR);
      throw new Error(DELETE_ERROR);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <IssueDetailDrawer
        issue={issue}
        team={team}
        labels={labels}
        users={users}
        savingState={saving}
        errorMessage={error}
        onClose={onClose}
        onStateChange={persistStateChange}
        onTitleSave={async (current, title) => {
          if (current.title !== title) await persistIssueUpdate(current, { title }, (value) => ({ ...value, title }));
        }}
        onDescriptionSave={async (current, description) => {
          if ((current.description ?? '') !== description) await persistIssueUpdate(current, { description }, (value) => ({ ...value, description }));
        }}
        onContractSave={persistContractChange}
        onLabelsChange={persistLabelsChange}
        onAssigneeChange={persistAssigneeChange}
        onCommentCreate={persistCommentCreate}
        onCommentDelete={persistCommentDelete}
        onIssueDelete={persistIssueDelete}
      />
      {closeReasonDialog}
    </>
  );
}

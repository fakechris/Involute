import { useMutation, useQuery } from '@apollo/client/react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import {
  COMMENT_DELETE_MUTATION,
  COMMENT_CREATE_MUTATION,
  ISSUE_DELETE_MUTATION,
  ISSUE_PAGE_QUERY,
  ISSUE_UPDATE_MUTATION,
} from '../board/queries';
import type {
  CommentDeleteMutationData,
  CommentDeleteMutationVariables,
  CommentCreateMutationData,
  CommentCreateMutationVariables,
  IssueDeleteMutationData,
  IssueDeleteMutationVariables,
  IssuePageQueryData,
  IssuePageQueryVariables,
  IssueSummary,
  IssueUpdateMutationData,
  IssueUpdateMutationVariables,
} from '../board/types';
import { mergeIssueWithPreservedComments } from '../board/utils';
import { getBoardBootstrapErrorMessage } from '../lib/apollo';
import { writeStoredShellIssue } from '../lib/app-shell-state';
import { IssueDetailDrawer } from '../components/IssueDetailDrawer';

const ERROR_MESSAGE = 'We could not save the issue changes. Please try again.';
const ISSUE_DELETE_ERROR_MESSAGE = 'We could not delete the issue. Please try again.';
const COMMENT_DELETE_ERROR_MESSAGE = 'We could not delete the comment. Please try again.';

export function IssuePage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { data, error, loading } = useQuery<IssuePageQueryData, IssuePageQueryVariables>(ISSUE_PAGE_QUERY, {
    skip: !id,
    variables: {
      id: id ?? '',
    },
  });
  const [runIssueUpdate] = useMutation<IssueUpdateMutationData, IssueUpdateMutationVariables>(
    ISSUE_UPDATE_MUTATION,
  );
  const [runCommentCreate] = useMutation<CommentCreateMutationData, CommentCreateMutationVariables>(
    COMMENT_CREATE_MUTATION,
  );
  const [runIssueDelete] = useMutation<IssueDeleteMutationData, IssueDeleteMutationVariables>(
    ISSUE_DELETE_MUTATION,
  );
  const [runCommentDelete] = useMutation<CommentDeleteMutationData, CommentDeleteMutationVariables>(
    COMMENT_DELETE_MUTATION,
  );
  const [localIssue, setLocalIssue] = useState<IssueSummary | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [isSavingState, setIsSavingState] = useState(false);

  useEffect(() => {
    setLocalIssue(data?.issue ?? null);
  }, [data?.issue]);

  useEffect(() => {
    if (!localIssue) {
      return;
    }

    writeStoredShellIssue(localIssue);
  }, [localIssue]);

  const selectedTeam = useMemo(() => {
    if (!localIssue) {
      return null;
    }

    const teamStates = localIssue.team.states ?? { nodes: [] };

    return {
      id: localIssue.team.id,
      key: localIssue.team.key,
      name: localIssue.team.name ?? localIssue.team.key,
      states: teamStates,
    };
  }, [localIssue]);

  async function persistIssueUpdate(
    issue: IssueSummary,
    input: IssueUpdateMutationVariables['input'],
    applyOptimisticIssue: (current: IssueSummary) => IssueSummary,
  ) {
    const previousIssue = localIssue;
    const nextIssue = applyOptimisticIssue(issue);

    setMutationError(null);
    setIsSavingState(true);
    setLocalIssue(nextIssue);

    try {
      const result = await runIssueUpdate({
        variables: {
          id: issue.id,
          input,
        },
      });

      if (!result.data?.issueUpdate.success || !result.data.issueUpdate.issue) {
        throw new Error('Mutation failed');
      }

      setLocalIssue((currentIssue) =>
        currentIssue
          ? mergeIssueWithPreservedComments(currentIssue, result.data!.issueUpdate.issue!)
          : result.data!.issueUpdate.issue!,
      );
    } catch (mutationIssue) {
      setLocalIssue(previousIssue);
      setMutationError(ERROR_MESSAGE);
    } finally {
      setIsSavingState(false);
    }
  }

  async function persistStateChange(issue: IssueSummary, stateId: string) {
    const state = selectedTeam?.states.nodes.find((item) => item.id === stateId) ?? null;

    if (!state || issue.state.id === stateId) {
      return;
    }

    await persistIssueUpdate(issue, { stateId }, (current) => ({
      ...current,
      state,
    }));
  }

  async function persistTitleChange(issue: IssueSummary, title: string) {
    if (issue.title === title) {
      return;
    }

    await persistIssueUpdate(issue, { title }, (current) => ({
      ...current,
      title,
    }));
  }

  async function persistDescriptionChange(issue: IssueSummary, description: string) {
    if ((issue.description ?? '') === description) {
      return;
    }

    await persistIssueUpdate(issue, { description }, (current) => ({
      ...current,
      description,
    }));
  }

  async function persistLabelsChange(issue: IssueSummary, labelIds: string[]) {
    const labels = data?.issueLabels.nodes ?? [];
    const nextLabels = labels.filter((label) => labelIds.includes(label.id));
    const currentLabelIds = issue.labels.nodes.map((label) => label.id).sort();
    const nextLabelIds = [...labelIds].sort();

    if (JSON.stringify(currentLabelIds) === JSON.stringify(nextLabelIds)) {
      return;
    }

    await persistIssueUpdate(issue, { labelIds }, (current) => ({
      ...current,
      labels: {
        nodes: nextLabels,
      },
    }));
  }

  async function persistAssigneeChange(issue: IssueSummary, assigneeId: string | null) {
    if ((issue.assignee?.id ?? null) === assigneeId) {
      return;
    }

    const users = data?.users.nodes ?? [];

    await persistIssueUpdate(issue, { assigneeId }, (current) => ({
      ...current,
      assignee: assigneeId ? users.find((user) => user.id === assigneeId) ?? null : null,
    }));
  }

  async function persistCommentCreate(issue: IssueSummary, body: string) {
    const trimmedBody = body.trim();

    if (!trimmedBody) {
      return;
    }

    setMutationError(null);
    setIsSavingState(true);

    try {
      const result = await runCommentCreate({
        variables: {
          input: {
            issueId: issue.id,
            body: trimmedBody,
          },
        },
      });

      if (!result.data?.commentCreate.success || !result.data.commentCreate.comment) {
        throw new Error('Comment mutation failed');
      }

      setLocalIssue((currentIssue) =>
        currentIssue
          ? {
              ...currentIssue,
              comments: {
                nodes: [...currentIssue.comments.nodes, result.data!.commentCreate.comment!].sort(
                  (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
                ),
              },
            }
          : currentIssue,
      );
    } catch (mutationIssue) {
      setMutationError(ERROR_MESSAGE);
      throw mutationIssue;
    } finally {
      setIsSavingState(false);
    }
  }

  async function persistIssueDelete(issue: IssueSummary) {
    setMutationError(null);
    setIsSavingState(true);

    try {
      const result = await runIssueDelete({
        variables: {
          id: issue.id,
        },
      });

      if (!result.data?.issueDelete.success || !result.data.issueDelete.issueId) {
        throw new Error('Delete issue mutation failed');
      }

      setLocalIssue(null);
      navigate('/');
    } catch {
      setMutationError(ISSUE_DELETE_ERROR_MESSAGE);
      throw new Error(ISSUE_DELETE_ERROR_MESSAGE);
    } finally {
      setIsSavingState(false);
    }
  }

  async function persistCommentDelete(issue: IssueSummary, commentId: string) {
    setMutationError(null);
    setIsSavingState(true);

    try {
      const result = await runCommentDelete({
        variables: {
          id: commentId,
        },
      });

      if (!result.data?.commentDelete.success || !result.data.commentDelete.commentId) {
        throw new Error('Delete comment mutation failed');
      }

      setLocalIssue((currentIssue) =>
        currentIssue
          ? {
              ...currentIssue,
              comments: {
                nodes: currentIssue.comments.nodes.filter((comment) => comment.id !== commentId),
              },
            }
          : currentIssue,
      );
    } catch {
      setMutationError(COMMENT_DELETE_ERROR_MESSAGE);
      throw new Error(COMMENT_DELETE_ERROR_MESSAGE);
    } finally {
      setIsSavingState(false);
    }
  }

  if (error) {
    const errorState = getBoardBootstrapErrorMessage(error);

    return (
      <main className="board-page board-page--state">
        <header className="app-shell__header">
          <div>
            <p className="app-shell__eyebrow">Involute</p>
            <h1>Issue detail</h1>
          </div>
        </header>
        <section className="shell-notice shell-notice--error" role="alert">
          <h2>{errorState.title}</h2>
          <p>{errorState.description}</p>
        </section>
      </main>
    );
  }

  if (loading && !data) {
    return (
      <main className="board-page board-page--state">
        <header className="app-shell__header">
          <div>
            <p className="app-shell__eyebrow">Involute</p>
            <h1>Issue detail</h1>
          </div>
        </header>
        <section className="shell-notice" aria-live="polite">
          Loading issue…
        </section>
      </main>
    );
  }

  if (!localIssue || !selectedTeam) {
    return (
      <main className="board-page board-page--state">
        <header className="app-shell__header">
          <div>
            <p className="app-shell__eyebrow">Involute</p>
            <h1>Issue detail</h1>
          </div>
        </header>
        <section className="shell-notice">
          <p>Issue not found.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="board-page">
      <header className="app-shell__header">
        <div className="app-shell__header-copy">
          <p className="app-shell__eyebrow">Involute</p>
          <div className="app-shell__header-inline-meta">
            <span className="context-chip">
              {selectedTeam.key}
            </span>
            <span className="context-chip">Issue</span>
          </div>
          <h1>Issue detail</h1>
        </div>
      </header>

      <IssueDetailDrawer
        issue={localIssue}
        team={selectedTeam}
        labels={data?.issueLabels.nodes ?? []}
        users={data?.users.nodes ?? []}
        savingState={isSavingState}
        errorMessage={mutationError}
        onClose={() => navigate(-1)}
        onStateChange={persistStateChange}
        onTitleSave={persistTitleChange}
        onDescriptionSave={persistDescriptionChange}
        onLabelsChange={persistLabelsChange}
        onAssigneeChange={persistAssigneeChange}
        onCommentCreate={persistCommentCreate}
        onCommentDelete={persistCommentDelete}
        onIssueDelete={persistIssueDelete}
        layout="page"
      />
    </main>
  );
}

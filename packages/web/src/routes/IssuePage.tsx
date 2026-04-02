import { useMutation, useQuery } from '@apollo/client/react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import {
  COMMENT_CREATE_MUTATION,
  ISSUE_PAGE_QUERY,
  ISSUE_UPDATE_MUTATION,
} from '../board/queries';
import type {
  CommentCreateMutationData,
  CommentCreateMutationVariables,
  IssuePageQueryData,
  IssuePageQueryVariables,
  IssueSummary,
  IssueUpdateMutationData,
  IssueUpdateMutationVariables,
} from '../board/types';
import { getBoardBootstrapErrorMessage } from '../lib/apollo';
import { IssueDetailDrawer } from '../components/IssueDetailDrawer';
import { mergeIssueWithPreservedComments } from './BoardPage';

const ERROR_MESSAGE = 'We could not save the issue changes. Please try again.';

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
  const [localIssue, setLocalIssue] = useState<IssueSummary | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [isSavingState, setIsSavingState] = useState(false);

  useEffect(() => {
    setLocalIssue(data?.issue ?? null);
  }, [data?.issue]);

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
      throw mutationIssue;
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
        <section className="board-message board-message--error" role="alert">
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
        <section className="board-message" aria-live="polite">
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
        <section className="board-message">
          <p>Issue not found.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="board-page">
      <header className="app-shell__header">
        <div>
          <p className="app-shell__eyebrow">Involute</p>
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
      />
    </main>
  );
}

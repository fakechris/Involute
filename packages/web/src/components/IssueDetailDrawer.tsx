import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import type { CommentSummary, IssueSummary, TeamSummary } from '../board/types';

interface IssueDetailDrawerProps {
  issue: IssueSummary | null;
  team: TeamSummary | null;
  labels: Array<{
    id: string;
    name: string;
  }>;
  users: Array<{
    id: string;
    name: string | null;
    email: string | null;
  }>;
  savingState: boolean;
  errorMessage: string | null;
  onClose: () => void;
  onStateChange: (issue: IssueSummary, stateId: string) => Promise<void>;
  onTitleSave: (issue: IssueSummary, title: string) => Promise<void>;
  onDescriptionSave: (issue: IssueSummary, description: string) => Promise<void>;
  onLabelsChange: (issue: IssueSummary, labelIds: string[]) => Promise<void>;
  onAssigneeChange: (issue: IssueSummary, assigneeId: string | null) => Promise<void>;
  onCommentCreate: (issue: IssueSummary, body: string) => Promise<void>;
  onCommentDelete: (issue: IssueSummary, commentId: string) => Promise<void>;
  onIssueDelete: (issue: IssueSummary) => Promise<void>;
}

export function IssueDetailDrawer({
  issue,
  team,
  labels,
  users,
  savingState,
  errorMessage,
  onClose,
  onStateChange,
  onTitleSave,
  onDescriptionSave,
  onLabelsChange,
  onAssigneeChange,
  onCommentCreate,
  onCommentDelete,
  onIssueDelete,
}: IssueDetailDrawerProps) {
  const [selectedStateId, setSelectedStateId] = useState<string>('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [selectedAssigneeId, setSelectedAssigneeId] = useState('');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  const isSavingTitleRef = useRef(false);

  useEffect(() => {
    setSelectedStateId(issue?.state.id ?? '');
  }, [issue?.id, issue?.state.id]);

  useEffect(() => {
    setTitle(issue?.title ?? '');
    setIsEditingTitle(false);
  }, [issue?.id, issue?.title]);

  useEffect(() => {
    setDescription(issue?.description ?? '');
  }, [issue?.id, issue?.description]);

  useEffect(() => {
    setSelectedLabelIds(issue?.labels.nodes.map((label) => label.id) ?? []);
  }, [issue?.id, issue?.labels]);

  useEffect(() => {
    setSelectedAssigneeId(issue?.assignee?.id ?? '');
  }, [issue?.id, issue?.assignee?.id]);

  useEffect(() => {
    setCommentBody('');
  }, [issue?.id]);

  const states = useMemo(() => team?.states.nodes ?? [], [team]);

  if (!issue) {
    return null;
  }

  const activeIssue = issue;

  async function commitTitle() {
    if (isSavingTitleRef.current) {
      return;
    }

    const nextTitle = title.trim();

    if (!nextTitle || nextTitle === activeIssue.title) {
      setTitle(activeIssue.title);
      return;
    }

    isSavingTitleRef.current = true;

    try {
      await onTitleSave(activeIssue, nextTitle);
    } finally {
      isSavingTitleRef.current = false;
    }
  }

  async function commitDescription() {
    if (description === (activeIssue.description ?? '')) {
      return;
    }

    await onDescriptionSave(activeIssue, description);
  }

  const parentSummary = activeIssue.parent
    ? `${activeIssue.parent.identifier} — ${activeIssue.parent.title}`
    : 'No parent issue.';
  const comments = [...activeIssue.comments.nodes].sort(
    (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );

  function formatCommentTimestamp(createdAt: string) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(createdAt));
  }

  async function handleCommentSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextBody = commentBody.trim();

    if (!nextBody) {
      return;
    }

    await onCommentCreate(activeIssue, nextBody);
    setCommentBody('');
  }

  function renderCommentAuthor(comment: CommentSummary) {
    return comment.user?.name ?? comment.user?.email ?? 'Unknown author';
  }

  function confirmIssueDelete(): boolean {
    return window.confirm(`Delete ${activeIssue.identifier}? This cannot be undone.`);
  }

  function confirmCommentDelete(): boolean {
    return window.confirm('Delete this comment? This cannot be undone.');
  }

  return (
    <aside
      className="issue-drawer"
      aria-label="Issue detail drawer"
      aria-modal="true"
      role="dialog"
    >
      <button
        type="button"
        className="issue-drawer__backdrop"
        aria-label="Close issue detail drawer"
        onClick={onClose}
      />
      <section className="issue-drawer__panel">
        <div className="issue-drawer__header">
          <div>
            <p className="app-shell__eyebrow">{activeIssue.identifier}</p>
            <div className="issue-drawer__title-row">
              <input
                aria-label="Issue title"
                className="issue-drawer__title-input"
                value={title}
                disabled={savingState}
                onFocus={() => setIsEditingTitle(true)}
                onChange={(event) => setTitle(event.target.value)}
                onBlur={() => {
                  setIsEditingTitle(false);
                  void commitTitle().catch(() => undefined);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    setIsEditingTitle(false);
                    void commitTitle().catch(() => undefined);
                  }
                }}
              />
              <span className="issue-drawer__inline-hint" aria-live="polite">
                {isEditingTitle ? 'Press Enter or blur to save' : 'Editable title'}
              </span>
            </div>
          </div>
          <div className="issue-drawer__header-actions">
            <button
              type="button"
              className="issue-drawer__delete"
              disabled={savingState}
              onClick={() => {
                if (!confirmIssueDelete()) {
                  return;
                }

                void onIssueDelete(activeIssue).catch(() => undefined);
              }}
            >
              Delete issue
            </button>
            <button type="button" className="issue-drawer__close" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="issue-drawer__section">
          <label className="issue-drawer__label" htmlFor="issue-description">
            Description
          </label>
          <textarea
            id="issue-description"
            aria-label="Issue description"
            className="issue-drawer__textarea"
            value={description}
            disabled={savingState}
            onChange={(event) => setDescription(event.target.value)}
            onBlur={() => void commitDescription().catch(() => undefined)}
          />
        </div>

        <div className="issue-drawer__section">
          <label className="team-selector">
            <span>State</span>
            <select
              aria-label="Issue state"
              value={selectedStateId}
              disabled={savingState}
              onChange={(event) => {
                const nextStateId = event.target.value;
                setSelectedStateId(nextStateId);
                void onStateChange(activeIssue, nextStateId).catch(() => undefined);
              }}
            >
              {states.map((state) => (
                <option key={state.id} value={state.id}>
                  {state.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="issue-drawer__section">
          <span className="issue-drawer__label">Labels</span>
          <div className="issue-drawer__chips" aria-label="Issue labels">
            {labels.length === 0 && (
              <p className="issue-drawer__empty-hint">No labels available</p>
            )}
            {labels.map((label) => {
              const checked = selectedLabelIds.includes(label.id);

              return (
                <label key={label.id} className="issue-drawer__checkbox">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={savingState}
                    onChange={(event) => {
                      const nextLabelIds = event.target.checked
                        ? [...selectedLabelIds, label.id]
                        : selectedLabelIds.filter((id) => id !== label.id);

                      setSelectedLabelIds(nextLabelIds);
                      void onLabelsChange(activeIssue, nextLabelIds).catch(() => undefined);
                    }}
                  />
                  <span>{label.name}</span>
                </label>
              );
            })}
          </div>
        </div>

        <div className="issue-drawer__section">
          <label className="team-selector">
            <span>Assignee</span>
            <select
              aria-label="Issue assignee"
              value={selectedAssigneeId}
              disabled={savingState}
              onChange={(event) => {
                const nextAssigneeId = event.target.value;
                setSelectedAssigneeId(nextAssigneeId);
                void onAssigneeChange(activeIssue, nextAssigneeId || null).catch(() => undefined);
              }}
            >
              <option value="">Unassigned</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name ?? user.email ?? user.id}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="issue-drawer__section">
          <span className="issue-drawer__label">Parent</span>
          <p>{parentSummary}</p>
          <span className="issue-drawer__label">Children</span>
          <p>
            {activeIssue.children.nodes.length > 0
              ? activeIssue.children.nodes.map((child) => `${child.identifier} — ${child.title}`).join(', ')
              : 'No child issues.'}
          </p>
        </div>

        <div className="issue-drawer__section">
          <span className="issue-drawer__label">Comments</span>
          {comments.length > 0 ? (
            <ol className="issue-comments" aria-label="Issue comments">
              {comments.map((comment) => (
                <li key={comment.id} className="issue-comment">
                  <div className="issue-comment__meta">
                    <strong>{renderCommentAuthor(comment)}</strong>
                    <div className="issue-comment__meta-actions">
                      <time dateTime={comment.createdAt}>
                        {formatCommentTimestamp(comment.createdAt)}
                      </time>
                      <button
                        type="button"
                        className="issue-comment__delete"
                        aria-label="Delete comment"
                        disabled={savingState}
                        onClick={() => {
                          if (!confirmCommentDelete()) {
                            return;
                          }

                          void onCommentDelete(activeIssue, comment.id).catch(() => undefined);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  <p className="issue-comment__body">{comment.body}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="issue-comments__empty">No comments yet. Start the discussion below.</p>
          )}

          <form className="issue-comment-composer" onSubmit={(event) => void handleCommentSubmit(event)}>
            <label className="issue-drawer__label" htmlFor="issue-comment-body">
              Add comment
            </label>
            <textarea
              id="issue-comment-body"
              aria-label="Comment body"
              className="issue-drawer__textarea issue-comment-composer__input"
              value={commentBody}
              disabled={savingState}
              onChange={(event) => setCommentBody(event.target.value)}
            />
            <button
              type="submit"
              className="issue-comment-composer__submit"
              disabled={savingState || commentBody.trim().length === 0}
            >
              Add comment
            </button>
          </form>
        </div>

        {errorMessage ? (
          <p className="issue-drawer__error" role="alert">
            {errorMessage}
          </p>
        ) : null}
      </section>
    </aside>
  );
}

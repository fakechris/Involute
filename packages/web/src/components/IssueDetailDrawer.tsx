import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

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
  layout?: 'drawer' | 'page';
  nextIssue?: IssueSummary | null;
  onNextIssue?: () => void;
  onPreviousIssue?: () => void;
  previousIssue?: IssueSummary | null;
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
  layout = 'drawer',
  nextIssue = null,
  onNextIssue,
  onPreviousIssue,
  previousIssue = null,
}: IssueDetailDrawerProps) {
  const navigate = useNavigate();
  const [selectedStateId, setSelectedStateId] = useState<string>('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [selectedAssigneeId, setSelectedAssigneeId] = useState('');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  const isSavingTitleRef = useRef(false);
  const titleTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setSelectedStateId(issue?.state.id ?? '');
  }, [issue?.id, issue?.state.id]);

  useEffect(() => {
    setTitle(issue?.title ?? '');
    setIsEditingTitle(false);
  }, [issue?.id, issue?.title]);

  useEffect(() => {
    const titleTextarea = titleTextareaRef.current;

    if (!titleTextarea) {
      return;
    }

    titleTextarea.style.height = '0px';
    titleTextarea.style.height = `${Math.max(titleTextarea.scrollHeight, 64)}px`;
  }, [title, issue?.id]);

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
  const comments = useMemo(
    () =>
      issue
        ? [...issue.comments.nodes].sort(
            (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
          )
        : [],
    [issue],
  );
  const activityEntries = useMemo(() => {
    if (!issue) {
      return [];
    }

    const entries: Array<{
      body?: string;
      id: string;
      meta: string;
      title: string;
    }> = [
      {
        id: `${issue.id}-created`,
        meta: issue.createdAt,
        title: `${issue.identifier} was created`,
      },
      {
        id: `${issue.id}-state`,
        meta: issue.updatedAt,
        title: `Current state is ${issue.state.name}`,
      },
    ];

    if (issue.assignee) {
      entries.push({
        id: `${issue.id}-assignee`,
        meta: issue.updatedAt,
        title: `Assigned to ${issue.assignee.name ?? issue.assignee.email ?? 'Unknown assignee'}`,
      });
    }

    if (issue.labels.nodes.length > 0) {
      entries.push({
        id: `${issue.id}-labels`,
        meta: issue.updatedAt,
        title: 'Labels updated',
        body: issue.labels.nodes.map((label) => label.name).join(', '),
      });
    }

    comments.forEach((comment) => {
      entries.push({
        id: comment.id,
        meta: comment.createdAt,
        title: `${renderCommentAuthor(comment)} commented`,
      });
    });

    return entries.sort((left, right) => new Date(left.meta).getTime() - new Date(right.meta).getTime());
  }, [
    comments,
    issue,
  ]);

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
      className={`issue-panel${layout === 'page' ? ' issue-panel--page' : ''}`}
      aria-label={layout === 'page' ? 'Issue detail page' : 'Issue detail drawer'}
      aria-modal={layout === 'drawer' ? 'true' : undefined}
      role={layout === 'drawer' ? 'dialog' : undefined}
    >
      {layout === 'drawer' ? (
        <button
          type="button"
          className="issue-panel__backdrop"
          aria-label="Close issue detail drawer"
          onClick={onClose}
        />
      ) : null}
      <section className={`issue-panel__frame${layout === 'page' ? ' issue-panel__frame--page' : ''}`}>
        <div className="issue-panel__header">
          <div className="issue-panel__title-row">
            {team ? <span className="context-chip context-chip--team">{team.key}</span> : null}
            <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
              {activeIssue.identifier}
            </span>
          </div>
          <div className="issue-panel__header-actions">
            {layout === 'drawer' && (previousIssue || nextIssue) ? (
              <div className="issue-panel__nav-actions" aria-label="Issue navigation">
                <button
                  type="button"
                  className="ui-action ui-action--subtle"
                  aria-label="Previous issue"
                  disabled={!previousIssue || savingState}
                  onClick={onPreviousIssue}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="ui-action ui-action--subtle"
                  aria-label="Next issue"
                  disabled={!nextIssue || savingState}
                  onClick={onNextIssue}
                >
                  Next
                </button>
              </div>
            ) : null}
            <button
              type="button"
              className="issue-panel__delete"
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
            <button type="button" className="issue-panel__close" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="issue-panel__body">
          <div className="issue-panel__main">
            <textarea
              ref={titleTextareaRef}
              aria-label="Issue title"
              className="issue-panel__title-input"
              value={title}
              rows={1}
              disabled={savingState}
              onFocus={() => setIsEditingTitle(true)}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => {
                setIsEditingTitle(false);
                void commitTitle().catch(() => undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  setIsEditingTitle(false);
                  void commitTitle().catch(() => undefined);
                }
              }}
            />
            <span className="issue-panel__inline-hint" aria-live="polite">
              {isEditingTitle ? 'Press Enter or blur to save' : 'Editable title'}
            </span>

            <div className="issue-panel__section">
              <label className="issue-panel__label" htmlFor="issue-description">
                Description
              </label>
              <textarea
                id="issue-description"
                aria-label="Issue description"
                className="issue-panel__textarea"
                value={description}
                disabled={savingState}
                onChange={(event) => setDescription(event.target.value)}
                onBlur={() => void commitDescription().catch(() => undefined)}
              />
            </div>

            {activeIssue.children.nodes.length > 0 ? (
              <div className="issue-panel__section">
                <h2>Sub-issues · {activeIssue.children.nodes.length}</h2>
                <div className="issue-children" role="list">
                  {activeIssue.children.nodes.map((child) => (
                    <button
                      key={child.id}
                      type="button"
                      role="listitem"
                      className="issue-children__row"
                      onClick={() => navigate(`/issue/${child.id}`)}
                    >
                      <span className="issue-children__id">{child.identifier}</span>
                      <span aria-hidden="true" />
                      <span className="issue-children__title">{child.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="issue-panel__section">
              <span className="issue-panel__label">Activity</span>
              <div className="issue-activity" aria-label="Issue activity">
                {activityEntries.map((entry) => (
                  <article key={entry.id} className="issue-activity__item">
                    <div className="issue-activity__meta">
                      <strong>{entry.title}</strong>
                      <time dateTime={entry.meta}>{formatCommentTimestamp(entry.meta)}</time>
                    </div>
                    {entry.body ? <p className="issue-activity__body">{entry.body}</p> : null}
                  </article>
                ))}
              </div>
            </div>

            <div className="issue-panel__section">
              <span className="issue-panel__label">Comments</span>
              {comments.length > 0 ? (
                <ol className="discussion-list" aria-label="Issue comments">
                  {comments.map((comment) => (
                    <li key={comment.id} className="discussion-entry">
                      <div className="discussion-entry__meta">
                        <strong>{renderCommentAuthor(comment)}</strong>
                        <div className="discussion-entry__actions">
                          <time dateTime={comment.createdAt}>
                            {formatCommentTimestamp(comment.createdAt)}
                          </time>
                          <button
                            type="button"
                            className="discussion-entry__delete"
                            aria-label="Delete comment"
                            disabled={savingState}
                            onClick={() => {
                              if (!confirmCommentDelete()) {
                                return;
                              }

                              void onCommentDelete(activeIssue, comment.id).catch(() => undefined);
                            }}
                          >
                            Delete comment
                          </button>
                        </div>
                      </div>
                      <p className="discussion-entry__body">{comment.body}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="discussion-empty">No comments yet. Start the discussion below.</p>
              )}

              <form className="discussion-form" onSubmit={(event) => void handleCommentSubmit(event)}>
                <label className="issue-panel__label" htmlFor="discussion-body">
                  Add comment
                </label>
                <textarea
                  id="discussion-body"
                  aria-label="Comment body"
                  className="issue-panel__textarea discussion-form__input"
                  value={commentBody}
                  disabled={savingState}
                  onChange={(event) => setCommentBody(event.target.value)}
                />
                <button
                  type="submit"
                  className="ui-action ui-action--accent"
                  disabled={savingState || commentBody.trim().length === 0}
                >
                  Add comment
                </button>
              </form>
            </div>
          </div>

          <aside className="issue-panel__rail" aria-label="Issue properties">
            <div className="issue-panel__properties">
              <div className="issue-panel__property-group">
                <label className="field-stack">
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

              <div className="issue-panel__property-group">
                <label className="field-stack">
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

              <div className="issue-panel__property-group">
                <span className="issue-panel__label">Labels</span>
                <div className="issue-panel__chips" aria-label="Issue labels">
                  {labels.length === 0 && (
                    <p className="issue-panel__empty-hint">No labels available</p>
                  )}
                  {labels.map((label) => {
                    const checked = selectedLabelIds.includes(label.id);

                    return (
                      <label key={label.id} className="issue-panel__checkbox">
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

              <div className="issue-panel__property-group">
                <span className="issue-panel__label">Parent</span>
                <p>{parentSummary}</p>
              </div>

              <div className="issue-panel__property-group">
                <span className="issue-panel__label">Sub-issues</span>
                <p>
                  {activeIssue.children.nodes.length > 0
                    ? `${activeIssue.children.nodes.length} child${activeIssue.children.nodes.length === 1 ? '' : 'ren'}`
                    : 'No child issues.'}
                </p>
              </div>
            </div>
          </aside>
        </div>

        {errorMessage ? (
          <p className="issue-panel__error" role="alert">
            {errorMessage}
          </p>
        ) : null}
      </section>
    </aside>
  );
}

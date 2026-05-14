import { useMutation, useQuery } from '@apollo/client/react';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
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
  CommentSummary,
} from '../board/types';
import { mergeIssueWithPreservedComments } from '../board/utils';
import { getBoardBootstrapErrorMessage } from '../lib/apollo';
import { writeStoredShellIssue } from '../lib/app-shell-state';
import { IcoChevL, IcoChevR, IcoCopy, IcoMore, IcoLink, IcoClose, IcoLabel } from '../components/Icons';
import { Avatar, Btn, Kbd } from '../components/Primitives';

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
  const issueSnapshot = localIssue ?? data?.issue ?? null;

  // Local UI state (previously in IssueDetailDrawer)
  const [selectedStateId, setSelectedStateId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [selectedAssigneeId, setSelectedAssigneeId] = useState('');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  const isSavingTitleRef = useRef(false);
  const titleTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setLocalIssue(data?.issue ?? null);
  }, [data?.issue]);

  useEffect(() => {
    if (!issueSnapshot) {
      return;
    }

    writeStoredShellIssue(issueSnapshot);
  }, [issueSnapshot]);

  useEffect(() => {
    setSelectedStateId(issueSnapshot?.state.id ?? '');
  }, [issueSnapshot?.id, issueSnapshot?.state.id]);

  useEffect(() => {
    setTitle(issueSnapshot?.title ?? '');
    setIsEditingTitle(false);
  }, [issueSnapshot?.id, issueSnapshot?.title]);

  useEffect(() => {
    const el = titleTextareaRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.max(el.scrollHeight, 40)}px`;
  }, [title, issueSnapshot?.id]);

  useEffect(() => {
    setDescription(issueSnapshot?.description ?? '');
  }, [issueSnapshot?.id, issueSnapshot?.description]);

  useEffect(() => {
    setSelectedLabelIds(issueSnapshot?.labels.nodes.map((l) => l.id) ?? []);
  }, [issueSnapshot?.id, issueSnapshot?.labels]);

  useEffect(() => {
    setSelectedAssigneeId(issueSnapshot?.assignee?.id ?? '');
  }, [issueSnapshot?.id, issueSnapshot?.assignee?.id]);

  useEffect(() => {
    setCommentBody('');
  }, [issueSnapshot?.id]);

  const selectedTeam = useMemo(() => {
    if (!issueSnapshot) {
      return null;
    }

    const teamStates = issueSnapshot.team.states ?? { nodes: [] };

    return {
      id: issueSnapshot.team.id,
      key: issueSnapshot.team.key,
      name: issueSnapshot.team.name ?? issueSnapshot.team.key,
      states: teamStates,
    };
  }, [issueSnapshot]);

  const states = useMemo(() => selectedTeam?.states.nodes ?? [], [selectedTeam]);
  const comments = useMemo(
    () =>
      issueSnapshot
        ? [...issueSnapshot.comments.nodes].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          )
        : [],
    [issueSnapshot],
  );

  const activityEntries = useMemo(() => {
    if (!issueSnapshot) {
      return [];
    }

    const entries: Array<{
      kind: 'event' | 'comment';
      id: string;
      timestamp: string;
      title: string;
      body?: string;
      comment?: CommentSummary;
    }> = [
      {
        kind: 'event',
        id: `${issueSnapshot.id}-created`,
        timestamp: issueSnapshot.createdAt,
        title: `${issueSnapshot.identifier} was created`,
      },
      {
        kind: 'event',
        id: `${issueSnapshot.id}-state`,
        timestamp: issueSnapshot.updatedAt,
        title: `Current state is ${issueSnapshot.state.name}`,
      },
    ];

    if (issueSnapshot.assignee) {
      entries.push({
        kind: 'event',
        id: `${issueSnapshot.id}-assignee`,
        timestamp: issueSnapshot.updatedAt,
        title: `Assigned to ${issueSnapshot.assignee.name ?? issueSnapshot.assignee.email ?? 'Unknown'}`,
      });
    }

    if (issueSnapshot.labels.nodes.length > 0) {
      entries.push({
        kind: 'event',
        id: `${issueSnapshot.id}-labels`,
        timestamp: issueSnapshot.updatedAt,
        title: 'Labels updated',
        body: issueSnapshot.labels.nodes.map((l) => l.name).join(', '),
      });
    }

    comments.forEach((comment) => {
      entries.push({
        kind: 'comment',
        id: comment.id,
        timestamp: comment.createdAt,
        title: renderCommentAuthor(comment),
        body: comment.body,
        comment,
      });
    });

    return entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }, [comments, issueSnapshot]);

  // --- Mutation handlers ---

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

  async function persistTitleChange(issue: IssueSummary, nextTitle: string) {
    if (issue.title === nextTitle) {
      return;
    }

    await persistIssueUpdate(issue, { title: nextTitle }, (current) => ({
      ...current,
      title: nextTitle,
    }));
  }

  async function persistDescriptionChange(issue: IssueSummary, desc: string) {
    if ((issue.description ?? '') === desc) {
      return;
    }

    await persistIssueUpdate(issue, { description: desc }, (current) => ({
      ...current,
      description: desc,
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

  // --- Local helpers ---

  async function commitTitle() {
    if (isSavingTitleRef.current || !issueSnapshot) return;
    const nextTitle = title.trim();
    if (!nextTitle || nextTitle === issueSnapshot.title) {
      setTitle(issueSnapshot.title);
      return;
    }
    isSavingTitleRef.current = true;
    try {
      await persistTitleChange(issueSnapshot, nextTitle);
    } finally {
      isSavingTitleRef.current = false;
    }
  }

  async function commitDescription() {
    if (!issueSnapshot) return;
    if (description === (issueSnapshot.description ?? '')) return;
    await persistDescriptionChange(issueSnapshot, description);
  }

  function formatTimestamp(ts: string) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts));
  }

  function renderCommentAuthor(comment: CommentSummary) {
    return comment.user?.name ?? comment.user?.email ?? 'Unknown author';
  }

  function handleCopyLink() {
    void navigator.clipboard.writeText(window.location.href);
  }

  async function handleCommentSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!issueSnapshot) return;
    const next = commentBody.trim();
    if (!next) return;
    await persistCommentCreate(issueSnapshot, next);
    setCommentBody('');
  }

  function confirmIssueDelete(): boolean {
    return window.confirm(`Delete ${issueSnapshot?.identifier}? This cannot be undone.`);
  }

  function confirmCommentDelete(): boolean {
    return window.confirm('Delete this comment? This cannot be undone.');
  }

  // --- Error / loading / not found ---

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

  if (!issueSnapshot || !selectedTeam) {
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

  const activeIssue = issueSnapshot;
  const allLabels = data?.issueLabels.nodes ?? [];
  const allUsers = data?.users.nodes ?? [];

  // --- Render ---

  return (
    <main className="issue-panel issue-panel--page" aria-label="Issue detail page">
      {/* ── Header ── */}
      <div className="issue-panel__header">
        <div className="issue-panel__title-row">
          <Btn variant="ghost" icon={<IcoChevL size={12} />} onClick={() => navigate(-1)}>
            {selectedTeam.key}
          </Btn>
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
            {activeIssue.identifier}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <div className="issue-panel__header-actions">
          <Btn variant="ghost" icon={<IcoCopy />} title="Copy link" onClick={handleCopyLink} />
          <Btn variant="ghost" icon={<IcoChevL />} title="Previous issue" />
          <Btn variant="ghost" icon={<IcoChevR />} title="Next issue" />
          <Btn variant="ghost" icon={<IcoMore />} title="More" />
        </div>
      </div>

      {/* ── Body: two columns ── */}
      <div className="issue-panel__body">
        {/* Left column — main content */}
        <div className="issue-panel__main">
          <div className="issue-panel__content-wrap">
            {/* Title */}
            <textarea
              ref={titleTextareaRef}
              aria-label="Issue title"
              className="issue-panel__title-input"
              value={title}
              rows={1}
              disabled={isSavingState}
              onFocus={() => setIsEditingTitle(true)}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                setIsEditingTitle(false);
                void commitTitle().catch(() => undefined);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  setIsEditingTitle(false);
                  void commitTitle().catch(() => undefined);
                }
              }}
            />

            {/* Description */}
            <textarea
              aria-label="Issue description"
              className="issue-panel__description-input"
              value={description}
              placeholder="Add a description…"
              disabled={isSavingState}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => void commitDescription().catch(() => undefined)}
            />

            {/* Sub-issues */}
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

            {/* Activity */}
            <div className="issue-panel__activity-section">
              <div className="issue-panel__activity-header">Activity</div>
              <div className="issue-activity" aria-label="Issue activity">
                {activityEntries.map((entry) =>
                  entry.kind === 'comment' && entry.comment ? (
                    <div key={entry.id} className="issue-activity__comment">
                      <Avatar user={{ name: renderCommentAuthor(entry.comment) }} size={22} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="issue-activity__comment-meta">
                          <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--fg)' }}>
                            {renderCommentAuthor(entry.comment)}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
                            {formatTimestamp(entry.timestamp)}
                          </span>
                          <button
                            type="button"
                            className="discussion-entry__delete"
                            aria-label="Delete comment"
                            disabled={isSavingState}
                            onClick={() => {
                              if (!confirmCommentDelete()) return;
                              void persistCommentDelete(activeIssue, entry.comment!.id).catch(() => undefined);
                            }}
                          >
                            Delete
                          </button>
                        </div>
                        <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--fg-muted)', whiteSpace: 'pre-wrap' }}>
                          {entry.comment.body}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div key={entry.id} className="issue-activity__event">
                      <div className="issue-activity__event-icon">
                        {entry.id.endsWith('-labels') ? (
                          <IcoLabel size={12} />
                        ) : (
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--fg-dim)', display: 'block' }} />
                        )}
                      </div>
                      <span style={{ flex: 1 }}>{entry.title}</span>
                      {entry.body ? (
                        <span style={{ color: 'var(--fg-muted)' }}>{entry.body}</span>
                      ) : null}
                      <span style={{ marginLeft: 'auto', fontSize: 11 }}>
                        {formatTimestamp(entry.timestamp)}
                      </span>
                    </div>
                  ),
                )}
              </div>
            </div>

            {/* Comment box */}
            <form
              className="issue-panel__comment-box"
              onSubmit={(e) => void handleCommentSubmit(e)}
            >
              <textarea
                aria-label="Leave a comment"
                className="issue-panel__comment-input"
                value={commentBody}
                placeholder="Leave a comment…"
                disabled={isSavingState}
                onChange={(e) => setCommentBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (commentBody.trim()) {
                      void handleCommentSubmit(e as unknown as FormEvent<HTMLFormElement>);
                    }
                  }
                }}
              />
              <div className="issue-panel__comment-toolbar">
                <Btn variant="ghost" size="sm">B</Btn>
                <Btn variant="ghost" size="sm" style={{ fontStyle: 'italic' }}>I</Btn>
                <Btn variant="ghost" size="sm">Code</Btn>
                <Btn variant="ghost" size="sm" icon={<IcoLink size={12} />} />
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: 'var(--fg-dim)', marginRight: 4 }}>
                  <Kbd keys={['⌘', '↵']} /> to submit
                </span>
                <Btn
                  variant={commentBody.trim() ? 'accent' : 'subtle'}
                  size="sm"
                  onClick={() => {
                    if (!commentBody.trim() || !issueSnapshot) return;
                    void persistCommentCreate(issueSnapshot, commentBody.trim()).then(() => setCommentBody(''));
                  }}
                >
                  Comment
                </Btn>
              </div>
            </form>
          </div>
        </div>

        {/* Right column — properties rail */}
        <aside className="issue-panel__rail" aria-label="Issue properties">
          <div className="issue-panel__section-title">Properties</div>

          {/* Status */}
          <div className="issue-panel__prop-row">
            <div className="issue-panel__prop-label">Status</div>
            <div className="issue-panel__prop-value">
              <select
                aria-label="Issue state"
                className="issue-panel__prop-select"
                value={selectedStateId}
                disabled={isSavingState}
                onChange={(e) => {
                  const next = e.target.value;
                  setSelectedStateId(next);
                  void persistStateChange(activeIssue, next).catch(() => undefined);
                }}
              >
                {states.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Assignee */}
          <div className="issue-panel__prop-row">
            <div className="issue-panel__prop-label">Assignee</div>
            <div className="issue-panel__prop-value" style={{ gap: 6 }}>
              <Avatar
                user={activeIssue.assignee ? { name: activeIssue.assignee.name || undefined } : null}
                size={18}
              />
              <select
                aria-label="Issue assignee"
                className="issue-panel__prop-select"
                value={selectedAssigneeId}
                disabled={isSavingState}
                onChange={(e) => {
                  const next = e.target.value;
                  setSelectedAssigneeId(next);
                  void persistAssigneeChange(activeIssue, next || null).catch(() => undefined);
                }}
              >
                <option value="">Unassigned</option>
                {allUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name ?? u.email ?? u.id}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Labels */}
          <div className="issue-panel__prop-row" style={{ alignItems: 'flex-start' }}>
            <div className="issue-panel__prop-label">Labels</div>
            <div className="issue-panel__prop-value" style={{ flexWrap: 'wrap' }}>
              {allLabels.length === 0 ? (
                <span style={{ color: 'var(--fg-dim)' }}>—</span>
              ) : (
                allLabels.map((label) => {
                  const checked = selectedLabelIds.includes(label.id);
                  return (
                    <label key={label.id} className="issue-panel__checkbox">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isSavingState}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...selectedLabelIds, label.id]
                            : selectedLabelIds.filter((lid) => lid !== label.id);
                          setSelectedLabelIds(next);
                          void persistLabelsChange(activeIssue, next).catch(() => undefined);
                        }}
                      />
                      <span>{label.name}</span>
                    </label>
                  );
                })
              )}
            </div>
          </div>

          {/* Project */}
          <div className="issue-panel__prop-row">
            <div className="issue-panel__prop-label">Project</div>
            <div className="issue-panel__prop-value">
              <span style={{ color: 'var(--fg-dim)' }}>No project</span>
            </div>
          </div>

          {/* Team */}
          <div className="issue-panel__prop-row">
            <div className="issue-panel__prop-label">Team</div>
            <div className="issue-panel__prop-value">
              <span className="mono" style={{
                fontSize: 10, padding: '1px 5px', borderRadius: 3,
                background: 'var(--bg-hover)', border: '1px solid var(--border)',
                color: 'var(--fg-muted)',
              }}>
                {selectedTeam.key}
              </span>
            </div>
          </div>

          <div className="issue-panel__divider" />

          <div className="issue-panel__section-title">Actions</div>

          <button
            type="button"
            className="issue-panel__action-btn"
            onClick={handleCopyLink}
          >
            <span style={{ color: 'var(--fg-dim)', display: 'inline-flex' }}><IcoCopy size={13} /></span>
            <span>Copy issue URL</span>
            <div style={{ flex: 1 }} />
            <Kbd keys={['⌘', 'L']} />
          </button>

          <button type="button" className="issue-panel__action-btn">
            <span style={{ color: 'var(--fg-dim)', display: 'inline-flex' }}><IcoLink size={13} /></span>
            <span>Link to issue</span>
          </button>

          <button
            type="button"
            className="issue-panel__action-btn issue-panel__action-btn--danger"
            disabled={isSavingState}
            onClick={() => {
              if (!confirmIssueDelete()) return;
              void persistIssueDelete(activeIssue).catch(() => undefined);
            }}
          >
            <span style={{ display: 'inline-flex' }}><IcoClose size={13} /></span>
            <span>Delete</span>
          </button>

          {mutationError ? (
            <p className="issue-panel__error" role="alert">{mutationError}</p>
          ) : null}
        </aside>
      </div>
    </main>
  );
}

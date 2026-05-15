import { useMutation, useQuery } from '@apollo/client/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import {
  COMMENT_DELETE_MUTATION,
  COMMENT_CREATE_MUTATION,
  ISSUE_DELETE_MUTATION,
  ISSUE_PAGE_QUERY,
  ISSUE_UPDATE_MUTATION,
  PROJECTS_QUERY,
  CYCLES_QUERY,
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
  ProjectsQueryData,
  ProjectsQueryVariables,
  CyclesQueryData,
  CyclesQueryVariables,
} from '../board/types';
import { mergeIssueWithPreservedComments } from '../board/utils';
import { getBoardBootstrapErrorMessage } from '../lib/apollo';
import { writeStoredShellIssue } from '../lib/app-shell-state';
import { IcoChevL, IcoChevR, IcoCopy, IcoMore, IcoLink, IcoClose, IcoLabel } from '../components/Icons';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { Avatar, Btn, Kbd } from '../components/Primitives';
import { RichTextEditor } from '../components/RichTextEditor';

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

  const teamId = data?.issue?.team.id ?? '';
  const { data: projectsData } = useQuery<ProjectsQueryData, ProjectsQueryVariables>(PROJECTS_QUERY, {
    skip: !teamId,
    variables: { teamId },
  });
  const { data: cyclesData } = useQuery<CyclesQueryData, CyclesQueryVariables>(CYCLES_QUERY, {
    skip: !teamId,
    variables: { teamId },
  });

  const [localIssue, setLocalIssue] = useState<IssueSummary | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [isSavingState, setIsSavingState] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const issueSnapshot = localIssue ?? data?.issue ?? null;

  // Local UI state (previously in IssueDetailDrawer)
  const [selectedStateId, setSelectedStateId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [selectedAssigneeId, setSelectedAssigneeId] = useState('');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isEditingDescription, setIsEditingDescription] = useState(false);
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
  const allLabels = Array.from(
    new Map((data?.issueLabels.nodes ?? []).map(l => [l.id, l])).values()
  );
  const allUsers = data?.users.nodes ?? [];

  // --- Render ---

  return (
    <main className="issue-panel issue-panel--page" aria-label="Issue detail page">
      <h1 className="sr-only" style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', border: 0 }}>Issue detail</h1>
      {/* ── Header ── */}
      <div className="issue-panel__header">
        <div className="issue-panel__title-row">
          <Btn variant="ghost" icon={<IcoChevL size={12} />} onClick={() => navigate(-1)}>
            {selectedTeam.key}
          </Btn>
          {activeIssue.parent ? (
            <>
              <span style={{ color: 'var(--fg-faint)', display: 'inline-flex' }}>
                <IcoChevR size={10} />
              </span>
              <button
                type="button"
                onClick={() => navigate(`/issue/${activeIssue.parent!.id}`)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 11, color: 'var(--fg-muted)', padding: '2px 4px',
                  borderRadius: 'var(--r-1)',
                }}
                className="mono"
                title={activeIssue.parent.title}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
              >
                {activeIssue.parent.identifier}
              </button>
            </>
          ) : null}
          <span style={{ color: 'var(--fg-faint)', display: 'inline-flex' }}>
            <IcoChevR size={10} />
          </span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
            {activeIssue.identifier}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <div className="issue-panel__header-actions">
          <Btn variant="ghost" icon={<IcoChevL />} title="Previous issue" onClick={() => navigate(-1)} />
          <Btn variant="ghost" icon={<IcoChevR />} title="Next issue" onClick={() => navigate(1)} />
          <div style={{ position: 'relative' }}>
            <Btn variant="ghost" icon={<IcoMore />} title="More" onClick={() => setMoreMenuOpen(!moreMenuOpen)} />
            {moreMenuOpen && (
              <div style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 10,
                background: 'var(--bg-raised)', border: '1px solid var(--border)',
                borderRadius: 'var(--r-2)', padding: 4, minWidth: 140,
              }}>
                <button
                  type="button"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg)', borderRadius: 'var(--r-1)' }}
                  onClick={() => { setMoreMenuOpen(false); handleCopyLink(); }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
                >
                  <IcoCopy size={12} /> Copy link
                </button>
                <button
                  type="button"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', borderRadius: 'var(--r-1)' }}
                  onClick={() => {
                    setMoreMenuOpen(false);
                    if (confirmIssueDelete()) {
                      void persistIssueDelete(activeIssue).catch(() => undefined);
                    }
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
                >
                  <IcoClose size={12} /> Delete issue
                </button>
              </div>
            )}
          </div>
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
            {isEditingDescription ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <RichTextEditor
                  value={description}
                  onChange={setDescription}
                  placeholder="Add a description…"
                  submitLabel="Save"
                  disabled={isSavingState}
                  ariaLabel="Issue description"
                  onSubmit={() => {
                    setIsEditingDescription(false);
                    void commitDescription().catch(() => undefined);
                  }}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    style={{
                      height: 26, padding: '0 12px', fontSize: 12, fontWeight: 500,
                      borderRadius: 'var(--r-2)', border: '1px solid var(--border)', cursor: 'pointer',
                      background: 'transparent', color: 'var(--fg-muted)',
                    }}
                    onClick={() => {
                      setDescription(issueSnapshot?.description ?? '');
                      setIsEditingDescription(false);
                    }}
                  >Cancel</button>
                </div>
              </div>
            ) : (
              <div
                style={{ position: 'relative', cursor: 'pointer', minHeight: 32 }}
                onClick={() => setIsEditingDescription(true)}
                role="button"
                tabIndex={0}
                aria-label="Edit description"
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setIsEditingDescription(true); }}
              >
                {description ? (
                  <MarkdownRenderer content={description} />
                ) : (
                  <span style={{ color: 'var(--fg-dim)', fontSize: 13 }}>Add a description…</span>
                )}
                <button
                  type="button"
                  style={{
                    position: 'absolute', top: 0, right: 0,
                    height: 22, padding: '0 8px', fontSize: 11, fontWeight: 500,
                    borderRadius: 'var(--r-2)', border: '1px solid var(--border)', cursor: 'pointer',
                    background: 'var(--bg-hover)', color: 'var(--fg-muted)',
                    opacity: 0.7,
                  }}
                  onClick={(e) => { e.stopPropagation(); setIsEditingDescription(true); }}
                >Edit</button>
              </div>
            )}

            {/* Parent issue */}
            {activeIssue.parent ? (
              <div className="issue-panel__section">
                <h2>Parent issue</h2>
                <button
                  type="button"
                  className="issue-children__row"
                  onClick={() => navigate(`/issue/${activeIssue.parent!.id}`)}
                  style={{ display: 'flex', gap: 6, padding: '4px 0', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg)', fontSize: 13 }}
                >
                  {activeIssue.parent.identifier} — {activeIssue.parent.title}
                </button>
              </div>
            ) : null}

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
                        <MarkdownRenderer content={entry.comment.body} />
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
            <RichTextEditor
              value={commentBody}
              onChange={setCommentBody}
              placeholder="Leave a comment…"
              submitLabel="Comment"
              disabled={isSavingState}
              onSubmit={() => {
                if (!commentBody.trim() || !issueSnapshot) return;
                void persistCommentCreate(issueSnapshot, commentBody.trim()).then(() => setCommentBody(''));
              }}
            />
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
              <select
                aria-label="Issue project"
                className="issue-panel__prop-select"
                value={activeIssue.projectId ?? ''}
                disabled={isSavingState}
                onChange={(e) => {
                  const val = e.target.value || null;
                  void persistIssueUpdate(activeIssue, { projectId: val }, (current) => ({
                    ...current,
                    projectId: val,
                  })).catch(() => undefined);
                }}
              >
                <option value="">No project</option>
                {(projectsData?.projects?.nodes ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Cycle */}
          <div className="issue-panel__prop-row">
            <div className="issue-panel__prop-label">Cycle</div>
            <div className="issue-panel__prop-value">
              <select
                aria-label="Issue cycle"
                className="issue-panel__prop-select"
                value={activeIssue.cycleId ?? ''}
                disabled={isSavingState}
                onChange={(e) => {
                  const val = e.target.value || null;
                  void persistIssueUpdate(activeIssue, { cycleId: val }, (current) => ({
                    ...current,
                    cycleId: val,
                  })).catch(() => undefined);
                }}
              >
                <option value="">No cycle</option>
                {(cyclesData?.cycles?.nodes ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
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

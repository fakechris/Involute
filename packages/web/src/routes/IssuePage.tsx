import { useMutation, useQuery } from '@apollo/client/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import {
  AGENT_REQUEST_ANSWER_MUTATION,
  COMMENT_DELETE_MUTATION,
  COMMENT_CREATE_MUTATION,
  ISSUE_DELETE_MUTATION,
  ISSUE_PAGE_QUERY,
  ISSUE_UPDATE_MUTATION,
  PROJECTS_QUERY,
  PROJECT_ISSUES_QUERY,
  WORK_LINK_MUTATION,
  CYCLES_QUERY,
} from '../board/queries';
import type {
  AgentRequestSummary,
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
  ProjectIssuesQueryData,
  ProjectIssuesQueryVariables,
  WorkLinkMutationData,
  WorkLinkMutationVariables,
  CyclesQueryData,
  CyclesQueryVariables,
} from '../board/types';
import { ActorBadge } from '../components/ActorBadge';
import { IssueRelations } from '../components/IssueRelations';
import { AddSubIssueButton } from '../components/AddSubIssueButton';
import { BugSlaBadge } from '../components/BugSlaBadge';
import { mergeIssueWithPreservedComments } from '../board/utils';
import { BootstrapErrorNotice } from '../components/BootstrapErrorNotice';
import { getBoardBootstrapErrorMessage } from '../lib/apollo';
import { fetchSessionState, type SessionViewer } from '../lib/session';
import { writeStoredShellIssue } from '../lib/app-shell-state';
import { IcoChevL, IcoChevR, IcoCopy, IcoMore, IcoLink, IcoClose, IcoLabel } from '../components/Icons';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { Avatar, Btn, Kbd } from '../components/Primitives';
import { RichTextEditor } from '../components/RichTextEditor';

const ERROR_MESSAGE = 'We could not save the issue changes. Please try again.';
const CONFLICT_MESSAGE = 'The issue changed while you were editing. The latest version was reloaded; review it and retry.';
const ISSUE_DELETE_ERROR_MESSAGE = 'We could not delete the issue. Please try again.';
const COMMENT_DELETE_ERROR_MESSAGE = 'We could not delete the comment. Please try again.';

/** Group requests into hand-off chains (root first, then by hop). The server returns whole chains for the newest requests, so a missing root is a defect, flagged below. */
function groupChains(requests: AgentRequestSummary[]): AgentRequestSummary[][] {
  const byRoot = new Map<string, AgentRequestSummary[]>();
  for (const request of requests) {
    const root = request.rootRequestId ?? request.id;
    byRoot.set(root, [...(byRoot.get(root) ?? []), request]);
  }
  return [...byRoot.values()].map((chain) => [...chain].sort((a, b) => a.hopCount - b.hopCount));
}

export function IssuePage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { data, error, loading, refetch } = useQuery<IssuePageQueryData, IssuePageQueryVariables>(ISSUE_PAGE_QUERY, {
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
  const teamKey = data?.issue?.team.key ?? '';
  const { data: projectIssuesData } = useQuery<ProjectIssuesQueryData, ProjectIssuesQueryVariables>(
    PROJECT_ISSUES_QUERY,
    {
      skip: !teamKey,
      variables: { teamKey },
    },
  );
  const [runWorkLink] = useMutation<WorkLinkMutationData, WorkLinkMutationVariables>(WORK_LINK_MUTATION);
  const [runAgentRequestAnswer] = useMutation<{ agentRequestAnswer: { success: boolean } }, { input: { body: string; overrideReason?: string | null; requestId: string } }>(AGENT_REQUEST_ANSWER_MUTATION);
  // Who is looking: decides whether a request row offers "Answer" (INV-596).
  const [sessionViewer, setSessionViewer] = useState<SessionViewer | null>(null);
  useEffect(() => { fetchSessionState().then((s) => setSessionViewer(s.viewer)).catch(() => setSessionViewer(null)); }, []);
  const [answeringRequestId, setAnsweringRequestId] = useState<string | null>(null);
  const [answerBody, setAnswerBody] = useState('');
  const [answerOverride, setAnswerOverride] = useState('');
  const [answerError, setAnswerError] = useState<string | null>(null);
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
        body: [...new Set(issueSnapshot.labels.nodes.map((l) => l.name))].join(', '),
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
          input: { ...input, expectedRevision: issue.revision },
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
      try {
        const refreshed = await refetch();
        setLocalIssue(refreshed.data?.issue ?? previousIssue);
        setMutationError(CONFLICT_MESSAGE);
      } catch {
        setLocalIssue(previousIssue);
        setMutationError(ERROR_MESSAGE);
      }
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
        <BootstrapErrorNotice state={errorState} />
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
  const allLabels = (() => {
    const raw = data?.issueLabels.nodes ?? [];
    const namesSeen = new Set<string>();
    return raw.filter((l) => {
      if (namesSeen.has(l.name)) return false;
      namesSeen.add(l.name);
      return true;
    });
  })();
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
                  fontSize: 13, color: 'var(--fg-muted)', padding: '2px 4px',
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
          <span className="mono" style={{ fontSize: 13, color: 'var(--fg-dim)' }}>
            {activeIssue.identifier}
          </span>
          {activeIssue.provenance ? (
            <span className="issue-panel__provenance">
              {activeIssue.provenance.actor ? (
                <>
                  proposed by{' '}
                  <ActorBadge
                    actor={activeIssue.provenance.actor}
                    onSelect={(picked) => navigate(`/agents/${picked}`)}
                  />
                </>
              ) : (
                <>
                  proposed via{' '}
                  {[
                    activeIssue.provenance.source,
                    activeIssue.provenance.surface,
                    activeIssue.provenance.actorKind?.toLowerCase(),
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'an unidentified path'}
                </>
              )}
            </span>
          ) : null}
        </div>
        <div style={{ flex: 1 }} />
        <div className="issue-panel__header-actions">
          <Btn variant="subtle" onClick={() => navigate(`/work/${activeIssue.id}`)}>
            Work context
          </Btn>
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
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px', fontSize: 14, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg)', borderRadius: 'var(--r-1)' }}
                  onClick={() => { setMoreMenuOpen(false); handleCopyLink(); }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
                >
                  <IcoCopy size={12} /> Copy link
                </button>
                <button
                  type="button"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px', fontSize: 14, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', borderRadius: 'var(--r-1)' }}
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
                      height: 26, padding: '0 12px', fontSize: 14, fontWeight: 500,
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
                  <span style={{ color: 'var(--fg-dim)', fontSize: 15 }}>Add a description…</span>
                )}
                <button
                  type="button"
                  style={{
                    position: 'absolute', top: 0, right: 0,
                    height: 22, padding: '0 8px', fontSize: 13, fontWeight: 500,
                    borderRadius: 'var(--r-2)', border: '1px solid var(--border)', cursor: 'pointer',
                    background: 'var(--bg-hover)', color: 'var(--fg-muted)',
                    opacity: 0.7,
                  }}
                  onClick={(e) => { e.stopPropagation(); setIsEditingDescription(true); }}
                >Edit</button>
              </div>
            )}

            {activeIssue.bugSla ? (
              <div className="issue-panel__section">
                <h2>Bug SLA</h2>
                <BugSlaBadge sla={activeIssue.bugSla} showMet />
              </div>
            ) : null}

            {/* Parent issue */}
            {activeIssue.parent ? (
              <div className="issue-panel__section">
                <h2>Parent issue</h2>
                <button
                  type="button"
                  className="issue-children__row"
                  onClick={() => navigate(`/issue/${activeIssue.parent!.id}`)}
                  style={{ display: 'flex', gap: 6, padding: '4px 0', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg)', fontSize: 15 }}
                >
                  {activeIssue.parent.identifier} — {activeIssue.parent.title}
                </button>
              </div>
            ) : null}

            {/* Sub-issues; new ones are created already placed (INV-744) */}
            <div className="issue-panel__section">
              <h2>Sub-issues · {activeIssue.children.nodes.length}</h2>
              {activeIssue.children.nodes.length > 0 ? (
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
              ) : null}
              <AddSubIssueButton issue={activeIssue} />
            </div>

            {/* Typed links: blockers, related, duplicates (INV-679). Same section as the board drawer. */}
            <IssueRelations key={activeIssue.id} issueId={activeIssue.id} onOpen={(issueId) => navigate(`/issue/${issueId}`)} />

            {/* Requests to agents, grouped by hand-off chain (INV-589/593/597) */}
            {(activeIssue.agentRequests ?? []).length > 0 ? (
              <div className="issue-panel__section">
                <h2>Requests · {activeIssue.agentRequests!.length}</h2>
                {groupChains(activeIssue.agentRequests!).map((chain) => (
                  <div key={chain[0]!.id} className="issue-children" role="list" style={{ marginBottom: 10 }}>
                    {chain.map((request, index) => (
                      <div key={request.id} id={`request-${request.id}`} role="listitem" className="issue-children__row" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span className="mono" style={{ fontSize: 11, color: 'var(--fg-faint)', minWidth: 44 }}>{request.hopCount === 0 ? 'asked' : `hop ${request.hopCount}`}</span>
                        {index === 0 && request.hopCount > 0 ? (
                          <span style={{ fontSize: 12, color: 'var(--warning, #b80)' }} title="The chain's earlier requests are not in this page's result">chain incomplete</span>
                        ) : null}
                        <ActorBadge actor={request.targetActor} onSelect={(picked) => navigate(`/agents/${picked}`)} />
                        <span className="mono" style={{ fontSize: 12, color: 'var(--fg-dim)' }}>{request.state}</span>
                        <span style={{ fontSize: 12, color: 'var(--fg-dim)' }} title={request.presenceDetail}>{request.presence}</span>
                        <span style={{ fontSize: 12, color: 'var(--fg-faint)' }} title="deadline">due {new Date(request.deadlineAt).toLocaleString()}</span>
                        {request.handedOffFromId ? (
                          <a href={`#request-${request.handedOffFromId}`} style={{ fontSize: 12 }}>← from previous</a>
                        ) : null}
                        {chain[index + 1] ? (
                          <a href={`#request-${chain[index + 1]!.id}`} style={{ fontSize: 12 }}>handed off →</a>
                        ) : null}
                        {request.answeredCommentId ? (
                          <a href={`#comment-${request.answeredCommentId}`} style={{ fontSize: 12 }}>answer</a>
                        ) : null}
                        {request.failureReason ? (
                          <span style={{ fontSize: 12, color: 'var(--fg-faint)' }}>{request.failureReason}</span>
                        ) : null}
                        {sessionViewer
                          && !['completed', 'failed', 'canceled'].includes(request.state)
                          && (request.targetActor.id === sessionViewer.id || sessionViewer.globalRole === 'ADMIN')
                          && answeringRequestId !== request.id ? (
                          <Btn variant="subtle" onClick={() => { setAnsweringRequestId(request.id); setAnswerBody(''); setAnswerOverride(''); setAnswerError(null); }}>
                            {request.targetActor.id === sessionViewer.id ? 'Answer' : 'Answer on their behalf'}
                          </Btn>
                        ) : null}
                        {answeringRequestId === request.id ? (
                          <form
                            style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}
                            onSubmit={async (event) => {
                              event.preventDefault();
                              setAnswerError(null);
                              try {
                                const needsOverride = request.targetActor.id !== sessionViewer?.id;
                                const result = await runAgentRequestAnswer({ variables: { input: {
                                  body: answerBody,
                                  overrideReason: needsOverride ? answerOverride : null,
                                  requestId: request.id,
                                } } });
                                if (!result.data?.agentRequestAnswer.success) throw new Error('not completed');
                                setAnsweringRequestId(null);
                                await refetch();
                              } catch (e) {
                                setAnswerError(e instanceof Error ? e.message : 'Could not submit the answer.');
                              }
                            }}
                          >
                            <textarea
                              value={answerBody}
                              onChange={(e) => setAnswerBody(e.target.value)}
                              placeholder="Your answer. It is posted in the request's thread and completes the request."
                              rows={3}
                              style={{ width: '100%', font: 'inherit', padding: 6 }}
                            />
                            {request.targetActor.id !== sessionViewer?.id ? (
                              <input
                                value={answerOverride}
                                onChange={(e) => setAnswerOverride(e.target.value)}
                                placeholder="Override reason (recorded on the audit): why you are answering for them"
                                style={{ font: 'inherit', padding: 6 }}
                              />
                            ) : null}
                            {answerError ? <span style={{ color: 'var(--danger, #c33)', fontSize: 12 }}>{answerError}</span> : null}
                            <div style={{ display: 'flex', gap: 6 }}>
                              <Btn variant="subtle" onClick={() => setAnsweringRequestId(null)}>Cancel</Btn>
                              <button type="submit" className="ui-action" disabled={answerBody.trim().length === 0}>Post answer and complete</button>
                            </div>
                          </form>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}

            {/* Activity */}
            <div className="issue-panel__activity-section">
              <div className="issue-panel__activity-header">Activity</div>
              <div className="issue-activity" aria-label="Issue activity">
                {activityEntries.map((entry) =>
                  entry.kind === 'comment' && entry.comment ? (
                    <div key={entry.id} id={`comment-${entry.id}`} className="issue-activity__comment">
                      <Avatar user={{ name: renderCommentAuthor(entry.comment) }} size={22} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="issue-activity__comment-meta">
                          <ActorBadge
                            actor={entry.comment.user}
                            onSelect={(picked) => navigate(`/agents/${picked}`)}
                          />
                          <span style={{ fontSize: 13, color: 'var(--fg-dim)' }}>
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
                      <span style={{ marginLeft: 'auto', fontSize: 13 }}>
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
                value={activeIssue.parent?.kind === 'PROJECT' ? activeIssue.parent.id : (activeIssue.projectId ?? '')}
                disabled={isSavingState}
                onChange={async (e) => {
                  const val = e.target.value;
                  const projectList = projectIssuesData?.issues?.nodes ?? [];
                  if (!val) {
                    await persistIssueUpdate(activeIssue, { parentId: null }, (current) => ({
                      ...current,
                      parent: null,
                      projectId: null,
                    }));
                  } else {
                    const selectedProj = projectList.find((p) => p.id === val);
                    await runWorkLink({
                      variables: {
                        fromId: val,
                        toId: activeIssue.id,
                        type: 'CONTAINS',
                      },
                    });
                    setLocalIssue((current) => current ? {
                      ...current,
                      parent: selectedProj ? {
                        id: selectedProj.id,
                        identifier: selectedProj.identifier,
                        title: selectedProj.title,
                        kind: 'PROJECT',
                      } : null,
                    } : null);
                  }
                }}
              >
                <option value="">No project</option>
                {(projectIssuesData?.issues?.nodes ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.identifier} — {p.title}</option>
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
                fontSize: 12, padding: '1px 5px', borderRadius: 3,
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

          <button
            type="button"
            className="issue-panel__action-btn"
            onClick={() => {
              const link = `[${activeIssue.identifier}](${window.location.href})`;
              void navigator.clipboard.writeText(link);
            }}
          >
            <span style={{ color: 'var(--fg-dim)', display: 'inline-flex' }}><IcoLink size={13} /></span>
            <span>Copy markdown link</span>
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

import { useMutation, useQuery } from '@apollo/client/react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { readStoredTeamKey } from '../board/utils';
import { IcoCheck, IcoClose } from '../components/Icons';
import { Btn } from '../components/Primitives';
import {
  CANDIDATES_PAGE_QUERY,
  ISSUE_SNOOZE_MUTATION,
  WORK_COMMIT_MUTATION,
  WORK_LINK_MUTATION,
  WORK_REJECT_MUTATION,
} from '../work/queries';
import type {
  CandidateWork,
  CandidatesPageQueryData,
  CandidatesPageQueryVariables,
  WorkCommitMutationData,
  WorkCommitMutationVariables,
  WorkRejectMutationData,
  WorkRejectMutationVariables,
  WorkUserSummary,
} from '../work/types';

const COMMIT_ERROR_MESSAGE = 'We could not commit this candidate. Check acceptance, owner, and revision.';
const REJECT_ERROR_MESSAGE = 'We could not reject this candidate. Please try again.';

function humanUsers(users: WorkUserSummary[]): WorkUserSummary[] {
  return users.filter((user) => user.actorKind !== 'AGENT' && user.actorKind !== 'SERVICE');
}

interface SnoozeMutationData {
  issueUpdate: { issue: { id: string } | null; success: boolean };
}

interface SnoozeMutationVariables {
  id: string;
  input: { expectedRevision: number; snoozedUntil?: string | null };
}

interface WorkLinkMutationData {
  workLink: { success: boolean };
}

interface WorkLinkMutationVariables {
  fromId: string;
  toId: string;
  type: 'DUPLICATE_OF';
}

function isSnoozed(candidate: CandidateWork): boolean {
  return Boolean(candidate.snoozedUntil && new Date(candidate.snoozedUntil).getTime() > Date.now());
}

// Mirrors the server-side commit routing in claim-service.ts: REVIEW/STARTED
// states are commit targets; BACKLOG only survives commit when the candidate
// was explicitly parked (initial_state=BACKLOG marker), otherwise commit
// corrects it to Ready.
function targetStateBadge(candidate: CandidateWork): { label: string; title: string } | null {
  const type = candidate.state?.type;
  if (type === 'REVIEW') {
    return { label: 'Target: In Review', title: 'Target state upon approval: In Review' };
  }
  if (type === 'STARTED') {
    return { label: 'Target: In Progress', title: 'Target state upon approval: In Progress' };
  }
  if (type === 'BACKLOG') {
    return candidate.source?.includes('initial_state=BACKLOG')
      ? { label: 'Target: Backlog', title: 'Target state upon approval: stays parked in Backlog' }
      : { label: 'Target: Ready', title: 'Target state upon approval: Ready (moved out of Backlog)' };
  }
  return null;
}

interface CommitGlanceState {
  committed: CandidateWork[];
  failCount: number;
}

function CommitGlanceDialog({
  glance,
  onClose,
}: {
  glance: CommitGlanceState;
  onClose: () => void;
}) {
  const teamKey = glance.committed[0]?.team.key ?? null;
  const groups = useMemo(() => {
    const byRepository = new Map<string | null, number>();
    for (const candidate of glance.committed) {
      const repository = candidate.repository ?? null;
      byRepository.set(repository, (byRepository.get(repository) ?? 0) + 1);
    }
    return Array.from(byRepository.entries());
  }, [glance.committed]);

  const successCount = glance.committed.length;

  return (
    <aside className="issue-panel" aria-label="Batch commit summary" aria-modal="true" role="dialog">
      <button
        type="button"
        className="issue-panel__backdrop"
        aria-label="Close commit summary"
        onClick={onClose}
      />
      <section className="issue-panel__frame commit-glance__frame">
        <div className="issue-panel__header">
          <div>
            <p className="app-shell__eyebrow">Involute</p>
            <h2>
              Committed {successCount} work item{successCount === 1 ? '' : 's'}
            </h2>
          </div>
          <button type="button" className="issue-panel__close" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="issue-panel__section">
          {glance.failCount > 0 ? (
            <p className="commit-glance__warning" role="alert">
              {glance.failCount} failed — they remain in the queue.
            </p>
          ) : null}
          <ul className="commit-glance__list">
            {groups.map(([repository, count]) => {
              const shortName = repository ? repository.split('/').pop() || repository : 'No project';
              const target = repository
                ? `/?team=${teamKey ?? ''}&project=${encodeURIComponent(repository)}`
                : `/?team=${teamKey ?? ''}&project=__none__`;
              return (
                <li key={repository ?? '__none__'}>
                  <Link className="commit-glance__project" to={target} onClick={onClose}>
                    <span className="commit-glance__name">{shortName}</span>
                    <span className="commit-glance__count">× {count}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="issue-panel__section commit-glance__footer">
          <Link
            className="ui-action ui-action--accent"
            to={`/?team=${teamKey ?? ''}`}
            onClick={onClose}
          >
            View all on board
          </Link>
          <button type="button" className="ui-action" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </aside>
  );
}

function CandidateCard({
  candidate,
  humans,
  otherCandidates,
  isSelected,
  onToggleSelect,
  onCommitted,
  onRejected,
  onRefresh,
}: {
  candidate: CandidateWork;
  humans: WorkUserSummary[];
  otherCandidates: CandidateWork[];
  isSelected?: boolean;
  onToggleSelect?: (id: string) => void;
  onCommitted: () => void;
  onRejected: () => void;
  onRefresh: () => void;
}) {
  const navigate = useNavigate();
  const [acceptance, setAcceptance] = useState(candidate.acceptance ?? '');
  const [assigneeId, setAssigneeId] = useState(candidate.assignee?.id ?? humans[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<'commit' | 'reject' | 'snooze' | 'duplicate' | null>(null);
  const [duplicateOfId, setDuplicateOfId] = useState('');
  const [runCommit] = useMutation<WorkCommitMutationData, WorkCommitMutationVariables>(WORK_COMMIT_MUTATION);
  const [runReject] = useMutation<WorkRejectMutationData, WorkRejectMutationVariables>(WORK_REJECT_MUTATION);
  const [runSnooze] = useMutation<SnoozeMutationData, SnoozeMutationVariables>(ISSUE_SNOOZE_MUTATION);
  const [runLink] = useMutation<WorkLinkMutationData, WorkLinkMutationVariables>(WORK_LINK_MUTATION);

  const snoozed = isSnoozed(candidate);

  async function handleSnooze(days: number | null) {
    setError(null);
    setPendingAction('snooze');
    try {
      const result = await runSnooze({
        variables: {
          id: candidate.id,
          input: {
            expectedRevision: candidate.revision,
            ...(days === null
              ? { snoozedUntil: null }
              : { snoozedUntil: new Date(Date.now() + days * 24 * 60 * 60_000).toISOString() }),
          },
        },
      });
      if (!result.data?.issueUpdate.success) {
        setError('We could not snooze this candidate. Please try again.');
        return;
      }
      onRefresh();
    } catch {
      setError('We could not snooze this candidate. Please try again.');
    } finally {
      setPendingAction(null);
    }
  }

  async function handleMarkDuplicate() {
    if (!duplicateOfId) return;
    setError(null);
    setPendingAction('duplicate');
    try {
      const result = await runLink({
        variables: { fromId: candidate.id, toId: duplicateOfId, type: 'DUPLICATE_OF' },
      });
      if (!result.data?.workLink.success) {
        setError('We could not mark this candidate as a duplicate. Please try again.');
        return;
      }
      onRefresh();
    } catch {
      setError('We could not mark this candidate as a duplicate. Please try again.');
    } finally {
      setPendingAction(null);
    }
  }

  async function handleCommit() {
    setError(null);
    setPendingAction('commit');
    try {
      const result = await runCommit({
        variables: {
          id: candidate.id,
          input: {
            expectedRevision: candidate.revision,
            ...(acceptance.trim() ? { acceptance: acceptance.trim() } : {}),
            ...(assigneeId ? { assigneeId } : {}),
          },
        },
      });

      if (!result.data?.workCommit.success || !result.data.workCommit.issue) {
        setError(COMMIT_ERROR_MESSAGE);
        return;
      }

      onCommitted();
    } catch {
      setError(COMMIT_ERROR_MESSAGE);
    } finally {
      setPendingAction(null);
    }
  }

  async function handleReject() {
    setError(null);
    setPendingAction('reject');
    try {
      const result = await runReject({
        variables: {
          id: candidate.id,
          input: {
            expectedRevision: candidate.revision,
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          },
        },
      });

      if (!result.data?.workReject.success || !result.data.workReject.issue) {
        setError(REJECT_ERROR_MESSAGE);
        return;
      }

      onRejected();
    } catch {
      setError(REJECT_ERROR_MESSAGE);
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <article
      className={`observation-card${isSelected ? ' observation-card--selected' : ''}`}
      aria-label={`${candidate.identifier} candidate`}
    >
      <header className="observation-card__header">
        {onToggleSelect ? (
          <label className="candidates-select-checkbox" title={`Select ${candidate.identifier}`}>
            <input
              type="checkbox"
              checked={isSelected ?? false}
              onChange={() => onToggleSelect(candidate.id)}
            />
          </label>
        ) : null}
        <button
          type="button"
          className="observation-card__id"
          onClick={() => navigate(`/work/${candidate.id}`)}
        >
          {candidate.identifier}
        </button>
        <span className="observation-card__status">{snoozed ? 'snoozed candidate' : 'candidate'}</span>
        {(() => {
          const badge = targetStateBadge(candidate);
          return badge ? (
            <span className="observation-card__status observation-card__status--target" title={badge.title}>
              {badge.label}
            </span>
          ) : null;
        })()}
        <span className="observation-card__meta">{candidate.team.key}</span>
        {candidate.repository ? (
          <span className="observation-card__meta observation-card__repo">{candidate.repository}</span>
        ) : null}
        <span className="observation-card__meta">rev {candidate.revision}</span>
      </header>
      <h2 className="observation-card__title">{candidate.title}</h2>
      {candidate.description ? <p className="observation-card__body">{candidate.description}</p> : null}
      <dl className="observation-contract">
        <div>
          <dt>Outcome</dt>
          <dd>{candidate.outcome || '—'}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{candidate.scope || '—'}</dd>
        </div>
        <div>
          <dt>Constraints</dt>
          <dd>{candidate.constraints || '—'}</dd>
        </div>
        <div>
          <dt>Verification</dt>
          <dd>{candidate.verification || '—'}</dd>
        </div>
      </dl>
      <label className="observation-field">
        <span>Acceptance</span>
        <textarea
          aria-label={`Acceptance for ${candidate.identifier}`}
          value={acceptance}
          onChange={(event) => setAcceptance(event.target.value)}
          rows={3}
        />
      </label>
      <label className="observation-field">
        <span>Human owner</span>
        <select
          aria-label={`Owner for ${candidate.identifier}`}
          value={assigneeId}
          onChange={(event) => setAssigneeId(event.target.value)}
        >
          <option value="">Select owner</option>
          {humans.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name ?? user.email ?? user.id}
            </option>
          ))}
        </select>
      </label>
      <label className="observation-field">
        <span>Reject reason</span>
        <input
          aria-label={`Reject reason for ${candidate.identifier}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Optional"
        />
      </label>
      {error ? (
        <p className="observation-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="observation-card__actions">
        <Btn
          variant="accent"
          icon={<IcoCheck size={12} />}
          disabled={pendingAction !== null || snoozed}
          onClick={() => void handleCommit()}
        >
          {pendingAction === 'commit' ? 'Committing…' : 'Commit'}
        </Btn>
        <Btn
          variant="danger"
          icon={<IcoClose size={12} />}
          disabled={pendingAction !== null}
          onClick={() => void handleReject()}
        >
          {pendingAction === 'reject' ? 'Rejecting…' : 'Reject'}
        </Btn>
        {snoozed ? (
          <Btn variant="ghost" disabled={pendingAction !== null} onClick={() => void handleSnooze(null)}>
            Wake now
          </Btn>
        ) : (
          <>
            <Btn variant="ghost" disabled={pendingAction !== null} onClick={() => void handleSnooze(7)}>
              Snooze 7d
            </Btn>
            <Btn variant="ghost" disabled={pendingAction !== null} onClick={() => void handleSnooze(30)}>
              Snooze 30d
            </Btn>
          </>
        )}
        <Btn variant="ghost" onClick={() => navigate(`/work/${candidate.id}`)}>
          Open context
        </Btn>
      </div>
      {!snoozed && otherCandidates.length > 0 ? (
        <label className="observation-field observation-field--inline">
          <span>Mark duplicate of</span>
          <select
            aria-label={`Mark ${candidate.identifier} as duplicate of`}
            value={duplicateOfId}
            onChange={(event) => setDuplicateOfId(event.target.value)}
          >
            <option value="">Select work</option>
            {otherCandidates.map((other) => (
              <option key={other.id} value={other.id}>
                {other.identifier} — {other.title}
              </option>
            ))}
          </select>
          <Btn
            variant="subtle"
            disabled={!duplicateOfId || pendingAction !== null}
            onClick={() => void handleMarkDuplicate()}
          >
            {pendingAction === 'duplicate' ? 'Linking…' : 'Link duplicate'}
          </Btn>
        </label>
      ) : null}
    </article>
  );
}

export function CandidatesPage() {
  const teamKey = readStoredTeamKey();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedProject = searchParams.get('project');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkAssigneeId, setBulkAssigneeId] = useState('');
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);
  const [bulkAction, setBulkAction] = useState<'commit' | 'reject' | null>(null);
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 });
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [commitGlance, setCommitGlance] = useState<CommitGlanceState | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState(false);

  const [runCommit] = useMutation<WorkCommitMutationData, WorkCommitMutationVariables>(WORK_COMMIT_MUTATION);
  const [runReject] = useMutation<WorkRejectMutationData, WorkRejectMutationVariables>(WORK_REJECT_MUTATION);

  const repositoryFilter = useMemo(() => {
    if (!selectedProject) return undefined;
    if (selectedProject === '__none__') {
      return { isNull: true };
    }
    return { eq: selectedProject };
  }, [selectedProject]);

  const { data, error, fetchMore, loading, refetch } = useQuery<
    CandidatesPageQueryData,
    CandidatesPageQueryVariables
  >(
    CANDIDATES_PAGE_QUERY,
    {
      variables: {
        first: 100,
        teamFilter: teamKey ? { key: { eq: teamKey } } : null,
        filter: {
          commitmentStatus: 'CANDIDATE',
          ...(teamKey ? { team: { key: { eq: teamKey } } } : {}),
          ...(repositoryFilter ? { repository: repositoryFilter } : {}),
        },
      },
    },
  );

  const humansByTeam = useMemo(() => {
    const result = new Map<string, WorkUserSummary[]>();
    for (const team of data?.teams.nodes ?? []) {
      const unique = new Map(
        humanUsers(team.memberships.nodes.map((membership) => membership.user)).map((user) => [user.id, user]),
      );
      result.set(team.id, Array.from(unique.values()));
    }
    return result;
  }, [data?.teams.nodes]);

  const allHumans = useMemo(() => {
    const all = Array.from(humansByTeam.values()).flat();
    const unique = new Map<string, WorkUserSummary>();
    for (const u of all) {
      if (!unique.has(u.id)) unique.set(u.id, u);
    }
    return Array.from(unique.values());
  }, [humansByTeam]);

  useEffect(() => {
    if (!bulkAssigneeId && allHumans.length > 0 && allHumans[0]) {
      setBulkAssigneeId(allHumans[0].id);
    }
  }, [allHumans, bulkAssigneeId]);

  const candidates = data?.issues.nodes ?? [];
  const candidateSummary = data?.candidateSummary;
  const summaryProjects = useMemo(() => candidateSummary?.projects ?? [], [candidateSummary?.projects]);
  const noRepoCount = candidateSummary?.noRepositoryCount ?? 0;
  const totalCandidateCount = candidateSummary?.totalCount ?? candidates.length;

  const repositories = useMemo(() => {
    if (summaryProjects.length > 0) {
      return summaryProjects.map((p) => p.repository);
    }
    const repos = new Set<string>();
    for (const c of candidates) {
      if (c.repository) repos.add(c.repository);
    }
    return Array.from(repos).sort();
  }, [summaryProjects, candidates]);

  const currentProjectTotal = useMemo(() => {
    if (!selectedProject) return totalCandidateCount;
    if (selectedProject === '__none__') return noRepoCount;
    const match = summaryProjects.find((p) => p.repository === selectedProject);
    return match ? match.totalCount : candidates.filter((c) => c.repository === selectedProject).length;
  }, [selectedProject, totalCandidateCount, noRepoCount, summaryProjects, candidates]);

  function selectProject(repo: string | null) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (repo) {
        next.set('project', repo);
      } else {
        next.delete('project');
      }
      return next;
    });
    setSelectedIds([]);
  }

  const snoozedCandidates = useMemo(() => candidates.filter(isSnoozed), [candidates]);
  const activeCandidates = useMemo(() => candidates.filter((c) => !isSnoozed(c)), [candidates]);

  const filteredActiveCandidates = useMemo(() => {
    if (!selectedProject) return activeCandidates;
    if (selectedProject === '__none__') return activeCandidates.filter((c) => !c.repository);
    return activeCandidates.filter((c) => c.repository === selectedProject);
  }, [activeCandidates, selectedProject]);

  const filteredSnoozedCandidates = useMemo(() => {
    if (!selectedProject) return snoozedCandidates;
    if (selectedProject === '__none__') return snoozedCandidates.filter((c) => !c.repository);
    return snoozedCandidates.filter((c) => c.repository === selectedProject);
  }, [snoozedCandidates, selectedProject]);

  const allVisibleSelected =
    filteredActiveCandidates.length > 0 &&
    filteredActiveCandidates.every((c) => selectedIds.includes(c.id));
  const someVisibleSelected =
    filteredActiveCandidates.some((c) => selectedIds.includes(c.id));

  function toggleSelect(id: string) {
    setSelectedIds((curr) =>
      curr.includes(id) ? curr.filter((item) => item !== id) : [...curr, id],
    );
  }

  function selectAllVisible() {
    const visibleIds = filteredActiveCandidates.map((c) => c.id);
    setSelectedIds((curr) => Array.from(new Set([...curr, ...visibleIds])));
  }

  function clearSelection() {
    setSelectedIds([]);
  }

  async function handleBatchCommit() {
    if (selectedIds.length === 0 || isBulkProcessing) return;
    setIsBulkProcessing(true);
    setBulkAction('commit');
    setBulkError(null);
    setBulkProgress({ done: 0, total: selectedIds.length });

    const toCommit = candidates.filter((c) => selectedIds.includes(c.id));
    let successCount = 0;
    let failCount = 0;
    const committedCandidates: CandidateWork[] = [];

    for (let i = 0; i < toCommit.length; i++) {
      const candidate = toCommit[i];
      if (!candidate) continue;
      const teamHumans = humansByTeam.get(candidate.team.id) ?? [];
      const assigneeId = bulkAssigneeId || candidate.assignee?.id || teamHumans[0]?.id || allHumans[0]?.id;
      const acceptance =
        candidate.acceptance && candidate.acceptance.trim() !== ''
          ? candidate.acceptance.trim()
          : `Accepted and committed for execution: ${candidate.title}`;

      try {
        await runCommit({
          variables: {
            id: candidate.id,
            input: {
              expectedRevision: candidate.revision,
              acceptance,
              ...(assigneeId ? { assigneeId } : {}),
            },
          },
        });
        successCount++;
        committedCandidates.push(candidate);
      } catch (err) {
        failCount++;
        console.error(`Failed to commit candidate ${candidate.identifier}:`, err);
      }
      setBulkProgress({ done: i + 1, total: toCommit.length });
    }

    setIsBulkProcessing(false);
    setBulkAction(null);
    setSelectedIds([]);
    if (failCount > 0) {
      setBulkError(`Committed ${successCount}, failed ${failCount}.`);
    }
    if (successCount > 0) {
      setCommitGlance({ committed: committedCandidates, failCount });
    }
    void refetch();
  }

  async function handleBatchReject() {
    if (selectedIds.length === 0 || isBulkProcessing) return;
    setIsBulkProcessing(true);
    setBulkAction('reject');
    setBulkError(null);
    setBulkProgress({ done: 0, total: selectedIds.length });

    const toReject = candidates.filter((c) => selectedIds.includes(c.id));
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < toReject.length; i++) {
      const candidate = toReject[i];
      if (!candidate) continue;
      try {
        await runReject({
          variables: {
            id: candidate.id,
            input: {
              expectedRevision: candidate.revision,
              reason: 'Batch rejected by reviewer',
            },
          },
        });
        successCount++;
      } catch (err) {
        failCount++;
        console.error(`Failed to reject candidate ${candidate.identifier}:`, err);
      }
      setBulkProgress({ done: i + 1, total: toReject.length });
    }

    setIsBulkProcessing(false);
    setBulkAction(null);
    setSelectedIds([]);
    if (failCount > 0) {
      setBulkError(`Rejected ${successCount}, failed ${failCount}.`);
    }
    void refetch();
  }

  const pageInfo = data?.issues.pageInfo;

  async function handleLoadMore() {
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return;
    setLoadingMore(true);
    setPaginationError(false);
    try {
      await fetchMore({
        variables: { after: pageInfo.endCursor },
        updateQuery: (previous, { fetchMoreResult }) => {
          const summary = fetchMoreResult.candidateSummary ?? previous.candidateSummary ?? null;
          return {
            ...fetchMoreResult,
            ...(summary !== undefined ? { candidateSummary: summary } : {}),
            teams: previous.teams,
            issues: {
              ...fetchMoreResult.issues,
              nodes: [...previous.issues.nodes, ...fetchMoreResult.issues.nodes],
            },
          };
        },
      });
    } catch {
      setPaginationError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="observation-page">
      <div className="page-header">
        <h1 className="page-header__title">Candidates</h1>
        <span className="mono observation-count">{currentProjectTotal}</span>
        <div style={{ flex: 1 }} />
        <span className="observation-hint">Proposed work waits here until a human commits it.</span>
      </div>

      {repositories.length > 0 || noRepoCount > 0 ? (
        <div className="board-project-pills" role="tablist" aria-label="Project switcher" style={{ padding: '0 24px 8px' }}>
          <button
            type="button"
            role="tab"
            aria-selected={!selectedProject}
            className={`board-project-pill${!selectedProject ? ' board-project-pill--active' : ''}`}
            onClick={() => selectProject(null)}
          >
            <span className="board-project-pill__name">All Projects</span>
            <span className="board-project-pill__count">{totalCandidateCount}</span>
          </button>
          {repositories.map((repo) => {
            const projectMeta = summaryProjects.find((p) => p.repository === repo);
            const count = projectMeta ? projectMeta.totalCount : candidates.filter((c) => c.repository === repo).length;
            const isActive = selectedProject === repo;
            return (
              <button
                key={repo}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`board-project-pill${isActive ? ' board-project-pill--active' : ''}`}
                onClick={() => selectProject(repo)}
              >
                <span className="board-project-pill__name">{repo}</span>
                <span className="board-project-pill__count">{count}</span>
              </button>
            );
          })}
          {noRepoCount > 0 ? (
            <button
              type="button"
              role="tab"
              aria-selected={selectedProject === '__none__'}
              className={`board-project-pill${selectedProject === '__none__' ? ' board-project-pill--active' : ''}`}
              onClick={() => selectProject('__none__')}
            >
              <span className="board-project-pill__name">No Repository</span>
              <span className="board-project-pill__count">{noRepoCount}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="page-content observation-content">
        {error ? (
          <div className="empty-state" role="alert">
            <h3>Could not load candidates</h3>
            <p>The request failed before the candidate queue could be read.</p>
            <Btn variant="subtle" onClick={() => void refetch()}>Retry</Btn>
          </div>
        ) : loading && candidates.length === 0 ? (
          <p className="observation-empty">Loading candidates…</p>
        ) : candidates.length === 0 ? (
          <div className="empty-state">
            <h3>No candidate work</h3>
            <p>Agents propose here. The board only shows committed issues.</p>
          </div>
        ) : (
          <div className="observation-list">
            {filteredActiveCandidates.length > 0 ? (
              <div className="candidates-toolbar">
                <label className="candidates-toolbar__select-all">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someVisibleSelected && !allVisibleSelected;
                    }}
                    onChange={(e) => {
                      if (e.target.checked) {
                        selectAllVisible();
                      } else {
                        clearSelection();
                      }
                    }}
                  />
                  <span>Select all visible ({filteredActiveCandidates.length})</span>
                </label>
                {selectedIds.length > 0 ? (
                  <button
                    type="button"
                    className="candidates-toolbar__clear-btn"
                    onClick={clearSelection}
                  >
                    Clear selection ({selectedIds.length})
                  </button>
                ) : null}
              </div>
            ) : null}

            {filteredActiveCandidates.map((candidate) => (
              <CandidateCard
                key={candidate.id}
                candidate={candidate}
                humans={humansByTeam.get(candidate.team.id) ?? []}
                otherCandidates={candidates.filter((other) => other.id !== candidate.id)}
                isSelected={selectedIds.includes(candidate.id)}
                onToggleSelect={toggleSelect}
                onCommitted={() => void refetch()}
                onRejected={() => void refetch()}
                onRefresh={() => void refetch()}
              />
            ))}

            {selectedIds.length > 0 ? (
              <div className="candidates-bulkbar">
                <div className="candidates-bulkbar__left">
                  <span className="candidates-bulkbar__count">
                    <strong>{selectedIds.length}</strong> selected
                  </span>
                  <label className="candidates-bulkbar__field">
                    <span>Owner:</span>
                    <select
                      value={bulkAssigneeId}
                      onChange={(e) => setBulkAssigneeId(e.target.value)}
                      aria-label="Batch commit owner"
                    >
                      {allHumans.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name ?? u.email ?? u.id}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="candidates-bulkbar__right">
                  {bulkError ? <span className="candidates-bulkbar__error">{bulkError}</span> : null}
                  <Btn
                    variant="accent"
                    icon={<IcoCheck size={14} />}
                    disabled={isBulkProcessing}
                    onClick={() => void handleBatchCommit()}
                  >
                    {isBulkProcessing && bulkAction === 'commit'
                      ? `Committing ${bulkProgress.done}/${bulkProgress.total}…`
                      : `Batch Commit (${selectedIds.length})`}
                  </Btn>
                  <Btn
                    variant="danger"
                    icon={<IcoClose size={14} />}
                    disabled={isBulkProcessing}
                    onClick={() => void handleBatchReject()}
                  >
                    {isBulkProcessing && bulkAction === 'reject'
                      ? `Rejecting ${bulkProgress.done}/${bulkProgress.total}…`
                      : `Batch Reject (${selectedIds.length})`}
                  </Btn>
                  <Btn variant="ghost" disabled={isBulkProcessing} onClick={clearSelection}>
                    Cancel
                  </Btn>
                </div>
              </div>
            ) : null}

            {filteredSnoozedCandidates.length > 0 ? (
              <>
                <h2 className="observation-section-title">
                  Snoozed ({filteredSnoozedCandidates.length})
                </h2>
                {filteredSnoozedCandidates.map((candidate) => (
                  <CandidateCard
                    key={candidate.id}
                    candidate={candidate}
                    humans={humansByTeam.get(candidate.team.id) ?? []}
                    otherCandidates={candidates.filter((other) => other.id !== candidate.id)}
                    isSelected={selectedIds.includes(candidate.id)}
                    onToggleSelect={toggleSelect}
                    onCommitted={() => void refetch()}
                    onRejected={() => void refetch()}
                    onRefresh={() => void refetch()}
                  />
                ))}
              </>
            ) : null}

            {paginationError ? (
              <div role="alert" style={{ marginTop: '16px' }}>
                <p>Could not load more candidates.</p>
                <Btn variant="subtle" disabled={loadingMore} onClick={() => void handleLoadMore()}>
                  Retry loading more
                </Btn>
              </div>
            ) : pageInfo?.hasNextPage ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '16px' }}>
                <span className="mono observation-hint" style={{ fontSize: '13px' }}>
                  Showing {candidates.length} of {currentProjectTotal} candidates
                  {currentProjectTotal > candidates.length ? ` (${currentProjectTotal - candidates.length} remaining)` : ''}
                </span>
                <Btn variant="subtle" aria-label="Load more" disabled={loadingMore} onClick={() => void handleLoadMore()}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Btn>
              </div>
            ) : candidates.length > 50 ? (
              <div style={{ marginTop: '16px' }}>
                <span className="mono observation-hint" style={{ fontSize: '13px' }}>
                  All {candidates.length} candidates loaded
                </span>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {commitGlance ? (
        <CommitGlanceDialog glance={commitGlance} onClose={() => setCommitGlance(null)} />
      ) : null}
    </div>
  );
}

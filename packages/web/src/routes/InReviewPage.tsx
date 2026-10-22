import { useMutation, useQuery } from '@apollo/client/react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { readStoredTeamKey } from '../board/utils';
import { IcoCheck, IcoClose, IcoFilter } from '../components/Icons';
import { TextInput } from '../components/controls';
import { PageBody, PageHeader, PageToolbar } from '../components/layout';
import { Btn } from '../components/Primitives';
import { ProjectFilterCombobox, type AvailableProject } from '../components/ProjectFilterCombobox';
import { BulkActionBar, EmptyState, InlineError, LoadingState } from '../components/status';
import { filtersToIql, joinIql, useWorkFilters, WorkFilterBar } from '../components/WorkFilterBar';
import { useListKeys } from '../components/useListKeys';
import { IN_REVIEW_PAGE_QUERY, IN_REVIEW_PROJECTS_QUERY, WORK_REVIEW_MUTATION } from '../work/queries';
import type {
  InReviewPageQueryData,
  InReviewPageQueryVariables,
  InReviewWork,
  WorkReviewMutationData,
  WorkReviewMutationVariables,
} from '../work/types';

const DEFAULT_IQL = 'state:"In Review"';
/** `?project=` value for work with no repository (same as /candidates). */
const NO_REPOSITORY = '__none__';
const IN_REVIEW_VIEW_STORAGE_KEY = 'involute.inReview.iqlQuery';
const BULK_ACCEPT_ERROR = 'Some selected items could not be accepted. Refresh and retry failed rows.';
const BULK_REJECT_ERROR = 'Some selected items could not be returned. Refresh and retry failed rows.';

function readStoredIql(): string {
  try {
    const stored = localStorage.getItem(IN_REVIEW_VIEW_STORAGE_KEY);
    return stored && stored.trim() ? stored : DEFAULT_IQL;
  } catch {
    return DEFAULT_IQL;
  }
}

function writeStoredIql(query: string) {
  try {
    localStorage.setItem(IN_REVIEW_VIEW_STORAGE_KEY, query);
  } catch {
    /* ignore quota / private mode */
  }
}

/** Days waiting in Review, as people say it (INV-1002). */
function formatWaitDays(waitMs: number): string {
  const days = Math.floor(waitMs / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(waitMs / 3_600_000);
  return hours >= 1 ? `${hours}h` : '<1h';
}

function buildFilter(teamKey: string | null, repository: string | null = null): InReviewPageQueryVariables['filter'] {
  return {
    commitmentStatus: 'COMMITTED',
    // By type: an admin may rename the state (INV-797).
    state: { type: { eq: 'REVIEW' } },
    ...(teamKey ? { team: { key: { eq: teamKey } } } : {}),
    // One project at a time, so "Select all" never reaches into another (INV-1076).
    ...(repository === NO_REPOSITORY ? { repository: { isNull: true } } : repository ? { repository: { eq: repository } } : {}),
  } as InReviewPageQueryVariables['filter'];
}

export function InReviewPage() {
  const navigate = useNavigate();
  const teamKey = readStoredTeamKey();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedProject = searchParams.get('project');
  const workFilters = useWorkFilters(() => {
    setSelectedIds([]);
    setBulkError(null);
  });
  const filterIql = filtersToIql(workFilters.filters);
  const [iqlDraft, setIqlDraft] = useState(readStoredIql);
  const [activeIql, setActiveIql] = useState(readStoredIql);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Any change of what is listed — a filter, the project, or Back/Forward — drops
  // the selection, so a bulk decision never applies to rows no longer shown.
  useEffect(() => {
    setSelectedIds([]);
  }, [filterIql, selectedProject]);
  const [bulkReason, setBulkReason] = useState('');
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<'accept' | 'reject' | null>(null);
  // One item at a time (INV-790): accept or return a single card.
  const [itemPending, setItemPending] = useState<Record<string, 'ACCEPTED' | 'REJECTED'>>({});
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState(false);

  const queryVariables: InReviewPageQueryVariables = {
    first: 50,
    filter: buildFilter(teamKey, selectedProject),
    query: joinIql(activeIql, filterIql) || null,
  };
  const { data: projectData } = useQuery<{ issues?: { nodes: Array<{ id: string; repository: string | null }>; pageInfo?: { hasNextPage: boolean } } }>(IN_REVIEW_PROJECTS_QUERY, {
    variables: { filter: buildFilter(teamKey), query: joinIql(activeIql, filterIql) || null },
    fetchPolicy: 'cache-and-network',
  });
  const projectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of projectData?.issues?.nodes ?? []) {
      if (node.repository) counts.set(node.repository, (counts.get(node.repository) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [projectData]);
  const noRepoCount = useMemo(
    () => (projectData?.issues?.nodes ?? []).filter((node) => !node.repository).length,
    [projectData],
  );
  const projectOptions = useMemo<AvailableProject[]>(() => {
    const entries = selectedProject && selectedProject !== NO_REPOSITORY && !projectCounts.some(([repo]) => repo === selectedProject)
      ? [...projectCounts, [selectedProject, 0] as [string, number]]
      : projectCounts;
    return entries.map(([repo, count]) => ({ id: repo, identifier: '', name: repo, key: repo, issueCount: count }));
  }, [projectCounts, selectedProject]);
  function selectProject(repo: string | null) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (repo) next.set('project', repo);
      else next.delete('project');
      return next;
    });
    setSelectedIds([]);
    setBulkError(null);
  }

  const { data, error, fetchMore, loading, refetch } = useQuery<
    InReviewPageQueryData,
    InReviewPageQueryVariables
  >(IN_REVIEW_PAGE_QUERY, {
    variables: queryVariables,
    fetchPolicy: 'cache-and-network',
  });

  const [runReview] = useMutation<WorkReviewMutationData, WorkReviewMutationVariables>(WORK_REVIEW_MUTATION);

  const items: InReviewWork[] = (data?.issues?.nodes ?? []) as InReviewWork[];
  const pageInfo = data?.issues?.pageInfo;
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedItems = useMemo(
    () => items.filter((item) => !item.deliveryRootId && selectedIdSet.has(item.id)),
    [items, selectedIdSet],
  );

  function applyIqlFilter() {
    const next = iqlDraft.trim() || DEFAULT_IQL;
    setIqlDraft(next);
    setActiveIql(next);
    writeStoredIql(next);
    setSelectedIds([]);
    setBulkError(null);
  }

  function resetInReviewFilter() {
    setIqlDraft(DEFAULT_IQL);
    setActiveIql(DEFAULT_IQL);
    writeStoredIql(DEFAULT_IQL);
    setSelectedIds([]);
    setBulkError(null);
  }

  function toggleSelection(item: InReviewWork) {
    if (item.deliveryRootId) return;
    setSelectedIds((current) =>
      current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id],
    );
  }

  function selectAllVisible() {
    setSelectedIds(items.filter((item) => !item.deliveryRootId).map((item) => item.id));
  }

  function clearSelection() {
    setSelectedIds([]);
  }

  // J/K, X, ⇧A, ⇧X, Enter like the board (INV-1087).
  const listKeys = useListKeys(items, {
    onToggle: toggleSelection,
    onSelectAll: selectAllVisible,
    onClear: clearSelection,
    onOpen: (item) => navigate(`/issue/${item.id}`),
  });

  async function handleLoadMore() {
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return;
    setLoadingMore(true);
    setPaginationError(false);
    try {
      await fetchMore({
        variables: { after: pageInfo.endCursor },
        updateQuery: (previous, { fetchMoreResult }) => ({
          ...fetchMoreResult,
          issues: {
            ...fetchMoreResult.issues,
            nodes: [...previous.issues.nodes, ...fetchMoreResult.issues.nodes],
          },
        }),
      });
    } catch {
      setPaginationError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  async function reviewOne(item: InReviewWork, decision: 'ACCEPTED' | 'REJECTED') {
    setItemErrors(({ [item.id]: _cleared, ...rest }) => rest);
    setItemPending((current) => ({ ...current, [item.id]: decision }));
    try {
      const result = await runReview({ variables: { id: item.id, input: { decision, expectedRevision: item.revision } } });
      if (!result.data?.workReview.success || !result.data.workReview.issue) {
        setItemErrors((current) => ({
          ...current,
          [item.id]: result.data?.workReview.message ?? (decision === 'ACCEPTED' ? BULK_ACCEPT_ERROR : BULK_REJECT_ERROR),
        }));
        return;
      }
      setSelectedIds((current) => current.filter((id) => id !== item.id));
      await refetch();
    } catch {
      setItemErrors((current) => ({ ...current, [item.id]: decision === 'ACCEPTED' ? BULK_ACCEPT_ERROR : BULK_REJECT_ERROR }));
    } finally {
      setItemPending(({ [item.id]: _done, ...rest }) => rest);
    }
  }

  async function applyBulkReview(decision: 'ACCEPTED' | 'REJECTED') {
    if (selectedItems.length === 0 || pendingAction) return;

    setBulkError(null);
    setPendingAction(decision === 'ACCEPTED' ? 'accept' : 'reject');

    const reason = bulkReason.trim();
    const results = await Promise.allSettled(
      selectedItems.map((item) =>
        runReview({
          variables: {
            id: item.id,
            input: {
              decision,
              expectedRevision: item.revision,
              ...(reason ? { reason } : {}),
            },
          },
        }),
      ),
    );

    let hadFailure = false;
    const succeededIds: string[] = [];

    results.forEach((result, index) => {
      const item = selectedItems[index]!;
      if (
        result.status === 'fulfilled' &&
        result.value.data?.workReview.success &&
        result.value.data.workReview.issue
      ) {
        succeededIds.push(item.id);
        return;
      }
      hadFailure = true;
    });

    setSelectedIds((current) => current.filter((id) => !succeededIds.includes(id)));
    setPendingAction(null);

    if (succeededIds.length > 0) {
      await refetch();
    }

    if (hadFailure) {
      setBulkError(decision === 'ACCEPTED' ? BULK_ACCEPT_ERROR : BULK_REJECT_ERROR);
    } else {
      setBulkReason('');
    }
  }

  return (
    <div className="observation-page">
      <PageHeader
        title="In Review"
        count={items.length}
        hint="Human bulk accept or return - audited via workReview. Agents cannot silently Done."
      />

      <PageToolbar
        aria-label="In Review filters"
        projects={
          <ProjectFilterCombobox
            projects={projectOptions}
            selectedProjectKey={selectedProject}
            totalCount={projectData?.issues?.nodes?.length ?? 0}
            onSelectProject={selectProject}
            showQuickPills
            extraOptions={noRepoCount > 0 || selectedProject === NO_REPOSITORY ? [{ key: NO_REPOSITORY, label: 'No repository', count: noRepoCount }] : []}
          />
        }
        filters={<WorkFilterBar {...workFilters} />}
        view={
          <div className="in-review-filter" role="group" aria-label="In Review filter">
            <span className="in-review-filter__label">
              <IcoFilter size={12} /> IQL / view
            </span>
            <TextInput
              size="sm"
              className="in-review-filter__input"
              aria-label="In Review IQL filter"
              value={iqlDraft}
              onChange={(event) => setIqlDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  applyIqlFilter();
                }
              }}
              placeholder='state:"In Review"'
            />
            <Btn variant="subtle" size="sm" onClick={applyIqlFilter}>
              Apply filter
            </Btn>
            <Btn variant="ghost" size="sm" onClick={resetInReviewFilter}>
              Reset to In Review
            </Btn>
            <span className="page-note">Active: {activeIql}</span>
          </div>
        }
      />

      <PageBody>
        {bulkError && selectedIds.length === 0 ? <InlineError>{bulkError}</InlineError> : null}

        {error ? (
          <div role="alert">
            <EmptyState
              title="Could not load In Review queue"
              body="Confirm the API server is running, then retry."
              action={
                <Btn variant="subtle" onClick={() => void refetch()}>
                  Retry
                </Btn>
              }
            />
          </div>
        ) : loading && items.length === 0 ? (
          <LoadingState>Loading In Review...</LoadingState>
        ) : items.length === 0 ? (
          <EmptyState title="No work in review" body="Completed agent runs land here until a human accepts or returns them." />
        ) : (
          <div className="observation-list" role="list" aria-label="In Review items">
            <div className="in-review-list-toolbar">
              <Btn variant="ghost" size="sm" onClick={selectAllVisible} disabled={!items.some((item) => !item.deliveryRootId)}>
                Select all visible
              </Btn>
            </div>
            {items.map((item) => {
              const checked = selectedIdSet.has(item.id);
              return (
                <article
                  key={item.id}
                  className={`observation-card${checked ? ' observation-card--selected' : ''}${listKeys.focusedId === item.id ? ' observation-card--focused' : ''}`}
                  data-list-key-id={item.id}
                  aria-current={listKeys.focusedId === item.id ? 'true' : undefined}
                  aria-label={`${item.identifier} in review`}
                  role="listitem"
                >
                  <header className="observation-card__header">
                    {!item.deliveryRootId ? <label className="in-review-select">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSelection(item)}
                        aria-label={`Select ${item.identifier}`}
                      />
                    </label> : null}
                    <button
                      type="button"
                      className="observation-card__id"
                      onClick={() => navigate(`/work/${item.id}`)}
                    >
                      {item.identifier}
                    </button>
                    <span className="observation-card__status">in review</span>
                    {item.reviewWait ? (
                      <span className={`observation-card__meta${item.reviewWait.overdue ? ' observation-card__meta--overdue' : ''}`} title={`In Review since ${item.reviewWait.since}`}>
                        waiting {formatWaitDays(item.reviewWait.waitMs)}{item.reviewWait.overdue ? ' · overdue' : ''}
                      </span>
                    ) : null}
                    {item.autoAccept && !item.autoAccept.accepted ? (
                      <span className="observation-card__meta" title={`Auto-Accept Gate, ${item.autoAccept.createdAt}`}>
                        not auto-accepted: {item.autoAccept.reasons.join('; ')}
                      </span>
                    ) : null}
                    <span className="observation-card__meta">{item.team.key}</span>
                    <span className="observation-card__meta">rev {item.revision}</span>
                    {item.pendingContractAmendment ? (
                      <button
                        type="button"
                        className="observation-card__status"
                        title="An agent proposed a change to this contract; decide it before reviewing against the old one."
                        onClick={() => navigate(`/issue/${item.id}#contract`)}
                      >
                        contract change proposed
                      </button>
                    ) : null}
                    {item.assignee ? (
                      <span className="observation-card__meta">
                        {item.assignee.name ?? item.assignee.email}
                      </span>
                    ) : null}
                  </header>
                  <h2 className="observation-card__title">{item.title}</h2>
                  {item.description ? <p className="observation-card__body">{item.description}</p> : null}
                  <dl className="observation-contract">
                    <div>
                      <dt>Acceptance</dt>
                      <dd>{item.acceptance || '-'}</dd>
                    </div>
                    <div>
                      <dt>Verification</dt>
                      <dd>{item.verification || '-'}</dd>
                    </div>
                    <div>
                      <dt>Outcome</dt>
                      <dd>{item.outcome || '-'}</dd>
                    </div>
                    <div>
                      <dt>Repository</dt>
                      <dd>{item.repository || '-'}</dd>
                    </div>
                  </dl>
                  {itemErrors[item.id] ? <InlineError>{itemErrors[item.id]}</InlineError> : null}
                  <div className="observation-card__actions">
                    {item.deliveryRootId ? <Btn variant="accent" onClick={() => navigate(`/work/${item.deliveryRootId}`)}>Review delivery package</Btn> : <>
                    <Btn
                      variant="accent"
                      icon={<IcoCheck size={12} />}
                      disabled={Boolean(itemPending[item.id]) || pendingAction !== null}
                      onClick={() => void reviewOne(item, 'ACCEPTED')}
                    >
                      {itemPending[item.id] === 'ACCEPTED' ? 'Accepting...' : 'Accept'}
                    </Btn>
                    <Btn
                      variant="danger"
                      icon={<IcoClose size={12} />}
                      disabled={Boolean(itemPending[item.id]) || pendingAction !== null}
                      onClick={() => void reviewOne(item, 'REJECTED')}
                    >
                      {itemPending[item.id] === 'REJECTED' ? 'Returning...' : 'Return'}
                    </Btn>
                    </>}
                    <Btn variant="ghost" onClick={() => navigate(`/work/${item.id}`)}>
                      Open context
                    </Btn>
                  </div>
                </article>
              );
            })}
            {paginationError ? (
              <div role="alert">
                <InlineError role="none">Could not load more In Review items.</InlineError>
                <Btn variant="subtle" disabled={loadingMore} onClick={() => void handleLoadMore()}>
                  Retry loading more
                </Btn>
              </div>
            ) : pageInfo?.hasNextPage ? (
              <Btn variant="subtle" disabled={loadingMore} onClick={() => void handleLoadMore()}>
                {loadingMore ? 'Loading...' : 'Load more'}
              </Btn>
            ) : null}
          </div>
        )}

        <BulkActionBar
          aria-label="Bulk review actions"
          count={selectedIds.length}
          onClear={clearSelection}
          status={
            bulkError ? <InlineError>{bulkError}</InlineError> : <span>Bulk actions call workReview (human-audited)</span>
          }
        >
          <TextInput
            size="sm"
            aria-label="Bulk review reason"
            value={bulkReason}
            onChange={(event) => setBulkReason(event.target.value)}
            placeholder="Reason (optional decision note)"
          />
          <Btn
            variant="accent"
            icon={<IcoCheck size={12} />}
            disabled={pendingAction !== null}
            onClick={() => void applyBulkReview('ACCEPTED')}
          >
            {pendingAction === 'accept' ? 'Accepting...' : 'Bulk accept'}
          </Btn>
          <Btn
            variant="danger"
            icon={<IcoClose size={12} />}
            disabled={pendingAction !== null}
            onClick={() => void applyBulkReview('REJECTED')}
          >
            {pendingAction === 'reject' ? 'Returning...' : 'Bulk reject / return'}
          </Btn>
        </BulkActionBar>
      </PageBody>
    </div>
  );
}

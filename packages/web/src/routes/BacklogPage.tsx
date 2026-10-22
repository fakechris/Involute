import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { IssueSummary, TeamSummary, UserSummary } from '../board/types';
import { openWorkSearch } from '../board/utils';
import { SAVED_VIEWS_ACCOUNT_EVENT } from '../lib/saved-views-account';
import {
  applyBacklogViewState,
  APPLY_BACKLOG_VIEW_EVENT,
  getDefaultBacklogViewState,
  readSavedBacklogViews,
  readStoredBacklogViewState,
  type ApplyBacklogViewDetail,
  type BacklogViewState,
  type SavedBacklogView,
  writeSavedBacklogViews,
  writeStoredBacklogViewState,
} from '../backlog/views';
import { FilterChip, FilterMenu, FilterSearch, SavedViewControl, SortControl } from '../components/filters';
import { PageBody, PageToolbar } from '../components/layout';
import { EmptyState, LoadingState } from '../components/status';
import { WorkFilterBar, useWorkFilters } from '../components/WorkFilterBar';

interface BacklogPageProps {
  issues: IssueSummary[];
  labels: Array<{
    id: string;
    name: string;
  }>;
  selectedTeam: TeamSummary | null;
  users: UserSummary[];
  onSelectIssue: (issue: IssueSummary) => void;
  /** The Board's project combobox, shown in the toolbar's `projects` slot. */
  projectFilter?: ReactNode | undefined;
  /** Notices from the Board (partial load, save errors), under the toolbar. */
  notices?: ReactNode | undefined;
  /** The Board's first page is still loading. */
  loading?: boolean | undefined;
}

export function BacklogPage({
  issues,
  labels,
  selectedTeam,
  users,
  onSelectIssue,
  projectFilter,
  notices,
  loading = false,
}: BacklogPageProps) {
  const workFilterState = useWorkFilters();
  const teamKey = selectedTeam?.key ?? null;
  const [viewState, setViewState] = useState<BacklogViewState>(() => readStoredBacklogViewState(teamKey));
  const [savedViews, setSavedViews] = useState<SavedBacklogView[]>(() => readSavedBacklogViews(teamKey));
  const [activeSavedViewId, setActiveSavedViewId] = useState<string>('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    setViewState(readStoredBacklogViewState(teamKey));
    setSavedViews(readSavedBacklogViews(teamKey));
    setActiveSavedViewId('');
  }, [teamKey]);

  // The signed-in account's copy, once the session says who that is (INV-1194).
  useEffect(() => {
    function reloadSavedViews() {
      setSavedViews(readSavedBacklogViews(teamKey));
    }
    window.addEventListener(SAVED_VIEWS_ACCOUNT_EVENT, reloadSavedViews);
    return () => window.removeEventListener(SAVED_VIEWS_ACCOUNT_EVENT, reloadSavedViews);
  }, [teamKey]);

  useEffect(() => {
    function handleApplyBacklogView(event: Event) {
      const detail =
        event instanceof CustomEvent && event.detail
          ? (event.detail as ApplyBacklogViewDetail)
          : null;

      if (!detail) {
        return;
      }

      setViewState(detail.state);
      setActiveSavedViewId(detail.viewId ?? '');
    }

    window.addEventListener(APPLY_BACKLOG_VIEW_EVENT, handleApplyBacklogView as EventListener);

    return () => {
      window.removeEventListener(APPLY_BACKLOG_VIEW_EVENT, handleApplyBacklogView as EventListener);
    };
  }, []);

  useEffect(() => {
    writeStoredBacklogViewState(teamKey, viewState);
  }, [teamKey, viewState]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;

      const isTypingField =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.getAttribute('contenteditable') === 'true');

      if (isTypingField || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (event.key === '/') {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const filteredIssues = useMemo(
    () => applyBacklogViewState(issues, viewState, users),
    [issues, users, viewState],
  );

  function toggleFilterValue(key: 'stateIds' | 'assigneeIds' | 'labelIds', value: string) {
    setViewState((currentState) => {
      const currentValues = currentState[key];

      return {
        ...currentState,
        [key]: currentValues.includes(value)
          ? currentValues.filter((entry) => entry !== value)
          : [...currentValues, value],
      };
    });
  }

  function resetViewState() {
    setViewState(getDefaultBacklogViewState());
    setActiveSavedViewId('');
  }

  function saveCurrentView() {
    if (!teamKey) {
      return;
    }

    const viewName = window.prompt('Save backlog view as', selectedTeam ? `${selectedTeam.name} view` : 'Saved view');
    const trimmedName = viewName?.trim();

    if (!trimmedName) {
      return;
    }

    const nextView: SavedBacklogView = {
      id: createSavedViewId(),
      name: trimmedName,
      state: viewState,
    };
    const nextSavedViews = [nextView, ...savedViews].slice(0, 12);
    setSavedViews(nextSavedViews);
    setActiveSavedViewId(nextView.id);
    writeSavedBacklogViews(teamKey, nextSavedViews);
  }

  function loadSavedView(nextViewId: string) {
    setActiveSavedViewId(nextViewId);

    if (!nextViewId) {
      setViewState(readStoredBacklogViewState(teamKey));
      return;
    }

    const nextView = savedViews.find((view) => view.id === nextViewId);

    if (nextView) {
      setViewState(nextView.state);
    }
  }

  function deleteSavedView() {
    if (!teamKey || !activeSavedViewId) {
      return;
    }

    const nextSavedViews = savedViews.filter((view) => view.id !== activeSavedViewId);
    setSavedViews(nextSavedViews);
    setActiveSavedViewId('');
    writeSavedBacklogViews(teamKey, nextSavedViews);
  }

  const teamStates = selectedTeam?.states.nodes ?? [];
  const userName = (userId: string) => {
    if (userId === 'unassigned') return 'Unassigned';
    const user = users.find((candidate) => candidate.id === userId);
    return user?.name ?? user?.email ?? userId;
  };
  const toggleAndUnload = (key: 'stateIds' | 'assigneeIds' | 'labelIds', value: string) => {
    toggleFilterValue(key, value);
    setActiveSavedViewId('');
  };

  // The same toolbar pieces as the Board (INV-1314): projects → filters → view.
  const filters = (
    <>
      <FilterSearch
        ref={searchInputRef}
        aria-label="Search backlog issues"
        placeholder="Filter by identifier, title, or description"
        value={viewState.query}
        shortcut="/"
        onChange={(query) => {
          setViewState((currentState) => ({ ...currentState, query }));
          setActiveSavedViewId('');
        }}
        trailing={(
          // The box filters what the list loaded; this searches everything (INV-925).
          <button type="button" className="search-all-work" onClick={() => openWorkSearch(viewState.query.trim())}>
            Search all work →
          </button>
        )}
      />
      <WorkFilterBar {...workFilterState} />
      <FilterMenu
        label="States"
        options={teamStates.map((state) => ({ value: state.id, label: state.name }))}
        selected={viewState.stateIds}
        onToggle={(stateId) => toggleAndUnload('stateIds', stateId)}
      />
      <FilterMenu
        label="Labels"
        options={labels.map((label) => ({ value: label.id, label: label.name }))}
        selected={viewState.labelIds}
        onToggle={(labelId) => toggleAndUnload('labelIds', labelId)}
      />
      <FilterMenu
        label="Assignees"
        options={[
          { value: 'unassigned', label: 'Unassigned' },
          ...users.map((user) => ({ value: user.id, label: user.name ?? user.email ?? user.id })),
        ]}
        selected={viewState.assigneeIds}
        onToggle={(assigneeId) => toggleAndUnload('assigneeIds', assigneeId)}
      />
      {viewState.stateIds.map((stateId) => {
        const stateName = teamStates.find((state) => state.id === stateId)?.name ?? stateId;
        return (
          <FilterChip key={stateId} removeLabel={`Remove State: ${stateName}`} onRemove={() => toggleAndUnload('stateIds', stateId)}>
            State: {stateName}
          </FilterChip>
        );
      })}
      {viewState.assigneeIds.map((assigneeId) => (
        <FilterChip key={assigneeId} removeLabel={`Remove Assignee: ${userName(assigneeId)}`} onRemove={() => toggleAndUnload('assigneeIds', assigneeId)}>
          Assignee: {userName(assigneeId)}
        </FilterChip>
      ))}
      {viewState.labelIds.map((labelId) => {
        const labelName = labels.find((label) => label.id === labelId)?.name ?? labelId;
        return (
          <FilterChip key={labelId} removeLabel={`Remove Label: ${labelName}`} onRemove={() => toggleAndUnload('labelIds', labelId)}>
            Label: {labelName}
          </FilterChip>
        );
      })}
      <span className="page-note">
        {filteredIssues.length} visible
        {activeSavedViewId ? ` · Loaded view: ${savedViews.find((view) => view.id === activeSavedViewId)?.name ?? 'Unknown'}` : ''}
      </span>
    </>
  );

  const view = (
    <>
      <SortControl
        sort={{
          'aria-label': 'Sort backlog by',
          value: viewState.sortField,
          options: [
            { value: 'identifier', label: 'Identifier' },
            { value: 'title', label: 'Title' },
            { value: 'state', label: 'State' },
            { value: 'assignee', label: 'Assignee' },
            { value: 'updatedAt', label: 'Updated' },
            { value: 'createdAt', label: 'Created' },
          ],
          onChange: (sortField: BacklogViewState['sortField']) => {
            setViewState((currentState) => ({ ...currentState, sortField }));
            setActiveSavedViewId('');
          },
        }}
        direction={{
          'aria-label': 'Sort backlog direction',
          value: viewState.sortDirection,
          onChange: (sortDirection) => {
            setViewState((currentState) => ({ ...currentState, sortDirection }));
            setActiveSavedViewId('');
          },
        }}
      />
      <SavedViewControl
        aria-label="Load saved backlog view"
        placeholder="Current filters"
        views={savedViews}
        activeViewId={activeSavedViewId}
        onLoad={loadSavedView}
        onSave={saveCurrentView}
        onDelete={deleteSavedView}
        onClear={resetViewState}
      />
    </>
  );

  return (
    <>
      <PageToolbar aria-label="Backlog filters" projects={projectFilter} filters={filters} view={view} />
      {notices}
      <PageBody width="full" padding="none">
        {loading ? (
          <div className="backlog-surface backlog-surface--padded">
            <LoadingState>Loading board…</LoadingState>
          </div>
        ) : filteredIssues.length > 0 ? (
          <div className="backlog-surface">
            <table className="backlog-table">
              <thead>
                <tr>
                  <th scope="col">Identifier</th>
                  <th scope="col">Title</th>
                  <th scope="col">Project</th>
                  <th scope="col">State</th>
                  <th scope="col">Labels</th>
                  <th scope="col">Assignee</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {filteredIssues.map((issue) => (
                  <tr key={issue.id}>
                    <td>{issue.identifier}</td>
                    <td>
                      <button
                        type="button"
                        className="backlog-table__issue-link"
                        onClick={() => onSelectIssue(issue)}
                      >
                        {issue.title}
                      </button>
                    </td>
                    <td>
                      {issue.repository ? (
                        <span className="issue-card__repo-badge" title={issue.repository}>
                          {issue.repository.includes('/') ? issue.repository.split('/')[1] : issue.repository}
                        </span>
                      ) : (
                        <span className="backlog-table__none">—</span>
                      )}
                    </td>
                    <td>{issue.state.name}</td>
                    <td>
                      {issue.labels.nodes.length > 0
                        ? [...new Set(issue.labels.nodes.map((label) => label.name))].join(', ')
                        : '—'}
                    </td>
                    <td>{issue.assignee?.name ?? issue.assignee?.email ?? 'Unassigned'}</td>
                    <td>{formatBacklogTimestamp(issue.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No issues match the current backlog view." />
        )}
      </PageBody>
    </>
  );
}

function formatBacklogTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
  }).format(new Date(value));
}

function createSavedViewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `backlog-view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

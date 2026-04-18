import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { IssueSummary, TeamSummary, UserSummary } from '../board/types';
import {
  applyBacklogViewState,
  APPLY_BACKLOG_VIEW_EVENT,
  buildBacklogViewSummary,
  getDefaultBacklogViewState,
  readSavedBacklogViews,
  readStoredBacklogViewState,
  type ApplyBacklogViewDetail,
  type BacklogViewState,
  type SavedBacklogView,
  writeSavedBacklogViews,
  writeStoredBacklogViewState,
} from '../backlog/views';

interface BacklogPageProps {
  issues: IssueSummary[];
  labels: Array<{
    id: string;
    name: string;
  }>;
  selectedTeam: TeamSummary | null;
  users: UserSummary[];
  onSelectIssue: (issue: IssueSummary) => void;
}

export function BacklogPage({
  issues,
  labels,
  selectedTeam,
  users,
  onSelectIssue,
}: BacklogPageProps) {
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
  const activeFilterTokens = useMemo(
    () => buildBacklogViewSummary(viewState, selectedTeam, users, labels),
    [labels, selectedTeam, users, viewState],
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

  return (
    <main className="backlog-page">
      <section className="backlog-toolbar">
        <div className="backlog-toolbar__primary">
          <label className="field-stack backlog-toolbar__search">
            <span>Search</span>
            <input
              ref={searchInputRef}
              aria-label="Search backlog issues"
              placeholder="Filter by identifier, title, or description"
              value={viewState.query}
              onChange={(event) => {
                setViewState((currentState) => ({
                  ...currentState,
                  query: event.target.value,
                }));
                setActiveSavedViewId('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && viewState.query) {
                  event.preventDefault();
                  setViewState((currentState) => ({
                    ...currentState,
                    query: '',
                  }));
                  setActiveSavedViewId('');
                }
              }}
            />
          </label>

          <label className="field-stack">
            <span>Sort</span>
            <select
              aria-label="Sort backlog by"
              value={viewState.sortField}
              onChange={(event) => {
                setViewState((currentState) => ({
                  ...currentState,
                  sortField: event.target.value as BacklogViewState['sortField'],
                }));
                setActiveSavedViewId('');
              }}
            >
              <option value="identifier">Identifier</option>
              <option value="title">Title</option>
              <option value="state">State</option>
              <option value="assignee">Assignee</option>
              <option value="updatedAt">Updated</option>
              <option value="createdAt">Created</option>
            </select>
          </label>

          <label className="field-stack">
            <span>Direction</span>
            <select
              aria-label="Sort backlog direction"
              value={viewState.sortDirection}
              onChange={(event) => {
                setViewState((currentState) => ({
                  ...currentState,
                  sortDirection: event.target.value as BacklogViewState['sortDirection'],
                }));
                setActiveSavedViewId('');
              }}
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </label>
        </div>

        <div className="backlog-toolbar__secondary">
          <label className="field-stack">
            <span>Saved view</span>
            <select
              aria-label="Load saved backlog view"
              value={activeSavedViewId}
              onChange={(event) => loadSavedView(event.target.value)}
            >
              <option value="">Current filters</option>
              {savedViews.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.name}
                </option>
              ))}
            </select>
          </label>

          <button type="button" className="ui-action ui-action--subtle" onClick={saveCurrentView}>
            Save view
          </button>
          <button
            type="button"
            className="ui-action ui-action--subtle"
            disabled={!activeSavedViewId}
            onClick={deleteSavedView}
          >
            Delete view
          </button>
          <button type="button" className="ui-action ui-action--subtle" onClick={resetViewState}>
            Clear
          </button>
        </div>
      </section>

      <section className="backlog-filter-row" aria-label="Backlog filters">
        <details className="backlog-filter">
          <summary>States {viewState.stateIds.length > 0 ? `(${viewState.stateIds.length})` : ''}</summary>
          <div className="backlog-filter__menu">
            {selectedTeam?.states.nodes.map((state) => (
              <label key={state.id} className="backlog-filter__option">
                <input
                  type="checkbox"
                  checked={viewState.stateIds.includes(state.id)}
                  onChange={() => {
                    toggleFilterValue('stateIds', state.id);
                    setActiveSavedViewId('');
                  }}
                />
                <span>{state.name}</span>
              </label>
            ))}
          </div>
        </details>

        <details className="backlog-filter">
          <summary>Assignees {viewState.assigneeIds.length > 0 ? `(${viewState.assigneeIds.length})` : ''}</summary>
          <div className="backlog-filter__menu">
            <label className="backlog-filter__option">
              <input
                type="checkbox"
                checked={viewState.assigneeIds.includes('unassigned')}
                onChange={() => {
                  toggleFilterValue('assigneeIds', 'unassigned');
                  setActiveSavedViewId('');
                }}
              />
              <span>Unassigned</span>
            </label>
            {users.map((user) => (
              <label key={user.id} className="backlog-filter__option">
                <input
                  type="checkbox"
                  checked={viewState.assigneeIds.includes(user.id)}
                  onChange={() => {
                    toggleFilterValue('assigneeIds', user.id);
                    setActiveSavedViewId('');
                  }}
                />
                <span>{user.name ?? user.email ?? user.id}</span>
              </label>
            ))}
          </div>
        </details>

        <details className="backlog-filter">
          <summary>Labels {viewState.labelIds.length > 0 ? `(${viewState.labelIds.length})` : ''}</summary>
          <div className="backlog-filter__menu">
            {labels.map((label) => (
              <label key={label.id} className="backlog-filter__option">
                <input
                  type="checkbox"
                  checked={viewState.labelIds.includes(label.id)}
                  onChange={() => {
                    toggleFilterValue('labelIds', label.id);
                    setActiveSavedViewId('');
                  }}
                />
                <span>{label.name}</span>
              </label>
            ))}
          </div>
        </details>
      </section>

      <section className="backlog-active-view" aria-label="Active backlog view">
        <div className="backlog-active-view__meta">
          <strong>{filteredIssues.length} visible issues</strong>
          <span>
            {activeSavedViewId
              ? `Loaded view: ${savedViews.find((view) => view.id === activeSavedViewId)?.name ?? 'Unknown'}`
              : 'Unsaved working view'}
          </span>
        </div>
        <div className="backlog-active-view__tokens">
          {activeFilterTokens.map((token) => (
            <span key={token} className="context-chip">
              {token}
            </span>
          ))}
        </div>
      </section>

      {filteredIssues.length > 0 ? (
        <div className="backlog-surface">
          <table className="backlog-table">
            <thead>
              <tr>
                <th scope="col">Identifier</th>
                <th scope="col">Title</th>
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
                  <td>{issue.state.name}</td>
                  <td>
                    {issue.labels.nodes.length > 0
                      ? issue.labels.nodes.map((label) => label.name).join(', ')
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
        <section className="shell-notice">
          <p>No issues match the current backlog view.</p>
        </section>
      )}
    </main>
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

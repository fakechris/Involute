import { useQuery } from '@apollo/client/react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { readStoredTeamKey } from '../board/utils';
import { highlight } from '../components/highlight';
import { ProjectFilterCombobox, type AvailableProject } from '../components/ProjectFilterCombobox';
import { GRAPH_PROJECTS_QUERY, SEARCH_LABELS_QUERY, WORK_SEARCH_QUERY } from '../work/queries';
import { matchLabel } from '../work/search-labels';
import type { GraphProjectsQueryData, SearchLabelsQueryData, WorkSearchQueryData } from '../work/types';

const RESULT_LIMIT = 100;
const KINDS = ['ISSUE', 'EPIC', 'MILESTONE', 'PROJECT', 'DECISION'] as const;
const STATE_TYPES = [
  ['BACKLOG', 'Backlog'],
  ['UNSTARTED', 'Ready'],
  ['STARTED', 'In progress'],
  ['COMPLETED', 'Done'],
  ['CANCELED', 'Canceled'],
] as const;

/**
 * Every search hit, with filters (INV-926). Kind, state and label become IQL,
 * the same filter MCP work_search takes, so both return the same items; the
 * project filter is the repository.
 */
export function buildSearchIql(filters: { kind: string; state: string; label: string; iql: string }): string {
  return [
    filters.kind ? `kind:${filters.kind}` : '',
    filters.state ? `state-type:${filters.state}` : '',
    filters.label ? `label:"${filters.label.replace(/"/g, '')}"` : '',
    filters.iql.trim(),
  ].filter(Boolean).join(' ');
}

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const project = searchParams.get('project') ?? '';
  const filters = {
    kind: searchParams.get('kind') ?? '',
    state: searchParams.get('state') ?? '',
    label: searchParams.get('label') ?? '',
    iql: searchParams.get('iql') ?? '',
  };
  const [draft, setDraft] = useState(query);
  useEffect(() => setDraft(query), [query]);

  function update(changes: Record<string, string>) {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    }, { replace: true });
  }

  const iql = buildSearchIql(filters);
  const results = useQuery<WorkSearchQueryData>(WORK_SEARCH_QUERY, {
    variables: {
      query,
      first: RESULT_LIMIT,
      ...(iql ? { iql } : {}),
      ...(project ? { repository: project } : {}),
    },
    skip: !query.trim(),
  });
  const teamKey = readStoredTeamKey();
  const projectsQuery = useQuery<GraphProjectsQueryData>(GRAPH_PROJECTS_QUERY, {
    variables: teamKey ? { teamFilter: { key: { eq: teamKey } } } : {},
  });
  const labelsQuery = useQuery<SearchLabelsQueryData>(SEARCH_LABELS_QUERY);

  const projects = useMemo<AvailableProject[]>(
    () =>
      (projectsQuery.data?.projectSummary.projects ?? []).map((item) => ({
        id: item.identifier ?? item.repository,
        identifier: item.identifier ?? item.repository,
        name: item.repository,
        title: item.name || item.repository,
        key: item.repository,
        issueCount: item.totalCount,
      })),
    [projectsQuery.data],
  );
  const hits = query.trim() ? results.data?.search ?? [] : [];

  return (
    <div className="observation-page search-page">
      <div className="page-header">
        <h1 className="page-header__title">Search</h1>
        <span className="observation-hint">Titles, descriptions, contracts and comments · every word must match</span>
      </div>
      <div className="page-content observation-content">
        <form
          className="search-page__form"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            update({ q: draft.trim() });
          }}
        >
          <input
            aria-label="Search all work"
            className="search-page__input"
            placeholder="Words, &quot;a phrase&quot;, or INV-123"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            autoFocus
          />
          <button type="submit" className="ui-action">Search</button>
        </form>

        <div className="search-page__filters" aria-label="Search filters">
          <label>
            <span>Kind</span>
            <select aria-label="Kind" value={filters.kind} onChange={(event) => update({ kind: event.target.value })}>
              <option value="">Any</option>
              {KINDS.map((kind) => <option key={kind} value={kind}>{kind.toLowerCase()}</option>)}
            </select>
          </label>
          <label>
            <span>State</span>
            <select aria-label="State" value={filters.state} onChange={(event) => update({ state: event.target.value })}>
              <option value="">Any</option>
              {STATE_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>
            <span>Label</span>
            <select aria-label="Label" value={filters.label} onChange={(event) => update({ label: event.target.value })}>
              <option value="">Any</option>
              {(labelsQuery.data?.issueLabels.nodes ?? []).map((label) => (
                <option key={label.id} value={label.name}>{label.name}</option>
              ))}
            </select>
          </label>
          {projects.length > 0 ? (
            <ProjectFilterCombobox
              projects={projects}
              selectedProjectKey={project || null}
              onSelectProject={(key) => update({ project: key ?? '' })}
              placeholder="Any project"
            />
          ) : null}
          <label className="search-page__iql">
            <span>IQL</span>
            <input
              key={filters.iql}
              aria-label="IQL filter"
              placeholder="e.g. assignee:me priority:1"
              defaultValue={filters.iql}
              onKeyDown={(event) => {
                if (event.key === 'Enter') update({ iql: event.currentTarget.value });
              }}
              onBlur={(event) => update({ iql: event.target.value })}
            />
          </label>
        </div>

        {!query.trim() ? (
          <p className="observation-empty">Type words to search all work you can read.</p>
        ) : results.error ? (
          <div className="empty-state" role="alert">{results.error.message}</div>
        ) : results.loading && !results.data ? (
          <p className="observation-empty" role="status">Searching…</p>
        ) : hits.length === 0 ? (
          <p className="observation-empty" role="status">Nothing matches every word{iql || project ? ' with these filters' : ''}.</p>
        ) : (
          <>
            <p className="observation-hint" role="status">
              {hits.length === RESULT_LIMIT ? `Top ${RESULT_LIMIT} results` : `${hits.length} result${hits.length === 1 ? '' : 's'}`}
            </p>
            <ul className="search-results" aria-label="Search results">
              {hits.map((hit) => (
                <li key={hit.issue.id} className="search-result">
                  <Link to={`/issue/${hit.issue.id}`} className="search-result__link">
                    <span className="mono search-result__identifier">{hit.issue.identifier}</span>
                    <span className="search-result__title">{highlight(hit.issue.title, query)}</span>
                    <span className="search-result__meta">
                      {hit.issue.state.name} · {matchLabel(hit.matchedField)}
                    </span>
                  </Link>
                  {hit.snippet ? <p className="search-result__snippet">{highlight(hit.snippet, query)}</p> : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

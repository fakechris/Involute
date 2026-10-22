import { useQuery } from '@apollo/client/react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { readStoredTeamKey } from '../board/utils';
import { highlight } from '../components/highlight';
import { ProjectFilterCombobox, type AvailableProject } from '../components/ProjectFilterCombobox';
import { GRAPH_PROJECTS_QUERY, SEARCH_LABELS_QUERY, WORK_SEARCH_QUERY } from '../work/queries';
import { matchLabel } from '../work/search-labels';
import type { GraphProjectsQueryData, SearchLabelsQueryData, WorkSearchQueryData } from '../work/types';
import { Select, TextInput } from '../components/controls';
import { PageBody, PageHeader, PageToolbar } from '../components/layout';
import { IssueRow } from '../components/list';
import { Btn } from '../components/Primitives';
import { EmptyState, InlineError, LoadingState } from '../components/status';

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
    <div className="observation-page">
      <PageHeader title="Search" hint="Titles, descriptions, contracts and comments · every word must match" />
      <PageToolbar
        aria-label="Search filters"
        projects={
          projects.length > 0 ? (
            <ProjectFilterCombobox
              projects={projects}
              selectedProjectKey={project || null}
              onSelectProject={(key) => update({ project: key ?? '' })}
              placeholder="Any project"
              showQuickPills
            />
          ) : null
        }
        filters={
          <>
            <form
              className="search-box"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                update({ q: draft.trim() });
              }}
            >
              <TextInput
                size="sm"
                aria-label="Search all work"
                className="search-box__input"
                placeholder="Words, &quot;a phrase&quot;, or INV-123"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                autoFocus
              />
              <Btn type="submit" variant="subtle">Search</Btn>
            </form>
            <Select size="sm" aria-label="Kind" value={filters.kind} onChange={(event) => update({ kind: event.target.value })}>
              <option value="">Any kind</option>
              {KINDS.map((kind) => <option key={kind} value={kind}>{kind.toLowerCase()}</option>)}
            </Select>
            <Select size="sm" aria-label="State" value={filters.state} onChange={(event) => update({ state: event.target.value })}>
              <option value="">Any state</option>
              {STATE_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
            <Select size="sm" aria-label="Label" value={filters.label} onChange={(event) => update({ label: event.target.value })}>
              <option value="">Any label</option>
              {(labelsQuery.data?.issueLabels.nodes ?? []).map((label) => (
                <option key={label.id} value={label.name}>{label.name}</option>
              ))}
            </Select>
          </>
        }
        view={
          <TextInput
            size="sm"
            key={filters.iql}
            aria-label="IQL filter"
            placeholder="IQL, e.g. assignee:me priority:1"
            defaultValue={filters.iql}
            onKeyDown={(event) => {
              if (event.key === 'Enter') update({ iql: event.currentTarget.value });
            }}
            onBlur={(event) => update({ iql: event.target.value })}
          />
        }
      />
      <PageBody>
        {!query.trim() ? (
          <EmptyState size="inline" title="Type words to search all work you can read." />
        ) : results.error ? (
          <InlineError variant="block">{results.error.message}</InlineError>
        ) : results.loading && !results.data ? (
          <LoadingState>Searching…</LoadingState>
        ) : hits.length === 0 ? (
          <div role="status">
            <EmptyState size="inline" title={`Nothing matches every word${iql || project ? ' with these filters' : ''}.`} />
          </div>
        ) : (
          <>
            <p className="observation-hint" role="status">
              {hits.length === RESULT_LIMIT ? `Top ${RESULT_LIMIT} results` : `${hits.length} result${hits.length === 1 ? '' : 's'}`}
            </p>
            <ul className="list-rows" aria-label="Search results">
              {hits.map((hit) => (
                <IssueRow
                  key={hit.issue.id}
                  issue={hit.issue}
                  titleNode={highlight(hit.issue.title, query)}
                  meta={`${hit.issue.state.name} · ${matchLabel(hit)}`}
                  detail={hit.snippet ? <span className="list-row__snippet">{highlight(hit.snippet, query)}</span> : null}
                />
              ))}
            </ul>
          </>
        )}
      </PageBody>
    </div>
  );
}

import { gql } from '@apollo/client';
import { useApolloClient, useQuery } from '@apollo/client/react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { SHELL_TEAMS_QUERY } from '../board/queries';
import type { TeamSummary } from '../board/types';
import { readStoredTeamKey, writeStoredTeamKey } from '../board/utils';
import { Select } from '../components/controls';
import { DataTable } from '../components/DataTable';
import { IssueRow } from '../components/list';
import { PageBody, PageHeader, PageToolbar } from '../components/layout';
import { Btn } from '../components/Primitives';
import { ProjectFilterCombobox } from '../components/ProjectFilterCombobox';
import { Badge, EmptyState, LoadingState, SegmentedControl, StatRow, StatTile } from '../components/status';
import { formatDay, parseFactWindow, windowForPreset, windowRange } from '../work/timeline-model';
import { MilestoneBurndown } from './MilestoneBurndown';
import { NO_REPOSITORY_OPTIONS, useProjectParam } from './work-filter-match';

export const DELIVERY_QUERY = gql`
  query DeliveryLatency(
    $teamKey: String!
    $from: String!
    $to: String!
    $timeZone: String!
    $repository: String
    $sample: DeliveryLatencySample
    $after: String
  ) {
    deliveryLatency(
      teamKey: $teamKey
      from: $from
      to: $to
      timeZone: $timeZone
      repository: $repository
      sample: $sample
      first: 100
      after: $after
    ) {
      definitionVersion
      repository
      window {
        start
        end
      }
      coverage {
        workCount
        noHistoryCount
        openEpisodeCount
        closedWithoutAcceptanceCount
        unknownEpisodeCount
      }
      leadTime {
        sampleCount
        p50Ms
        p90Ms
        emptyReason
        coverage {
          acceptedCount
          missingCount
        }
      }
      cycleTime {
        sampleCount
        p50Ms
        p90Ms
        emptyReason
        coverage {
          acceptedCount
          missingCount
        }
      }
      reviewWait {
        sampleCount
        p50Ms
        p90Ms
        emptyReason
        coverage {
          acceptedCount
          missingCount
        }
      }
      nodes {
        id
        identifier
        title
        repository
        state {
          name
          type
        }
        sampleEpisodeCount
        episodes {
          outcome
          ageMs
        }
        runs {
          wallClockSumMs
          wallClockUnionMs
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const DELIVERY_PROJECTS_QUERY = gql`
  query DeliveryProjects($teamKey: String!) {
    projectSummary(teamFilter: { key: { eq: $teamKey } }) {
      totalCount
      noRepositoryCount
      projects {
        repository
        name
        identifier
        totalCount
      }
    }
  }
`;

type Sample = 'LEAD_TIME' | 'CYCLE_TIME' | 'REVIEW_WAIT' | 'OPEN';
interface ProjectSummary {
  totalCount: number;
  noRepositoryCount: number;
  projects: {
    repository: string;
    name: string;
    identifier: string | null;
    totalCount: number;
  }[];
}

interface Metric {
  sampleCount: number;
  p50Ms: number | null;
  p90Ms: number | null;
  emptyReason: string | null;
  coverage: { missingCount: number };
}

interface Work {
  id: string;
  identifier: string;
  title: string;
  repository: string | null;
  state: { name: string; type: string };
  sampleEpisodeCount: number;
  episodes: { outcome: string; ageMs: number | null }[];
  runs: { wallClockSumMs: number | null; wallClockUnionMs: number | null };
}
export interface DeliveryResult {
  definitionVersion: string;
  repository: string | null;
  window: { start: string; end: string };
  leadTime: Metric;
  cycleTime: Metric;
  reviewWait: Metric;
  coverage: {
    workCount: number;
    noHistoryCount: number;
    openEpisodeCount: number;
    closedWithoutAcceptanceCount: number;
    unknownEpisodeCount: number;
  };
  nodes: Work[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const METRICS = [
  { key: 'leadTime', sample: 'LEAD_TIME', label: 'Lead time' },
  { key: 'cycleTime', sample: 'CYCLE_TIME', label: 'Cycle time' },
  { key: 'reviewWait', sample: 'REVIEW_WAIT', label: 'Review wait' },
] as const;

function duration(ms: number | null): string {
  if (ms === null) return 'Unknown';
  if (ms < 60_000) return '<1m';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}
function age(work: Work): number | null {
  const known = work.episodes
    .filter((episode) => episode.outcome === 'OPEN' && episode.ageMs !== null)
    .map((episode) => episode.ageMs!);
  return known.length ? Math.max(...known) : null;
}
function emptyReason(metric: Metric) {
  return metric.emptyReason === 'INSUFFICIENT_HISTORY' ? 'Insufficient history for this metric.' : 'No accepted episodes in this window.';
}

export function DeliveryPage() {
  const client = useApolloClient();
  const [params, setParams] = useSearchParams();
  const { data: teamData, error: teamError, refetch: refetchTeams } = useQuery<{ teams: { nodes: TeamSummary[] } }>(SHELL_TEAMS_QUERY, {
    fetchPolicy: 'cache-and-network',
  });
  const teams = teamData?.teams.nodes ?? [];
  const requestedTeamKey = params.get('team');
  const storedTeamKey = readStoredTeamKey();
  const team = teams.find(({ key }) => key === requestedTeamKey)
    ?? teams.find(({ key }) => key === storedTeamKey)
    ?? (teams.length === 1 ? teams[0] : undefined);
  const teamKey = team?.key ?? '';
  const [project, setProject] = useProjectParam();
  const [now] = useState(() => new Date());
  const factWindow = parseFactWindow(params.get('from'), params.get('to'), now) ?? windowForPreset('30d', now)!;
  const from = formatDay(factWindow.from);
  const to = formatDay(factWindow.to);
  const range = windowRange(factWindow);
  const start = range.start.toISOString();
  const end = range.end.toISOString();
  const hasTimelineProject = Boolean(project && project !== '__none__');
  const timelineParams = new URLSearchParams({ view: 'timeline', from, to });
  if (hasTimelineProject) timelineParams.set('project', project);
  const rawSample = params.get('sample');
  const sample = ['LEAD_TIME', 'CYCLE_TIME', 'REVIEW_WAIT', 'OPEN'].includes(rawSample ?? '') ? (rawSample as Sample) : null;
  const variables = useMemo(
    () => ({ teamKey, from, to, timeZone: 'UTC', repository: project || null, sample }),
    [teamKey, from, to, project, sample],
  );
  const requestKey = JSON.stringify(variables);
  const [result, setResult] = useState<{ key: string; data?: DeliveryResult; error?: string } | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const { data: projectData } = useQuery<{ projectSummary: ProjectSummary }>(DELIVERY_PROJECTS_QUERY, {
    variables: { teamKey },
    skip: !teamKey,
  });
  const projects = (projectData?.projectSummary.projects ?? []).map((project) => ({
    id: project.identifier ?? project.repository,
    identifier: project.identifier ?? project.repository,
    name: project.repository,
    title: project.name || project.repository,
    key: project.repository,
    issueCount: project.totalCount,
  }));
  const noRepositoryOptions = NO_REPOSITORY_OPTIONS.map((option) => ({
    ...option,
    count: projectData?.projectSummary.noRepositoryCount ?? 0,
  }));
  useEffect(() => {
    if (!teamKey) return;
    let active = true;
    async function load() {
      try {
        let after: string | null = null;
        let combined: DeliveryResult | undefined;
        do {
          const response = await client.query<{ deliveryLatency: DeliveryResult }>({
            query: DELIVERY_QUERY,
            variables: { ...variables, after },
            fetchPolicy: 'no-cache',
          });
          if (!active) return;
          if (!response.data) throw new Error('No delivery latency response.');
          const page: DeliveryResult = response.data.deliveryLatency;
          combined = { ...page, nodes: [...(combined?.nodes ?? []), ...page.nodes] };
          after = sample && page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
        } while (after);
        if (active && combined) setResult({ key: requestKey, data: combined });
      } catch (error) {
        if (active) {
          setResult({ key: requestKey, error: error instanceof Error ? error.message : 'Could not load delivery latency.' });
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [client, requestKey, variables, sample, teamKey, retryAttempt]);
  const current = result?.key === requestKey ? result : null;
  const data = current?.data;
  function href(next: Sample) {
    const updated = new URLSearchParams(params);
    updated.set('from', from);
    updated.set('to', to);
    updated.set('sample', next);
    return `?${updated}`;
  }

  const select = (next: Sample) => setParams(new URLSearchParams(href(next).slice(1)));
  function retry() {
    setResult(null);
    setRetryAttempt((attempt) => attempt + 1);
  }

  function changeWindow(value: string) {
    const updated = new URLSearchParams(params);
    const today = windowForPreset('30d', now)!.to;
    updated.set('to', formatDay(today));
    updated.set('from', formatDay(new Date(today.getTime() - (Number(value) - 1) * 86_400_000)));
    setParams(updated);
  }

  function changeTeam(key: string) {
    const updated = new URLSearchParams(params);
    updated.set('team', key);
    updated.delete('project');
    writeStoredTeamKey(key);
    setParams(updated);
  }

  const days = (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000;
  const presets = [7, 30, 90].map((day) => ({ value: String(day), label: `${day}d` }));
  const rows = data ? METRICS.map((metric) => ({ ...metric, metric: data[metric.key] })) : [];
  const max = Math.max(1, ...rows.map((row) => row.metric.p90Ms ?? 0));
  const works = [...(data?.nodes ?? [])].sort((a, b) =>
    sample === 'OPEN' ? (age(b) ?? -1) - (age(a) ?? -1) : a.identifier.localeCompare(b.identifier),
  );
  const totalSamples = data
    ? sample === 'OPEN'
      ? data.coverage.openEpisodeCount
      : rows.find((row) => row.sample === sample)?.metric.sampleCount ?? 0
    : 0;
  const lowCoverage = data && (
    rows.some((row) => row.metric.coverage.missingCount > 0 || row.metric.sampleCount < 5) ||
    data.coverage.noHistoryCount > 0 ||
    data.coverage.unknownEpisodeCount > 0
  );

  return (
    <div className="observation-page">
      <PageHeader title="Delivery latency" hint={teams.length === 1 ? team?.name : undefined} />
      {teams.length > 1 || teamKey ? (
        <PageToolbar
          projects={
            <>
              {teams.length > 1 ? (
                <Select size="sm" aria-label="Delivery team" value={teamKey} onChange={(event) => changeTeam(event.target.value)}>
                  <option value="" disabled>Choose a team</option>
                  {teams.map(({ id, key, name }) => <option key={id} value={key}>{name} ({key})</option>)}
                </Select>
              ) : null}
              {teamKey ? (
                <ProjectFilterCombobox
                  projects={projects}
                  selectedProjectKey={project || null}
                  totalCount={projectData?.projectSummary.totalCount ?? 0}
                  onSelectProject={setProject}
                  extraOptions={noRepositoryOptions}
                  teamKey={teamKey}
                  showQuickPills
                />
              ) : null}
            </>
          }
          view={
            teamKey ? (
              <SegmentedControl
                aria-label="Delivery window"
                options={presets}
                value={String(days)}
                onChange={changeWindow}
              />
            ) : null
          }
        />
      ) : null}
      <PageBody width="wide">
        {!teamData && teamError ? (
          <div role="alert">
            <EmptyState
              title="Could not load teams"
              body={teamError.message}
              action={<Btn variant="subtle" onClick={() => void refetchTeams()}>Retry</Btn>}
            />
          </div>
        ) : !teamData ? (
          <LoadingState>Loading teams…</LoadingState>
        ) : teams.length === 0 ? (
          <EmptyState title="No teams available" body="You need access to a team to view its delivery latency." />
        ) : !teamKey ? (
          <EmptyState title="Select a team" body="Choose a team above to see its delivery latency." />
        ) : !current ? (
          <LoadingState>Loading delivery latency…</LoadingState>
        ) : current.error ? (
          <div role="alert">
            <EmptyState
              title="Could not load delivery latency"
              body={current.error}
              action={
                <Btn variant="subtle" onClick={retry}>
                  Retry
                </Btn>
              }
            />
          </div>
        ) : data ? (
          <div className="bugs-content">
            <p>
              Definition {data.definitionVersion} · {from} – {to}, UTC, inclusive
            </p>
            {hasTimelineProject ? <Link className="ui-action ui-action--subtle" to={`/graph?${timelineParams}`}>Open in timeline</Link> : null}
            <StatRow aria-label="Completed sample latency">
              {rows.map(({ key, label, sample: next, metric }) => (
                <StatTile
                  key={key}
                  label={label}
                  to={href(next)}
                  value={metric.sampleCount === 0 ? 'No samples' : `P50 ${duration(metric.p50Ms)} · P90 ${duration(metric.p90Ms)}`}
                  detail={
                    <>
                      {`n=${metric.sampleCount}`} {metric.sampleCount === 0 ? emptyReason(metric) : null}
                    </>
                  }
                />
              ))}
            </StatRow>
            {lowCoverage ? (
              <p>
                <Badge tone="warn">Low coverage</Badge> Interpret cautiously: fewer than 5 samples per metric, missing values,
                no history or unknown episodes. {rows.map((row) => `${row.label}: ${row.metric.coverage.missingCount} missing`).join(' · ')}
              </p>
            ) : null}
            <p>
              Works: {data.coverage.workCount} · No history: {data.coverage.noHistoryCount} · Open: {data.coverage.openEpisodeCount}
              {' · '}Closed without acceptance: {data.coverage.closedWithoutAcceptanceCount} · Unknown: {data.coverage.unknownEpisodeCount}
            </p>
            <section aria-label="Latency percentile chart">
              <h2>Completed sample percentiles</h2>
              {rows.flatMap(({ key, label, sample: next, metric }) =>
                (['p50Ms', 'p90Ms'] as const).map((percentile) => (
                  <button
                    key={`${key}-${percentile}`}
                    className="delivery-percentile"
                    type="button"
                    aria-label={`${label} ${percentile === 'p50Ms' ? 'P50' : 'P90'}: ${metric.sampleCount ? duration(metric[percentile]) : 'No samples'}, n=${metric.sampleCount}. Show samples`}
                    onClick={() => select(next)}
                  >
                    <span>
                      {label} {percentile === 'p50Ms' ? 'P50' : 'P90'} · {metric.sampleCount ? duration(metric[percentile]) : 'No samples'}
                    </span>
                    <svg viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
                      <rect width={(metric[percentile] ?? 0) / max * 100} height="6" />
                    </svg>
                  </button>
                )),
              )}
              <DataTable
                label="Latency percentiles text equivalent"
                rows={rows}
                rowKey={(row) => row.key}
                columns={[
                  { key: 'metric', header: 'Metric', render: (row) => row.label },
                  { key: 'p50', header: 'P50', render: (row) => row.metric.sampleCount ? duration(row.metric.p50Ms) : 'No samples' },
                  { key: 'p90', header: 'P90', render: (row) => row.metric.sampleCount ? duration(row.metric.p90Ms) : 'No samples' },
                  { key: 'count', header: 'Samples', render: (row) => row.metric.sampleCount },
                ]}
              />
            </section>
            <Btn variant="subtle" onClick={() => select('OPEN')}>
              Open items
            </Btn>
            {sample ? (
              <section aria-label="Delivery drill-down">
                <h2>{sample === 'OPEN' ? 'Open items — oldest first' : `${rows.find((row) => row.sample === sample)?.label} samples`}</h2>
                <p>
                  {works.length} items · {works.reduce((sum, work) => sum + work.sampleEpisodeCount, 0)} samples of {totalSamples}
                </p>
                {works.length === 0 ? (
                  <EmptyState size="inline" title="No matching items" />
                ) : (
                  <ul>
                    {works.map((work) => (
                      <IssueRow
                        key={work.id}
                        issue={work}
                        open="drawer"
                        showState
                        age={sample === 'OPEN' ? `Age ${duration(age(work))}` : undefined}
                        detail={
                          <>
                            Run wall-clock (not work time): sum {duration(work.runs.wallClockSumMs)} · union{' '}
                            {duration(work.runs.wallClockUnionMs)}. Human actual time: Unknown · Agent actual time: Unknown
                          </>
                        }
                      />
                    ))}
                  </ul>
                )}
              </section>
            ) : null}
          </div>
        ) : null}
        {teamKey ? (
          <MilestoneBurndown key={`${teamKey}:${project}`} teamKey={teamKey} repository={project} start={start} end={end} />
        ) : null}
      </PageBody>
    </div>
  );
}

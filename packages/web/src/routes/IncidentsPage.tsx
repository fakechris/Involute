import { useQuery } from '@apollo/client/react';
import { useMemo } from 'react';

import { INCIDENTS_PAGE_QUERY } from '../board/queries';
import { severityLabel } from '../board/severity';
import type { IncidentsPageQueryData, IncidentsPageQueryVariables, IncidentSummaryData } from '../board/types';
import { readStoredTeamKey } from '../board/utils';
import { formatImpactDuration } from '../components/IncidentTimesPanel';
import { IcoBell } from '../components/Icons';
import { IssueRow } from '../components/list';
import { PageBody, PageHeader, PageToolbar } from '../components/layout';
import { Btn } from '../components/Primitives';
import { ProjectFilterCombobox } from '../components/ProjectFilterCombobox';
import { EmptyState, LoadingState, StatRow, StatTile } from '../components/status';
import { useWorkFilters, WorkFilterBar } from '../components/WorkFilterBar';
import { matchesProject, matchesWorkFilters, projectsFromCounts, useProjectParam, NO_REPOSITORY_OPTIONS } from './work-filter-match';

const HOUR_MS = 3_600_000;

/** An average with how many incidents it is over; "—" before any. */
function formatAverage(hours: number | null, samples: number): string {
  return hours === null ? '—' : `${formatImpactDuration(hours * HOUR_MS)} (n=${samples})`;
}

function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

function postmortemText(item: IncidentSummaryData['incidents'][number]): string {
  if (item.postmortemAttached) return 'Attached';
  return item.postmortemRequired ? 'Missing' : 'Not required';
}

/**
 * Incident metrics (INV-1129): how many incidents, how long until mitigated
 * and resolved, and whether their follow-ups get done. Plain averages with
 * their sample size — a month brings single-digit incidents, so percentiles
 * and period comparisons would mislead (decision INV-1130).
 */
export function IncidentsPage() {
  const teamKey = readStoredTeamKey();
  const { data, error, loading, refetch } = useQuery<IncidentsPageQueryData, IncidentsPageQueryVariables>(INCIDENTS_PAGE_QUERY, {
    variables: teamKey ? { teamFilter: { key: { eq: teamKey } } } : {},
    fetchPolicy: 'cache-and-network',
  });
  const summary = data?.incidentSummary ?? null;
  const counted = summary ? summary.openCount + summary.resolvedCount : 0;
  // Project and text filters narrow the incident list; the metrics stay team-wide (INV-1314).
  // Every incident is an ISSUE with Type: Incident; owner and priority are not on the row.
  const [project, setProject] = useProjectParam();
  const workFilters = useWorkFilters();
  const projects = useMemo(
    () => projectsFromCounts((summary?.byRepository ?? []).map((row) => ({ repository: row.repository, count: row.openCount + row.resolvedCount }))),
    [summary?.byRepository],
  );
  const visibleIncidents = useMemo(
    () =>
      (summary?.incidents ?? []).filter((item) =>
        matchesProject(item.repository, project) &&
        matchesWorkFilters({ title: item.title, kind: 'ISSUE', labelNames: ['incident'] }, workFilters.filters, null),
      ),
    [summary?.incidents, project, workFilters.filters],
  );

  return (
    <div className="observation-page">
      <PageHeader icon={<IcoBell size={14} />} title="Incidents" count={summary?.openCount ?? 0} />
      <PageToolbar
        aria-label="Incident filters"
        projects={
          <ProjectFilterCombobox
            projects={projects}
            selectedProjectKey={project || null}
            totalCount={counted}
            onSelectProject={setProject}
            extraOptions={NO_REPOSITORY_OPTIONS}
            showQuickPills
          />
        }
        filters={<WorkFilterBar {...workFilters} />}
      />

      <PageBody width="wide">
        {error ? (
          <div role="alert">
            <EmptyState
              title="Could not load incident metrics"
              body="Confirm the API server is running, then retry."
              action={
                <Btn variant="subtle" onClick={() => void refetch()}>
                  Retry
                </Btn>
              }
            />
          </div>
        ) : loading && !summary ? (
          <LoadingState>Loading incidents…</LoadingState>
        ) : summary && counted === 0 ? (
          <EmptyState
            title="No incidents"
            body={
              <>
                Declared incidents (Type: Incident) appear here with their MTTR, MTTM and follow-up progress. Declare one from the board with
                Report incident.
                {summary.excludedCount > 0 ? ` ${summary.excludedCount} declined or duplicate incidents are not counted.` : null}
              </>
            }
          />
        ) : summary ? (
          <div className="bugs-content">
            <StatRow aria-label="Incident statistics">
              <StatTile value={summary.openCount} label="Ongoing" />
              <StatTile value={summary.resolvedCount} label="Resolved" />
              <StatTile
                title="Mean time from impact start to mitigation (resolution when mitigation was not recorded)"
                value={formatAverage(summary.mttmHours, summary.mttmSampleCount)}
                label="MTTM"
              />
              <StatTile
                title="Mean time from impact start to resolution"
                value={formatAverage(summary.mttrHours, summary.mttrSampleCount)}
                label="MTTR"
              />
            </StatRow>

            <StatRow aria-label="Follow-ups">
              <StatTile
                title="Completed / (total − declined): a declined follow-up is no longer owed"
                value={formatRate(summary.followUps.completionRate)}
                label={`Follow-ups done (${summary.followUps.completed} of ${summary.followUps.total - summary.followUps.declined})`}
              />
              <StatTile value={summary.followUps.overdueOpen} label="Overdue, still open" />
              <StatTile value={summary.followUps.overdue} label="Overdue in total" />
              <StatTile value={summary.followUps.declined} label="Declined" />
            </StatRow>

            <div className="bugs-grid">
              <section className="bugs-panel" aria-label="Incidents by severity">
                <h2 className="bugs-panel__title">By severity</h2>
                <table className="bugs-table">
                  <thead>
                    <tr>
                      <th>Severity</th>
                      <th>Ongoing</th>
                      <th>Resolved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.bySeverity.map((row) => (
                      <tr key={row.severity ?? '__none__'}>
                        <td>{severityLabel(row.severity)}</td>
                        <td>{row.openCount}</td>
                        <td>{row.resolvedCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section className="bugs-panel" aria-label="Incidents by project">
                <h2 className="bugs-panel__title">By project</h2>
                <table className="bugs-table">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Ongoing</th>
                      <th>Resolved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byRepository.map((row) => (
                      <tr key={row.repository ?? '__none__'}>
                        <td className="mono">{row.repository ?? 'No project'}</td>
                        <td>{row.openCount}</td>
                        <td>{row.resolvedCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </div>

            <section className="bugs-panel" aria-label="Incident list">
              <h2 className="bugs-panel__title">Incidents</h2>
              <table className="bugs-table">
                <thead>
                  <tr>
                    <th>Incident</th>
                    <th>Severity</th>
                    <th>Impact</th>
                    <th>Postmortem</th>
                    <th>Follow-ups</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleIncidents.length === 0 ? (
                    <tr>
                      <td colSpan={5}>No incident matches these filters.</td>
                    </tr>
                  ) : null}
                  {visibleIncidents.map((item) => (
                    <tr key={item.id} data-testid={`incident-${item.identifier}`}>
                      <td>
                        <IssueRow as="div" variant="compact" issue={item} open="drawer" />
                      </td>
                      <td>{severityLabel(item.severity)}</td>
                      <td>{item.ongoing ? `Ongoing · ${formatImpactDuration(item.impactHours * HOUR_MS)}` : formatImpactDuration(item.impactHours * HOUR_MS)}</td>
                      <td>{postmortemText(item)}</td>
                      <td>
                        {item.followUpTotal === 0
                          ? 'None'
                          : `${item.followUpCompleted} of ${item.followUpTotal - item.followUpDeclined} done${item.followUpOverdueOpen > 0 ? ` · ${item.followUpOverdueOpen} overdue` : ''}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {summary.excludedCount > 0 ? (
                <p className="bugs-panel__empty">{summary.excludedCount} declined or duplicate incidents are not counted.</p>
              ) : null}
            </section>
          </div>
        ) : null}
      </PageBody>
    </div>
  );
}

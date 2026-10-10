import { useQuery } from '@apollo/client/react';
import { useNavigate } from 'react-router-dom';

import { INCIDENTS_PAGE_QUERY } from '../board/queries';
import { severityLabel } from '../board/severity';
import type { IncidentsPageQueryData, IncidentsPageQueryVariables, IncidentSummaryData } from '../board/types';
import { readStoredTeamKey } from '../board/utils';
import { formatImpactDuration } from '../components/IncidentTimesPanel';
import { Btn } from '../components/Primitives';

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
  const navigate = useNavigate();
  const teamKey = readStoredTeamKey();
  const { data, error, loading, refetch } = useQuery<IncidentsPageQueryData, IncidentsPageQueryVariables>(INCIDENTS_PAGE_QUERY, {
    variables: teamKey ? { teamFilter: { key: { eq: teamKey } } } : {},
    fetchPolicy: 'cache-and-network',
  });
  const summary = data?.incidentSummary ?? null;
  const counted = summary ? summary.openCount + summary.resolvedCount : 0;

  return (
    <div className="observation-page">
      <div className="page-header">
        <h1 className="page-header__title">Incidents</h1>
        <span className="mono observation-count">{summary?.openCount ?? 0}</span>
      </div>

      <div className="page-content">
        {error ? (
          <div className="empty-state" role="alert">
            <h3>Could not load incident metrics</h3>
            <p>Confirm the API server is running, then retry.</p>
            <Btn variant="subtle" onClick={() => void refetch()}>
              Retry
            </Btn>
          </div>
        ) : loading && !summary ? (
          <p className="observation-empty">Loading incidents...</p>
        ) : summary && counted === 0 ? (
          <div className="empty-state">
            <h3>No incidents</h3>
            <p>
              Declared incidents (Type: Incident) appear here with their MTTR, MTTM and follow-up progress. Declare one from the board with
              Report incident.
            </p>
            {summary.excludedCount > 0 ? <p>{summary.excludedCount} declined or duplicate incidents are not counted.</p> : null}
          </div>
        ) : summary ? (
          <div className="bugs-content">
            <section className="bugs-stats" aria-label="Incident statistics">
              <div className="bugs-stat">
                <span className="bugs-stat__value">{summary.openCount}</span>
                <span className="bugs-stat__label">Ongoing</span>
              </div>
              <div className="bugs-stat">
                <span className="bugs-stat__value">{summary.resolvedCount}</span>
                <span className="bugs-stat__label">Resolved</span>
              </div>
              <div className="bugs-stat" title="Mean time from impact start to mitigation (resolution when mitigation was not recorded)">
                <span className="bugs-stat__value">{formatAverage(summary.mttmHours, summary.mttmSampleCount)}</span>
                <span className="bugs-stat__label">MTTM</span>
              </div>
              <div className="bugs-stat" title="Mean time from impact start to resolution">
                <span className="bugs-stat__value">{formatAverage(summary.mttrHours, summary.mttrSampleCount)}</span>
                <span className="bugs-stat__label">MTTR</span>
              </div>
            </section>

            <section className="bugs-stats" aria-label="Follow-ups">
              <div className="bugs-stat" title="Completed / (total − declined): a declined follow-up is no longer owed">
                <span className="bugs-stat__value">{formatRate(summary.followUps.completionRate)}</span>
                <span className="bugs-stat__label">
                  Follow-ups done ({summary.followUps.completed} of {summary.followUps.total - summary.followUps.declined})
                </span>
              </div>
              <div className="bugs-stat">
                <span className="bugs-stat__value">{summary.followUps.overdueOpen}</span>
                <span className="bugs-stat__label">Overdue, still open</span>
              </div>
              <div className="bugs-stat">
                <span className="bugs-stat__value">{summary.followUps.overdue}</span>
                <span className="bugs-stat__label">Overdue in total</span>
              </div>
              <div className="bugs-stat">
                <span className="bugs-stat__value">{summary.followUps.declined}</span>
                <span className="bugs-stat__label">Declined</span>
              </div>
            </section>

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
                  {summary.incidents.map((item) => (
                    <tr key={item.id} data-testid={`incident-${item.identifier}`}>
                      <td>
                        <button type="button" className="hygiene-item" onClick={() => navigate(`/issue/${encodeURIComponent(item.identifier)}`)}>
                          <span className="mono">{item.identifier}</span>
                          <span className="hygiene-item__title">{item.title}</span>
                        </button>
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
      </div>
    </div>
  );
}

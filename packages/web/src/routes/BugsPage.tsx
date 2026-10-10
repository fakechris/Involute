import { RESOLUTION_OPTIONS } from '../components/CloseReasonDialog';
import { useMemo } from 'react';
import { useQuery } from '@apollo/client/react';
import { Link, useNavigate } from 'react-router-dom';

import { BUGS_PAGE_QUERY } from '../board/queries';
import { severityLabel } from '../board/severity';
import type { BugMetricsData, BugsPageQueryData, BugsPageQueryVariables } from '../board/types';
import { readStoredTeamKey } from '../board/utils';
import { IcoBug } from '../components/Icons';
import { Btn, PriorityIcon } from '../components/Primitives';

const CLOSED_STATE_TYPES = new Set(['COMPLETED', 'CANCELED']);
const BUG_LABEL_NAMES = ['bug', 'Bug', 'BUG'];

function formatAge(days: number | null): string {
  if (days === null) {
    return '—';
  }
  return days < 1 ? '<1' : String(Math.round(days));
}

function formatWeekLabel(weekStart: string): string {
  return weekStart.slice(5);
}

export function BugsPage() {
  const navigate = useNavigate();
  const teamKey = readStoredTeamKey();

  const queryVariables: BugsPageQueryVariables = {
    ...(teamKey ? { teamFilter: { key: { eq: teamKey } } } : {}),
    issueFilter: {
      commitmentStatus: 'COMMITTED',
      labels: { some: { name: { in: BUG_LABEL_NAMES } } },
      ...(teamKey ? { team: { key: { eq: teamKey } } } : {}),
    },
  };

  const { data, error, loading, refetch } = useQuery<BugsPageQueryData, BugsPageQueryVariables>(
    BUGS_PAGE_QUERY,
    {
      variables: queryVariables,
      fetchPolicy: 'cache-and-network',
    },
  );

  const summary = data?.bugSummary ?? null;

  const openBugs = useMemo(() => {
    const nodes = data?.issues.nodes ?? [];
    return nodes
      .filter((issue) => !CLOSED_STATE_TYPES.has(issue.state.type))
      .sort((a, b) => {
        const priorityA = a.priority === 0 ? Number.MAX_SAFE_INTEGER : a.priority;
        const priorityB = b.priority === 0 ? Number.MAX_SAFE_INTEGER : b.priority;
        if (priorityA !== priorityB) {
          return priorityA - priorityB;
        }
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  }, [data?.issues.nodes]);

  const urgentHighOpen =
    summary?.byPriority
      .filter((entry) => entry.priority === 1 || entry.priority === 2)
      .reduce((sum, entry) => sum + entry.count, 0) ?? 0;
  const maxWeekCount = Math.max(1, ...(summary?.createdPerWeek.map((week) => week.count) ?? [1]));

  return (
    <div className="observation-page">
      <div className="page-header">
        <IcoBug size={14} style={{ color: 'var(--fg-dim)' }} />
        <h1 className="page-header__title">Bugs</h1>
        <span className="mono observation-count">{summary?.openCount ?? 0}</span>
        <div style={{ flex: 1 }} />
        <span className="observation-hint">
          Bug reports land directly on the board with the bug label; agents pick them up via
          bug.reported webhooks.
        </span>
      </div>

      <div className="page-content">
        {error ? (
          <div className="empty-state" role="alert">
            <h3>Could not load bug statistics</h3>
            <p>Confirm the API server is running, then retry.</p>
            <Btn variant="subtle" onClick={() => void refetch()}>
              Retry
            </Btn>
          </div>
        ) : loading && !summary ? (
          <p className="observation-empty">Loading bugs...</p>
        ) : summary ? (
          <div className="bugs-content">
            <section className="bugs-stats" aria-label="Bug statistics">
              <div className="bugs-stat">
                <span className="bugs-stat__value">{summary.openCount}</span>
                <span className="bugs-stat__label">Open</span>
              </div>
              <div className="bugs-stat">
                <span className="bugs-stat__value">{summary.unclaimedOpenCount}</span>
                <span className="bugs-stat__label">Unclaimed</span>
              </div>
              <div className="bugs-stat">
                <span className="bugs-stat__value">{urgentHighOpen}</span>
                <span className="bugs-stat__label">Urgent + High open</span>
              </div>
              <div className="bugs-stat">
                <span className="bugs-stat__value">{formatAge(summary.avgOpenAgeDays)}</span>
                <span className="bugs-stat__label">Avg open age (days)</span>
              </div>
            </section>

            {summary.metrics ? <BugTriageMetrics metrics={summary.metrics} onOpen={(id) => navigate(`/issue/${id}`)} /> : null}

            <div className="bugs-grid">
              <section className="bugs-panel" aria-label="Bugs by project">
                <h2 className="bugs-panel__title">By project</h2>
                {summary.byRepository.length === 0 ? (
                  <p className="bugs-panel__empty">No bugs yet.</p>
                ) : (
                  <table className="bugs-table">
                    <thead>
                      <tr>
                        <th>Project</th>
                        <th>Open</th>
                        <th>Closed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.byRepository.map((row) => (
                        <tr key={row.repository ?? '__none__'}>
                          <td className="mono">{row.repository ?? 'No project'}</td>
                          <td>{row.openCount}</td>
                          <td>{row.closedCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <section className="bugs-panel" aria-label="Open bugs by type">
                <h2 className="bugs-panel__title">Open by type</h2>
                {summary.byTypeLabel.length === 0 ? (
                  <p className="bugs-panel__empty">No type labels on open bugs.</p>
                ) : (
                  <table className="bugs-table">
                    <thead>
                      <tr>
                        <th>Label</th>
                        <th>Open</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.byTypeLabel.map((row) => (
                        <tr key={row.label}>
                          <td>{row.label}</td>
                          <td>{row.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <section className="bugs-panel" aria-label="Open bugs by severity">
                <h2 className="bugs-panel__title">Open by severity</h2>
                {(summary.bySeverity ?? []).length === 0 ? (
                  <p className="bugs-panel__empty">No open bugs.</p>
                ) : (
                  <table className="bugs-table">
                    <thead>
                      <tr>
                        <th>Severity</th>
                        <th>Open</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(summary.bySeverity ?? []).map((row) => (
                        <tr key={row.severity ?? '__none__'}>
                          <td>{row.severity ? severityLabel(row.severity) : 'Not judged'}</td>
                          <td>{row.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <section className="bugs-panel" aria-label="Most duplicated open bugs">
                <h2 className="bugs-panel__title">Reported again most</h2>
                {(summary.mostDuplicated ?? []).length === 0 ? (
                  <p className="bugs-panel__empty">No open bug has been reported twice.</p>
                ) : (
                  <table className="bugs-table">
                    <thead>
                      <tr>
                        <th>Bug</th>
                        <th>Duplicates</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(summary.mostDuplicated ?? []).map((bug) => (
                        <tr key={bug.id}>
                          <td>
                            <button type="button" className="hygiene-item" title="Often reported again: consider raising its priority" onClick={() => navigate(`/issue/${bug.id}`)}>
                              <PriorityIcon level={bug.priority} size={12} />
                              <span className="mono">{bug.identifier}</span>
                              <span className="hygiene-item__title">{bug.title}</span>
                            </button>
                          </td>
                          <td className="mono">{bug.duplicateCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </div>

            <section className="bugs-panel" aria-label="Bug creation trend">
              <h2 className="bugs-panel__title">Created per week (last 8 weeks)</h2>
              <div className="bugs-trend">
                {summary.createdPerWeek.map((week) => (
                  <div className="bugs-trend__week" key={week.weekStart}>
                    <span className="bugs-trend__count">{week.count}</span>
                    <div className="bugs-trend__bar-track">
                      <div
                        className="bugs-trend__bar"
                        style={{ height: `${Math.max(week.count > 0 ? 6 : 2, (week.count / maxWeekCount) * 100)}%` }}
                      />
                    </div>
                    <span className="bugs-trend__label">{formatWeekLabel(week.weekStart)}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="bugs-panel" aria-label="Open bugs">
              <h2 className="bugs-panel__title">Open bugs</h2>
              {openBugs.length === 0 ? (
                <p className="bugs-panel__empty">No open bugs. Nice.</p>
              ) : (
                <div className="bugs-list" role="list">
                  {openBugs.map((issue) => (
                    <button
                      type="button"
                      role="listitem"
                      key={issue.id}
                      className="bugs-list__item"
                      onClick={() => navigate(`/?issue=${encodeURIComponent(issue.identifier)}`)}
                    >
                      <PriorityIcon level={issue.priority} size={12} />
                      <span className="mono bugs-list__identifier">{issue.identifier}</span>
                      <span className="bugs-list__title">{issue.title}</span>
                      {issue.severity ? <span className="bugs-list__meta mono" title={severityLabel(issue.severity)}>{issue.severity}</span> : null}
                      <span className="bugs-list__meta">{issue.state.name}</span>
                      <span className="bugs-list__meta mono">{issue.repository ?? 'No project'}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<BugMetricsData['bySource'][number]['source'], string> = {
  HUMAN_REPORT: 'Reported by people',
  AGENT: 'Filed by agents',
  OTHER: 'Other',
};

function formatHours(hours: number | null): string {
  if (hours === null) return '—';
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** Bug route v1 health (INV-751): how fast bugs are triaged and fixed, and where they come from. */
function BugTriageMetrics({ metrics, onOpen }: { metrics: BugMetricsData; onOpen: (id: string) => void }) {
  const slaClosed = metrics.slaMetCount + metrics.slaBreachedClosedCount;
  return (
    <>
      <section className="bugs-stats" aria-label="Triage and SLA">
        <Link className="bugs-stat" to="/candidates?type=bug">
          <span className="bugs-stat__value">{metrics.untriagedCount}</span>
          <span className="bugs-stat__label">Waiting in triage</span>
        </Link>
        <div className="bugs-stat">
          <span className="bugs-stat__value">
            {formatHours(metrics.triageHoursP50)} / {formatHours(metrics.triageHoursP90)}
          </span>
          <span className="bugs-stat__label">Triage time p50 / p90 ({metrics.triagedCount} triaged)</span>
        </div>
        <div className="bugs-stat">
          <span className="bugs-stat__value">{metrics.slaMetRate === null ? '—' : `${Math.round(metrics.slaMetRate * 100)}%`}</span>
          <span className="bugs-stat__label">
            Fixed within SLA ({metrics.slaMetCount} of {slaClosed})
          </span>
        </div>
        <div className={`bugs-stat${metrics.breachedOpen.length ? ' bugs-stat--alert' : ''}`}>
          <span className="bugs-stat__value">
            {metrics.breachedOpen.length} / {metrics.atRiskOpenCount}
          </span>
          <span className="bugs-stat__label">Open past SLA / at risk</span>
        </div>
        <div className={`bugs-stat${metrics.unplacedOpenCount ? ' bugs-stat--alert' : ''}`}>
          <span className="bugs-stat__value">{metrics.unplacedOpenCount}</span>
          <span className="bugs-stat__label">Open bugs with no parent (goal 0)</span>
        </div>
      </section>

      <div className="bugs-grid">
        <section className="bugs-panel" aria-label="Open bugs past their SLA">
          <h2 className="bugs-panel__title">Past their SLA</h2>
          {metrics.breachedOpen.length === 0 ? (
            <p className="bugs-panel__empty">None — every open bug is within its SLA.</p>
          ) : (
            <ul className="bugs-breaches">
              {metrics.breachedOpen.map((bug) => (
                <li key={bug.id}>
                  <button type="button" className="hygiene-item" onClick={() => onOpen(bug.id)}>
                    <span className="mono">{bug.identifier}</span>
                    <span className="hygiene-item__title">{bug.title}</span>
                  </button>
                  <span className="bugs-breaches__overdue">{formatHours(bug.overdueHours)} over</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="bugs-panel" aria-label="Bugs by source">
          <h2 className="bugs-panel__title">Where bugs come from</h2>
          {metrics.bySource.length === 0 ? (
            <p className="bugs-panel__empty">No bugs yet.</p>
          ) : (
            <table className="bugs-table">
              <tbody>
                {metrics.bySource.map((entry) => (
                  <tr key={entry.source}>
                    <td>{SOURCE_LABEL[entry.source]}</td>
                    <td className="mono">{entry.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <BugResolutions metrics={metrics} />
      </div>
    </>
  );
}

const SOURCES: Array<BugMetricsData['bySource'][number]['source']> = ['HUMAN_REPORT', 'AGENT', 'OTHER'];
const FALSE_REPORT: ReadonlySet<string> = new Set(['INVALID', 'CANNOT_REPRODUCE']);

/**
 * Why bugs were closed without a fix, by who reported them (INV-1118). The
 * false-report rate — invalid or cannot reproduce, over all bugs from that
 * source — shows which reporter files noise.
 */
function BugResolutions({ metrics }: { metrics: BugMetricsData }) {
  const rows = metrics.byResolution ?? [];
  const resolutions = RESOLUTION_OPTIONS.filter((option) => rows.some((row) => row.resolution === option.value));
  const count = (resolution: string, source: string) => rows.find((row) => row.resolution === resolution && row.source === source)?.count ?? 0;
  const falseRate = (source: string) => {
    const total = metrics.bySource.find((entry) => entry.source === source)?.count ?? 0;
    if (!total) return '—';
    const noise = rows.filter((row) => row.source === source && FALSE_REPORT.has(row.resolution)).reduce((sum, row) => sum + row.count, 0);
    return `${Math.round((noise / total) * 100)}%`;
  };
  return (
    <section className="bugs-panel" aria-label="Bugs closed without a fix">
      <h2 className="bugs-panel__title">Closed without a fix</h2>
      {resolutions.length === 0 ? (
        <p className="bugs-panel__empty">No bug has been declined or canceled yet.</p>
      ) : (
        <table className="bugs-table">
          <thead>
            <tr>
              <th>Resolution</th>
              {SOURCES.map((source) => <th key={source}>{SOURCE_LABEL[source]}</th>)}
            </tr>
          </thead>
          <tbody>
            {resolutions.map((option) => (
              <tr key={option.value}>
                <td>{option.label}</td>
                {SOURCES.map((source) => <td key={source} className="mono">{count(option.value, source)}</td>)}
              </tr>
            ))}
            <tr>
              <td>False-report rate</td>
              {SOURCES.map((source) => <td key={source} className="mono">{falseRate(source)}</td>)}
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}

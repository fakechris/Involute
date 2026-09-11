import { useMemo } from 'react';
import { useQuery } from '@apollo/client/react';
import { useNavigate } from 'react-router-dom';

import { BUGS_PAGE_QUERY } from '../board/queries';
import type { BugsPageQueryData, BugsPageQueryVariables } from '../board/types';
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

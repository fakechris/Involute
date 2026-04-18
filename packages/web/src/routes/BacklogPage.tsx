import { useMemo } from 'react';

import type { IssueSummary, TeamSummary } from '../board/types';

interface BacklogPageProps {
  issues: IssueSummary[];
  selectedTeam: TeamSummary | null;
  onSelectIssue: (issue: IssueSummary) => void;
}

export function BacklogPage({
  issues,
  selectedTeam,
  onSelectIssue,
}: BacklogPageProps) {
  const sortedIssues = useMemo(
    () =>
      [...issues].sort((left, right) => {
        const identifierComparison = left.identifier.localeCompare(right.identifier, undefined, {
          numeric: true,
        });

        if (identifierComparison !== 0) {
          return identifierComparison;
        }

        return left.title.localeCompare(right.title);
      }),
    [issues],
  );

  return (
    <main className="backlog-page">
      {sortedIssues.length > 0 ? (
        <div className="backlog-surface">
          <table className="backlog-table">
            <thead>
              <tr>
                <th scope="col">Identifier</th>
                <th scope="col">Title</th>
                <th scope="col">State</th>
                <th scope="col">Labels</th>
                <th scope="col">Assignee</th>
              </tr>
            </thead>
            <tbody>
              {sortedIssues.map((issue) => (
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <section className="shell-notice">
          <p>No issues in the backlog for this team yet.</p>
        </section>
      )}
    </main>
  );
}

import type { IssueSummary } from '../board/types';
import { IssueCard } from './IssueCard';

interface ColumnProps {
  title: string;
  issues: IssueSummary[];
}

export function Column({ title, issues }: ColumnProps) {
  return (
    <section className="board-column" aria-label={`${title} column`}>
      <div className="board-column__header">
        <h2>{title}</h2>
        <span className="board-column__count">{issues.length}</span>
      </div>

      <div className="board-column__body">
        {issues.length > 0 ? (
          issues.map((issue) => <IssueCard key={issue.id} issue={issue} />)
        ) : (
          <p className="board-column__empty">No issues in {title} yet.</p>
        )}
      </div>
    </section>
  );
}

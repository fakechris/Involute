import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';

import type { IssueSummary } from '../board/types';
import { IssueCard } from './IssueCard';

interface ColumnProps {
  title: string;
  stateId: string;
  issues: IssueSummary[];
  onSelectIssue?: (issue: IssueSummary) => void;
}

export function Column({ title, stateId, issues, onSelectIssue }: ColumnProps) {
  const { isOver, setNodeRef } = useDroppable({
    id: stateId,
    data: {
      stateId,
      title,
      type: 'column',
    },
  });

  return (
    <section
      className={`board-column${isOver ? ' board-column--active' : ''}`}
      aria-label={`${title} column`}
      data-testid={`board-column-${stateId}`}
      data-state-id={stateId}
    >
      <div className="board-column__header">
        <h2>{title}</h2>
        <span className="board-column__count">{issues.length}</span>
      </div>

      <SortableContext items={issues.map((issue) => issue.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className="board-column__body"
          data-testid={`column-${title}`}
          data-droppable-state-id={stateId}
        >
          {issues.length > 0 ? (
            issues.map((issue) =>
              onSelectIssue ? (
                <IssueCard key={issue.id} issue={issue} onSelect={onSelectIssue} />
              ) : (
                <IssueCard key={issue.id} issue={issue} />
              ),
            )
          ) : (
            <p className="board-column__empty">No issues in {title} yet.</p>
          )}
        </div>
      </SortableContext>
    </section>
  );
}
